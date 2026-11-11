# 开发者文档索引

面向改代码的人。用户教程见仓库根目录的 [README](../README.md)。

| 文档 | 内容 |
|---|---|
| [开发文档](./DEVELOPMENT.md) | 架构、模块职责、请求全链路、引擎契约、**并发模型**、上游协议、Prompt/工具调用、**安全加固**、错误与重试、测试、**Docker 镜像与 CI**、调试、技术债 |
| [优化说明](../OPTIMIZATION.md) | 相对原包的两轮优化记录（体积/安全/去重/热路径/提示词），附实测数字 |
| [环境变量样例](../.env.example) | 全部配置项与默认值 |
| [Dockerfile](../Dockerfile) · [.dockerignore](../.dockerignore) · [workflow](../.github/workflows/docker.yml) | 交付形态的定义文件 |

> `OPTIMIZATION.md` 是**历史优化记录**，记录"当时为什么这么改、实测是多少"；
> 它是按轮次追加的，可能滞后于当前代码。**以 [开发文档](./DEVELOPMENT.md) 为准**，
> 尤其是 §10.2（流式热路径）、§16.8（优化性能）、§16.9（首字延迟）三处。

## 3 分钟上手

```bash
npm install            # 只有 playwright 一个依赖
npm run setup:browser  # 下载 Playwright 的 Chromium（browser 引擎与浏览器测试需要）
npm run pow:build      # 编译 Go PoW 求解器 → bin/ds-pow（Windows 上是 bin/ds-pow.exe）
npm run auth -- '<userToken>'
npm start              # 前台跑；或用 npm run up 后台跑
npm test               # 286 个用例（267 + 19 浏览器）；没有 Chromium 时浏览器用例会自动 skip
npm run exe            # 打包成 Windows 单 exe → dist/win-x64/（目标机器零安装）
docker build -t cz-dsapi .   # 构建镜像（需要本地有 docker）
```

前端控制台需要单独构建一次：`npm run admin:install && npm run admin:build`，然后访问 `/admin`。
（Docker 构建会自动完成这两步，不需要在宿主机上跑。）

> **第一次启动不需要配 token**：控制台会自动探测 `hasToken` 并跳到「账号」页引导粘贴。
> 服务在未配置状态下照常监听，只有真正发对话请求时才返回 400。见
> [§14.7 首次配置](./DEVELOPMENT.md#首次运行的登录态控制台引导不需要碰配置文件)。

## 改代码前必读

1. [项目级不变量](./DEVELOPMENT.md#1-项目定位与不变量) —— 8 条设计约束，踩了会直接产生线上故障；
2. [引擎契约](./DEVELOPMENT.md#61-引擎契约) —— 两个引擎的鸭子类型接口与可选能力降级；
3. [并发模型](./DEVELOPMENT.md#65-并发模型两条流水线) —— 两个引擎的并发语义**完全不同**，加并发前必看；
4. [已知问题与技术债](./DEVELOPMENT.md#15-已知问题与技术债) —— T1/T2/T3/T9/T12/T13 已修复，当前测试全绿；剩下的是结构性债务。

## 加功能时的两条硬约束

| 你要做的事 | 必须遵守 |
|---|---|
| 让外部内容进入 prompt | 过 [`escapeSectionMarkers()`](./DEVELOPMENT.md#段落注入防护sandboxmjs)，见 [§16.6](./DEVELOPMENT.md#166-加一个外部内容进入-prompt的通路) |
| 让服务端请求外部地址 | 用 [`fetchRemoteSafely()`](./DEVELOPMENT.md#56-图片下载与-ssrf-防护srcnet-guardmjs)，**不要裸 `fetch`**，见 [§16.7](./DEVELOPMENT.md#167-加一个服务端去请求外部地址的功能) |

## 分发

| 方式 | 命令 | 目标机器需要 | 适合 |
|---|---|---|---|
| 源码包 | `npm run package` | Node 20+ / Go / Chromium | 开发、调试 |
| Windows exe | `npm run exe` | **什么都不用装**（解压即用） | 不懂技术的 Windows 用户 |
| Docker 镜像 | CI 自动推 `ghcr.io/xgp2012/cz-dsapi` | 只要 Docker | 服务器 / NAS |
| Docker Compose | [docker-compose.yml](../docker-compose.yml) + [.env.compose.example](../.env.compose.example) | 只要 Docker Compose | **推荐给服务器**：带日志轮转、优雅关闭、健康检查 |

Compose 版已经把容器专属的注意事项预置好了，其中两个是「不设就会出问题」的：

- `stop_grace_period: 15s` 必须**大于** `SHUTDOWN_TIMEOUT_MS`（8s），
  否则 `docker compose down` 会在优雅关闭完成前 SIGKILL，Chromium 子进程变孤儿；
- `API_KEY` 用 `${CZ_API_KEY:?}` 写成**必填**：容器默认监听 `0.0.0.0`，
  漏设就等于把号池额度白送出去。没填时 compose 会直接报错拒绝启动，而不是静默跑起来。

配置全部走 `environment:`，因为镜像里 `/app` 只读、`.env` 写不进去（见 [§14.8](./DEVELOPMENT.md#148-docker-镜像dockerfile)）。

exe 产物里 `src/`、`node_modules/`、`ms-playwright/` 必须和 `cz-dsapi.exe` 同目录 ——
SEA 内嵌代码只能按 CommonJS 执行，装不下 ESM 源码。原因与两个 playwright 坑见
[§14.7 打包成 Windows 单 exe](./DEVELOPMENT.md#147-打包成-windows-单-exescriptsbuild-exemjs)。

镜像侧三个最容易踩的点（详见 [§14.8](./DEVELOPMENT.md#148-docker-镜像dockerfile)）：

- `web/dist` 和 `bin/ds-pow` **只能从 builder 阶段拷**，它们在 `.gitignore` 里，CI 上不存在；
- `chown -R /app` 会因镜像层增量快照把整个 Chromium 复制一遍（实测 +109MB），只 chown `data/`；
- Dockerfile 的 `\` 续行遇到 CRLF 会断，靠 [`.gitattributes`](../.gitattributes) 强制 LF。

CI 细节（缓存、标签规则、如何在没有本地 Docker 时验证）见
[§14.9](./DEVELOPMENT.md#149-cigithub-actions-构建镜像githubworkflowsdockeryml)。

## 定位问题的三个入口

| 症状 | 先看 |
|---|---|
| 网页改版 / DOM 读不到 / 提前结束 | [16.1 网页改版了](./DEVELOPMENT.md#161-网页改版了browser-引擎挂了) |
| 接口字段变了 / 上流报错 | [16.2 直连接口改版了](./DEVELOPMENT.md#162-直连接口改版了) |
| 空回答 / 工具调用丢失 / 流被截断 | [10. 输出治理](./DEVELOPMENT.md#10-输出治理清洗补尾去伪造)、[17.1 日志](./DEVELOPMENT.md#171-日志) |
| 429 / 被限流 / 被陌生人调用 | [5.5 入口限流](./DEVELOPMENT.md#55-入口限流srcrate-limitmjs)、[17.1 日志](./DEVELOPMENT.md#171-日志) |
| 长回答越跑越慢 | [10.2 流式过滤器性能](./DEVELOPMENT.md#性能这里曾经是-on改动前务必看懂) |
| 并发上不去 / 全都压在一个号上 | [6.5 并发模型](./DEVELOPMENT.md#65-并发模型两条流水线) |
| 镜像构建失败 / 体积异常 / 拉不到镜像 | [14.8 Docker 镜像](./DEVELOPMENT.md#148-docker-镜像dockerfile)、[14.9 CI](./DEVELOPMENT.md#149-cigithub-actions-构建镜像githubworkflowsdockeryml) |
| exe 起不来 / 重启失败 | [14.7 打包成 Windows 单 exe](./DEVELOPMENT.md#147-打包成-windows-单-exescriptsbuild-exemjs) |

> 本文档基于仓库当前源码逐文件核对编写；文中引用的方法名、常量值与分支条件均对应实际实现。改动相关代码时请顺手同步对应章节。
