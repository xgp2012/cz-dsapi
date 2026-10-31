# fuckds

[**官方tg频道**](https://t.me/xinglingdefuckds)

把 **chat.deepseek.com 网页版** 包装成 **OpenAI / Anthropic 双协议兼容 API**。

**⚠️严重警告，请勿在deepseek harness中使用，模型会不遵守约定输出明显的DSML原生工具调用token 极易导致账号被封禁！**

**与其他项目不同，因为没有明显的工具调用特征，实测按照提示使用此项目个人使用无封号/禁言问题**

## tips

如果你的IP不是中国大陆，就可以使用邮箱注册DeepSeek账号，且支持变体，比如your+1@gmail.com这种写法都能成功注册账号

我们在取多账号token的时候不要直接点击“退出账号” 因为这样会直接吊销之前的userToken，正确做法是直接清除localStorage和cookies（其实只清localStorage也可以但可能在登录新账号时会出现设备异常等无法登录情况，所以建议cookies也一起清掉）

上下文不打在服务端：每条请求都把历史按 `SYSTEM_ROLE_MESSAGES` / ` USER_ROLE_MESSAGES` / `ASSISTANT_ROLE_MESSAGES` 的段落格式拼成一条 prompt，作为一次**全新对话**发给模型。

两种引擎，默认 **direct**（Playwright 驱动真实网页）：

| 引擎 | 原理 | 单轮耗时 | 依赖 |
| --- | --- | --- | --- |
| browser | Playwright 填输入框，DOM 流式展示 + 抓页面原始补全流 | ~2.2–2.9s | Chromium + 依赖库 |
| **direct**（默认，更快） | 直接调网页内部接口 + Go 解 PoW | **~1.2–1.9s** | `bin/ds-pow`（Go 编译） |

```
┌──────────────┐  OpenAI HTTP  ┌──────────────┐  HTTPS + PoW   ┌───────────────────┐
│ OpenAI 客户端 │ ────────────▶ │  本服务      │ ─────────────▶ │ chat.deepseek.com │
│ (SDK/curl)   │ ◀──────────── │ prompt 拼接  │ ◀───────────── │ /api/v0/chat/...  │
└──────────────┘   SSE 流式    └──────────────┘   SSE patch    └───────────────────┘
                                     │ Playwright + Chromium（browser）
```

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions` 非流式 + SSE 流式；增量与最终文本逐字符一致
- **Anthropic 兼容**：`POST /v1/messages`（流式 / 非流式 / tools / thinking 块）+ `count_tokens`，Claude SDK 直接指过来就能用
- 上下文无状态，每个请求都是一次全新对话
- `tools` → `tool_calls` / `tool_use`：模型按 **`DO:{"name":...,"args":...}`** 单行格式输出（见下文）；**browser 引擎会抓页面原始补全流兜底，保证工具调用 token 不丢**。模型偶尔退回原生 DSML / `<tool_call>` 时会被静默救回，既不漏给客户端，也不写进历史
- **防止模型自造工具结果**：`RESULT` 单独成段 + 多写法识别 + 出口清洗 + 非流式重试（见下文）
- **超长上下文自动转附件**：超过 10 万字时把较早的对话塞进 `.txt` 附件，用 `ref_file_ids` 注入（见下文）
- **图片输入**：`image_url`（data URL 或 http 链接）→ 自动传成网页附件 → `ref_file_ids`
- 「深度思考」默认打开，思考内容走 `reasoning_content`，且**一定排在正文之前**
- 登录态用 `userToken` 注入；直连模式不需要浏览器
- 账号级限流保护：发送间隔 + 冷却重试
- 无 root 环境（Android 容器）有现成的 Chromium 依赖解包脚本

---

## 快速开始

要求：Node.js ≥ 20.11 go ≧ 1.21。

```bash
npm install
安装 Go
sudo apt install golang
npm run pow:build
```
### 1. 拿 userToken

1. 浏览器打开 <https://chat.deepseek.com> 并登录
2. `F12` → **Application** → **Local Storage** → `https://chat.deepseek.com`
3. 键 `userToken`，值是 `{"value":"xxxxx","__version":"0"}`，复制 `value`

**或者**

直接在控制台敲：
```javascript
copy(JSON.parse(localStorage.getItem("userToken").value))
```

```bash
npm run auth -- '<粘贴的 userToken>'
# ✅ 登录态有效，可以正常对话
```

token 存在 `data/auth.json`（0600，已 gitignore）。

### 2. 启动

```bash
npm run up        # 后台启动（detach，日志 data/server.log，pid data/server.pid）
npm run status    # 看状态 / 引擎 / PoW 是否就绪
npm run down      # 停止
```

前台跑用 `npm start`。

> **如果用 pm2 托管**（`pm2 list` 里能看到 `index`），重启请用 `pm2 restart index`：
> `npm run down` 杀掉进程后会被 pm2 立刻拉起，`npm run up` 则会发现端口已被占用。
> 改完代码后确认进程启动时间晚于文件 mtime，或直接 `pm2 restart index`。

### 3. 调用

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "stream": true,
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手"},
      {"role": "user", "content": "用一句话解释什么是 QUIC"}
    ]
  }'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")
stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "用一句话解释 QUIC"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

带图片的请求（支持 `data:` URL 和 http 链接，单张 ≤10MB、最多 8 张）：

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图是什么颜色？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0..."}}
      ]
    }]
  }'
# → 红色
```

### 4. Anthropic（Claude）客户端调用

服务同时实现了 Anthropic Messages API，官方 SDK 直接改 `base_url` 就能用：

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key="any")
msg = client.messages.create(
    model="deepseek-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "用一句话解释什么是 QUIC"}],
)
print(msg.content[0].text)
```

```bash
# 非流式
curl -s http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "system": "你是一个简洁的助手",
    "messages": [{"role": "user", "content": "用一句话解释 QUIC"}]
  }'

# 流式 + 工具
curl -N http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "stream": true,
    "tools": [{"name": "exec_shell", "description": "Exec shell command",
               "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
    "messages": [{"role": "user", "content": "内核是什么版本"}]
  }'

# token 估算
curl -s http://127.0.0.1:8787/v1/messages/count_tokens \
  -H "Content-Type: application/json" -H "x-api-key: any" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}]}'
```

协议映射关系：

| Anthropic | 本服务内部 | 说明 |
| --- | --- | --- |
| `system`（顶层，字符串 / text 块数组） | `## SYSTEM_ROLE_MESSAGES` | 多条 text 块按换行合并 |
| `content` 里的 `text` 块 | 正文 | |
| `content` 里的 `image` 块（base64 / url） | `image_url` → 网页附件 | 单张 ≤10MB，最多 8 张 |
| `assistant` 的 `tool_use` 块 | DO 调用行 | `input` 对象原样写进 `args` |
| `user` 里的 `tool_result` 块 | `## TOOL_RESULT_MESSAGES` | 独立成段，不会并进 assistant |
| `tools[].input_schema` | `function.parameters` | |
| `thinking: {type:"enabled"}` | 网页「深度思考」 | |
| 响应 `stop_reason` | `tool_use` / `end_turn` | |
| 响应 `thinking` 块 | 网页思考内容 | 流式是 `thinking_delta` |

鉴权同时认 `x-api-key: <key>` 和 `Authorization: Bearer <key>`；错误体是 Anthropic 格式
`{"type":"error","error":{"type","message"}}`。`temperature` / `max_tokens` / `tool_choice`
等字段接受但忽略（网页版调不了采样参数）。

端到端自检（会真的访问 DeepSeek）：

```bash
npm run smoke
```

---

## 直连协议（direct 引擎）

```
POST /api/v0/chat_session/create      → 每次请求新建一个会话
POST /api/v0/chat/create_pow_challenge → 拿 PoW 挑战
POST /api/v0/chat/completion          → SSE 流式补全
```

- **PoW 一次性**：解出来的 header 只能用一次，所以每次用掉后立刻在后台解下一个；会话也提前建好
- 请求头带 `authorization`、`x-client-*`、`x-device-id`、`x-ds-pow-response`
- 响应是 JSON 补丁流：`{"v":{...}}` 快照、`{"p":"response/fragments","o":"APPEND","v":[...]}` 新片段、`{"v":"字"}` 追加到当前片段、`{"p":"response/status","v":"FINISHED"}` 结束

### PoW：DeepSeekHashV1

`DeepSeekHashV1` = SHA3-256，但 **Keccak-f[1600] 跳过 round 0**（只做 rounds 1..23）。其余参数不变：`rate=136`、padding `0x06 + 0x80`、输出 32 字节。

```
prefix = salt + "_" + str(expire_at) + "_"
input  = (prefix + str(nonce)).encode("utf-8")
hash   = DeepSeekHashV1(input)                 → 32 bytes
header = base64(json({algorithm, challenge, salt, answer, signature, target_path}))
```

服务端在 `[0, difficulty)`（常见 144000）里选了一个 answer，客户端遍历找到它。Go 实现在 `[0, difficulty)` 上约 **20–30ms**：

```bash
go test ./... && go test -bench=. -benchmem
```

相关文件：

| 文件 | 内容 |
| --- | --- |
| `deepseek_hash.go` | `DeepSeekHashV1` / `keccakF23` |
| `deepseek_pow.go` | `SolvePow`、`BuildPowHeader`、`SolveAndBuildHeader` |
| `cmd/powd/main.go` | 常驻求解器，stdin/stdout JSON 协议 |
| `src/direct/pow.mjs` | Node 侧进程封装 |

---

## 号池（多账号轮询）

限流是按「窗口内消息条数」算的，跟发送间隔无关，所以靠放慢没用。正确做法是准备多个账号：

```bash
npm run auth -- '<token1>' '<token2>' '<token3>'
npm run auth -- --list      # 查看号池（token 打码）
```

行为：

- 请求按轮询分配账号，每个账号有自己的 PoW 缓存、会话池、设备 ID
- 某个账号命中 `rate_limit_reached` → 标记冷却（`ACCOUNT_COOLDOWN_MS`，默认 60s）→ **立刻换下一个账号重试**，不等待
- 池里全都冷却中：等待不超过 `MAX_COOLDOWN_WAIT_MS`（默认 5s），超过就返回 `429` + `Retry-After`
- `GET /healthz` 里能看到每个账号的可用状态、剩余冷却、请求数

> 直连不再做发送间隔（`DIRECT_SEND_INTERVAL_MS=0`）：既然限流是额度不是速率，放慢只会白白变慢。

**工具结果单独成段**（`## TOOL_RESULT_MESSAGES:`），不会并进 `ASSISTANT_ROLE_MESSAGES`。
这是关键：模型是照着自己段落里的写法往后接的，只要 `RESULT` 从不以「assistant 说过的话」的形式出现，
它就没有可模仿的样板。最后一段是工具结果时，段尾还会补一句「直接回答」把话头收回来。

## 工具调用

模型按单行 DO 格式输出工具调用，解析后转成标准 `tool_calls` / `tool_use`，
并从 `content` / SSE 增量里剔除：

```
DO:{"name":"exec_shell","args":{"command":"uname -a","timeout":30}}
```

- `DO` 行首（大小写不敏感）+ 半角 / 全角冒号都认；JSON 可以跨行（pretty print）、可以包在代码块里、行尾带正文也能解析；
- 参数放在 `args`（也兼容 `arguments`）；字符串 / 数字 / 布尔 / 数组 / 对象按 JSON 原样写；
- `content` 里不会残留协议行；模型把刚执行过的调用又复述一遍时，会被判重丢弃（不同格式的等价参数也算重复）。

**DSML 已废弃**：提示词和历史里都不再教 / 不再出现 DSML，只需要 DO。模型万一还是原生吐出
DSML / `<tool_call>`，服务端会把它救回来（见下一节），但绝不会写进历史。

### 工具调用 token 保护（browser 模式）

网页版模型偶尔会「不听话」：DO 块出现在最后一行、DOM 渲染延迟、轮询提前判定结束，
都可能让工具调用 token 在半路丢掉。browser 引擎为此做了三层保护：

1. **原始流优先**：页面自己发出的 `POST /api/v0/chat/completion` SSE 由 Playwright 截获
   （`page.on('response')`），用 patch 解析器还原成模型原始输出；`tool_calls` 从原始文本解析，
   DOM 只负责流式展示 —— DOM 提前结束 / 文本回退 / 渲染丢字符都不影响最终结果。
2. **DOM 永不缩水**：轮询期间记录「按前缀增长的最长文本」，结束快照变短会重试并取最长，
   避免末尾的 DO 块被覆盖。
3. **原生格式静默救回**：真收到 DSML / `<tool_call>` 时仍解析成 `tool_calls`（日志记 warn），
   但绝不回写历史、也不出现在 `content` 里。

`BROWSER_CAPTURE=false` 可关掉第 1 层（退回纯 DOM 提取，不推荐）。

### 模型自造工具结果（RESULT）

网页版模型有个坏习惯：看到 `RESULT` 就自己往后编一段「执行结果」，再把答案建立在这段假结果上。
这里做了四层处理：

1. **协议上隔离**：`RESULT` 只出现在 `## TOOL_RESULT_MESSAGES:` 段，system 段明确写「你绝对不能输出 RESULT」；
2. **识别放宽**：不只认行首 `RESULT:`，`**RESULT:**`、`RESULT：`（全角冒号）、`result:`（小写）、
   `- RESULT:`、`` ``` `` 代码块里的、以及行内 `结果：RESULT:{...}` 都会被识别；
3. **出口清洗**：命中的内容从 `content` 和 SSE 增量里剔除，顺带清掉只剩空壳的代码块；
4. **非流式重试**：只出现 RESULT 却没真的发起调用时，带上更硬的约束重跑一次（`RETRY_ON_FABRICATION=false` 可关）。

流式请求已经吐出去的内容没法回滚，所以只做清洗、不重试。服务日志里搜「自造的工具结果」可以看到命中次数。

### 超长上下文：附件注入

网页输入框单次最多 **10 万字**，超了接口直接报错（`context_length_exceeded`）。但聊天接口的
`ref_file_ids` 可以挂附件，附件不占输入框长度，所以拼接后的 prompt 超限时会自动拆一次：

```
正文（≤ MAX_PROMPT_CHARS）：     附件（.txt）：
# MESSAGES:                      # 对话历史（较早部分）
## SYSTEM_ROLE_MESSAGES          ## USER_ROLE_MESSAGES:
  …特殊 token 声明…                （较早的对话）
## TOOL_FUNCTIONS:               ## ASSISTANT_ROLE_MESSAGES:
  …工具声明…                       …
## CONTEXT_ATTACHMENT:
  较早的 12 段对话已作为附件
  context-53772c8f.txt 上传…
## USER_ROLE_MESSAGES:
  （最近的段落，直到最后一问）
```

规则：

- 只切在 `## USER_ROLE_MESSAGES` / `## ASSISTANT_ROLE_MESSAGES` / `## TOOL_RESULT_MESSAGES` 段落边界，不切碎单条消息；
- **保留最新的段落**（要回答的问题在最后），较早的进附件；system 段和工具声明永远留在正文；
- 最后一段自己就超长（比如读了一个大文件）时，保留它的尾部，前面部分进附件；
- 附件按内容 hash 缓存 30 分钟，同样内容不会重复上传；上传一次约多 0.3~1s；
- 正文里会带一段 `## CONTEXT_ATTACHMENT:` 说明，要求模型先读附件再回答。

实测 12 万字上下文：正文 98,756 字 + 附件 25,572 字，整轮 3.8s，模型能正确引用附件里的内容。

`OVERFLOW_TO_ATTACHMENT=false` 可恢复旧行为（超限直接 413）。浏览器引擎不支持附件，只能直连。

---

## API

| 接口 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | 聊天补全，支持 `stream` / `tools` / `stream_options.include_usage` |
| `POST /v1/completions` | OpenAI | 旧版补全 |
| `POST /v1/messages` | Anthropic | Messages API，支持 `stream` / `tools` / `thinking` |
| `POST /v1/messages/count_tokens` | Anthropic | token 估算（返回 `input_tokens`） |
| `GET /v1/models` | 通用 | 模型列表 |
| `GET /healthz` | 通用 | 健康检查，返回引擎 / PoW / 会话状态 |
| `GET /` | 通用 | 说明页 |

思考开关：默认开（`DEEPSEEK_THINKING=always`），请求体传 `"thinking": false` 可单次关闭；`auto` 按模型名，`never` 全关。

| 字段 | 行为 |
| --- | --- |
| 图片 `image_url` | ✅ 直连引擎支持（data URL / http） |
| `stream` | ✅ 真流式 |
| `stream_options.include_usage` | ✅ 末尾 usage（按字符估算） |
| `tools` / `tool_calls` | ✅ |
| `reasoning_content` | ✅ 先于 `content` 输出 |
| `temperature` / `top_p` / `max_tokens` / `stop` | ⚠️ 接受但忽略 |
| 图片 / 音频输入 | ❌ 返回 400 |

---

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENGINE` | `direct` | `browser`/ `direct`（需 ds-pow，更快）/ `auto`（有 ds-pow 就直连） |
| `POW_BIN` | `bin/ds-pow` | Go PoW 求解器路径 |
| `DEEPSEEK_USER_TOKEN` | – | 登录态，推荐 `npm run auth` 写文件 |
| `DEEPSEEK_THINKING` | `always` | `always` / `auto` / `never` |
| `DEEPSEEK_SEARCH` | `false` | 是否开「智能搜索」 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `API_KEY` | 空 | 设置后要求 `Authorization: Bearer <key>` |
| `CONCURRENCY` | `1` | 并发请求数 |
| `SEND_INTERVAL_MS` | `4000` | 两次发送的最小间隔 |
| `RATE_LIMIT_BACKOFF_MS` | `4000` | 命中限流后的冷却（按次数递增） |
| `REQUEST_TIMEOUT_MS` | `240000` | 单次请求超时 |
| `POLL_INTERVAL_MS` | `60` | 浏览器引擎的 DOM 轮询间隔 |
| `SETTLE_MS` | `800` | 浏览器引擎判定生成结束 |
| `REASONING_HOLD_MS` | `900` | 首段正文最多等思考多久 |
| `WARMUP` | `true` | 启动时预热（browser：Chromium；direct：PoW+会话） |
| `BROWSER_CAPTURE` | `true` | browser 引擎抓页面原始补全流，保证工具调用 token 不丢 |
| `BROWSER_CAPTURE_WAIT_MS` | `20000` | DOM 判定结束后，最多再等原始流收尾多久（补尾部 token） |
| `RETRY_ON_FABRICATION` | `true` | 模型自造 RESULT 时，非流式请求重试一次 |
| `MAX_PROMPT_CHARS` | `100000` | 单次输入框上限；超过就拆附件 |
| `MAX_ATTACHMENT_CHARS` | `2000000` | 拆到附件的上下文上限（字符） |
| `OVERFLOW_TO_ATTACHMENT` | `true` | 超长时转附件；`false` 则超限直接 413 |
| `IDLE_SHUTDOWN_MS` | `900000` | 浏览器引擎空闲回收 |

完整列表见 [.env.example](.env.example)。

---

## 目录结构

```
src/
├── engine.mjs            # direct / browser 选择
├── index.mjs             # 启动入口
├── server.mjs            # HTTP 路由 + 两个协议的响应编排
├── chat-runner.mjs       # 协议无关的执行逻辑（防自造结果 / 超长转附件）
├── direct/               # 直连引擎
│   ├── client.mjs        # 会话 / PoW / 补全
│   ├── pow.mjs           # Go 求解器封装
│   └── stream.mjs        # SSE patch 解析
├── browser/              # Playwright 引擎：DOM 流式 + 原始补全流截获
├── prompt/               # prompt 拼接 / 超长转附件 / DO 工具协议（原生格式兜底解析）
├── anthropic/            # Anthropic Messages API（请求归一化 / 块与事件 / SSE）
└── openai/               # OpenAI 协议 / SSE / 工具文本过滤
cmd/powd/main.go          # Go PoW 求解器
deepseek_hash.go          # DeepSeekHashV1
deepseek_pow.go           # SolvePow / header 组装
```

## 测试

```bash
npm test        # 全部用例（浏览器相关的在没装 Chromium 时自动跳过）
npm run smoke   # 真实接口：非流式 / 流式 / 多轮 / 工具
```

## 常见问题

**为什么慢 / 怎么更快**
browser 引擎单轮 2.2–2.9s（浏览器导航 + DOM 轮询）；直连引擎单轮 1.2–1.9s，其中 1s 左右是「深度思考」。关掉思考（`"thinking": false`）能再省 0.5–1s。客户端显示的 tok/s 会把首字延迟算进分母，工具调用还是两轮往返，所以看起来偏低。

**多轮工具调用为什么慢 / 返回 429**
每次工具调用 = 一条消息 = 一次完整请求（建会话 + PoW + 补全）。账号有短时的消息预算，连着发几轮就会命中 `消息发送过于频繁`（接口用 `event: hint` 里的 `rate_limit_reached` 返回）。

现在的处理：

- browser 每轮间隔 `SEND_INTERVAL_MS`（4000ms）；直连默认 `DIRECT_SEND_INTERVAL_MS=0`
- 命中限流（接口用 `event: hint` 的 `rate_limit_reached`，或者干脆只回一个空事件）→ 冷却 `RATE_LIMIT_BACKOFF_MS` 重试一次
- 仍失败返回 `429`，带 `Retry-After: 60`，错误码 `deepseek_rate_limited`

实测这个窗口大概一分钟：连续 3~4 条消息后会被挡，静置一分钟左右恢复。这是账号级预算，服务端没法绕开；工具轮次多的场景建议放慢节奏，或改用官方 API。

**图片输入有什么限制**
只支持直连引擎（`ENGINE=direct`）；browser 引擎会返回 400。单张 ≤10MB、一条请求最多 8 张。同一张图会按内容 hash 缓存 file id 30 分钟，重复问不会重复上传。

**页面/接口改版**
直连：改 `src/direct/client.mjs` 的路径和字段；兜底：改 `src/browser/page-scripts.mjs` 顶部的选择器。

## 免责声明

本项目只做协议封装，不是 DeepSeek 官方产品。请遵守其服务条款；账号风险（限流、风控、封禁）由使用者自行承担。
## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](./LICENSE) file for details.

**🥚彩蛋：**
Q:不能对接deepseek harness？你这项目也不行啊
**A:你有没有想过一个问题，你为什么要使用dsh，不就是因为dsh严格控制前缀 缓存命中率高所以更省钱吗？关键是，你已经通过这个项目获得了免费token
那你还非得用dsh干什么😂
(当然如果你是真心喜欢dsh那就当我没说(ー_ー)!!)
**
