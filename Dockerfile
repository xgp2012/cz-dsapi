# syntax=docker/dockerfile:1
#
# cz-dsapi —— DeepSeek 网页版转 OpenAI / Anthropic 兼容 API
#
# 三阶段构建，目的是让最终镜像**小且能真正跑浏览器**：
#   1. web      : 编译 React 控制台（需要 devDependencies，不进最终镜像）
#   2. pow      : 交叉编译 Go 版 PoW 求解器（静态二进制，不需要 Go 运行时）
#   3. runtime  : 只带 src/ + 生产依赖 + Chromium

# ---------------------------------------------------------------- 1. 控制台
FROM node:22-bookworm-slim AS web

WORKDIR /app/web

# 先只拷 manifest：改代码时不会让这层缓存失效
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build


# ---------------------------------------------------------------- 2. PoW 求解器
FROM golang:1.23-bookworm AS pow

WORKDIR /src

COPY go.mod ./
COPY *.go ./
COPY cmd/ ./cmd/

# CGO_ENABLED=0 是必须的：产物要能在 slim 镜像里直接跑，不能依赖 glibc 动态链接。
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/ds-pow ./cmd/powd


# ---------------------------------------------------------------- 3. 运行时
FROM node:22-bookworm-slim AS runtime

# Playwright 跑 Chromium 需要的系统库。
# --no-install-recommends 很关键：不装的话这一层会多出 200MB+ 的无用包。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      tini \
      tzdata \
    && rm -rf /var/lib/apt/lists/*

# 时区：容器默认 UTC，日志时间是 UTC 会让「对账上游限流窗口」产生 8 小时错觉。
# tzdata 必须装上，否则 TZ 只是个没人认的字符串。
# 运行时可用 -e TZ=UTC 覆盖。
ENV TZ=Asia/Shanghai

WORKDIR /app

# 生产依赖（只有 playwright）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# 浏览器装到固定路径，运行时用 PLAYWRIGHT_BROWSERS_PATH 指过去。
# 只装 headless shell：体积比完整 chromium 小一半，而本服务始终 headless 运行。
#
# 这里**不带 --with-deps**：上面已经用 apt 装好了全部运行库，
# --with-deps 会再跑一遍 apt 并多产生一层（实测多 1.6MB 且让层数变多）。
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
RUN npx playwright install chromium-headless-shell

# 程序本体
COPY src/ ./src/
COPY .env.example ./

# 控制台静态文件来自 web builder 阶段。
# 不从上下文拷 web/dist：它是 .gitignore 的，CI 上根本不存在。
COPY --from=web /app/web/dist/ ./web/dist/

# PoW 求解器只来自 builder 阶段：仓库里的 bin/ 是 .gitignore 的（而且只有 Windows 的 .exe），
# 不能从构建上下文拷，否则 CI 上会直接失败。
COPY --from=pow /out/ds-pow ./bin/ds-pow
RUN chmod +x ./bin/ds-pow

# 数据目录：auth.json（号池）和日志落在这里，挂卷持久化
#
# 只 chown 数据目录，**不要** chown -R /app：
# 那会把刚装好的 Chromium（约 210MB）整份复制到新的一层，镜像白胖 109MB（实测）。
# /app 下其余文件都是 root 拥有但只读，进程以 node 身份运行时不需要写权限。
#
# 顺便建好 browser 引擎要用的子目录（artifacts 截图、font-cache）：
# 它们由进程运行期 mkdir，但挂载卷之后卷根上的权限来自宿主机，
# 事先建好并 chown 能避免第一次截图就 EACCES。
RUN mkdir -p /app/data/artifacts /app/data/font-cache \
    && chown -R node:node /app/data

# 用非 root 跑：容器里跑浏览器 + 处理外部输入，没必要给 root
USER node

# 容器里必须监听 0.0.0.0，否则端口映射不出去
#
# 几个容器专属的说明：
#   - NODE_ENV=production：关掉开发期行为
#   - 不设 NO_COLOR：日志已按 process.stdout.isTTY 自动关色，
#     docker logs 本来就不带 TTY，不需要额外干预
#   - 不设 NODE_OPTIONS=--enable-source-maps：本项目是纯 ESM 源码直跑，
#     没有构建产物，栈本来就指回源码行号，设了是多余的
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    LOG_LEVEL=info \
    NODE_ENV=production

# 默认用 direct 引擎：镜像里已经编好了 Go 求解器，它比 browser 快得多，
# 也不吃内存（不需要常驻 Chromium）。想用浏览器引擎就设 ENGINE=browser。
ENV ENGINE=direct

# 告诉程序"我在容器里"。
#
# 控制台的「重启」按钮靠这个走对路径：容器里绝不能交给 scripts/server-ctl.mjs
# （它 down 掉的是 1 号进程，容器当场退出；而且 slim 镜像没有 pgrep/ps）。
# 设了它就是自重启：spawn 一个新的 node src/index.mjs，再优雅退出旧进程。
#
# 程序本身也会检查 /.dockerenv，这里显式设置是为了兜住非标准运行时
# （podman / k8s 某些配置 / rootless 容器不一定有这个文件）。
ENV CZDSAPI_DOCKER=1

EXPOSE 8787

# tini 负责回收僵尸进程：Playwright 会拉起一堆 Chromium 子进程，
# 没有 init 的话 1 号进程（node）不回收它们，跑久了会堆一片 <defunct>。
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "src/index.mjs"]

# 健康检查直接用自带的 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
