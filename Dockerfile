# syntax=docker/dockerfile:1
#
# fuckds —— DeepSeek 网页版转 OpenAI / Anthropic 兼容 API
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 生产依赖（只有 playwright）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# 浏览器装到固定路径，运行时用 PLAYWRIGHT_BROWSERS_PATH 指过去。
# 只装 headless shell：体积比完整 chromium 小一半，而本服务始终 headless 运行。
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
RUN npx playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

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
RUN mkdir -p /app/data && chown -R node:node /app

# 用非 root 跑：容器里跑浏览器 + 处理外部输入，没必要给 root
USER node

# 容器里必须监听 0.0.0.0，否则端口映射不出去
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    LOG_LEVEL=info \
    NODE_ENV=production

# 默认用 direct 引擎：镜像里已经编好了 Go 求解器，它比 browser 快得多，
# 也不吃内存（不需要常驻 Chromium）。想用浏览器引擎就设 ENGINE=browser。
ENV ENGINE=direct

EXPOSE 8787

# tini 负责回收僵尸进程：Playwright 会拉起一堆 Chromium 子进程，
# 没有 init 的话 1 号进程（node）不回收它们，跑久了会堆一片 <defunct>。
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "src/index.mjs"]

# 健康检查直接用自带的 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
