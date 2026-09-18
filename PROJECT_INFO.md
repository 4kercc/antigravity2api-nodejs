# Antigravity2API 项目核心架构与历史演进全景文档

本文档全面梳理并记录了 **Antigravity2API**（高性能 Google Antigravity IDE 逆向转 OpenAI/Gemini/Claude 标准协议服务）的项目架构、核心模块设计、关键功能演进历史以及部署运维规范，以便开发者随时无缝迁移至各类 AI 编程工具或多终端环境中继续接力开发与维护。

---

## 📌 一、 项目定位与技术栈概览

- **定位**：高并发、低内存占用（~100MB）的 Google Antigravity 开发者环境逆向网关与多格式 API 桥接层。
- **技术栈**：
  - **核心后端**：Node.js (ESM), Express 4.x, Axios, WebSocket (WS), JWT (jsonwebtoken)
  - **安全防护**：WebAuthn/FIDO2 (Passkeys), TOTP (RFC 6238), Fail2ban Heuristic Scanner Blocker, Peer TCP Socket IP Filter
  - **上游网络**：TLS 指纹模拟 (`requester.js`), SOCKS5/WARP 动态旁路路由, 自动化域名 ACME SSL (Greenlock/Self-Signed)
  - **前端面板**：原生 HTML5 + Vanilla JavaScript + CSS 变量体系（支持明暗主题、响应式适配与极速加载）

---

## 🏗️ 二、 核心架构与目录分工

```
antigravity2api/
├── src/
│   ├── api/
│   │   ├── client.js                 # Antigravity 原生 API 通信客户端（Protobuf/TLS）
│   │   └── externalChannelClient.js  # 外部 OpenAI/Gemini 上游端点分流适配器
│   ├── auth/
│   │   ├── token_manager.js          # Token 生命周期、多账号轮询池、积分订阅同步与批量管理
│   │   ├── quota_manager.js          # 429 速率与模型配额追踪
│   │   ├── api_key_manager.js        # 对外 API Key 签发、用量统计与限流
│   │   └── jwt.js                    # 管理后台 JWT 鉴权与 Cookie 签发
│   ├── routes/
│   │   ├── admin.js                  # 后台 RESTful 管理接口 (Token, 2FA, Passkey, Channels, IP 封禁, SSL)
│   │   └── apikey.js                 # API Key 查询与用量开放接口
│   ├── server/
│   │   ├── index.js                  # Express 核心服务、Fail2ban 防扫中间件、TCP Peer IP 拦截
│   │   └── handlers/                 # 协议转换引擎 (openai.js, claude.js, gemini.js, cli.js)
│   └── utils/
│       ├── totpManager.js            # TOTP 动态码、备用恢复码、WebAuthn 通行密钥持久化管理
│       ├── channelManager.js         # 外部上游渠道 (AIStudioToAPI / OneAPI) 持久化管理
│       ├── ipBlockManager.js         # IP 黑名单与行为违规权重封禁器
│       ├── warpManager.js            # Cloudflare WARP SOCKS5 代理进程管理与自动重启探活
│       ├── sslManager.js             # 自签/Let's Encrypt 证书申请与自动化续期
│       └── logger.js                 # 多级别日志记录与前端 WebSocket 实时推送
├── public/                           # 管理后台 WebUI
│   ├── index.html                    # 单页管理后台结构
│   ├── style.css                     # 模块化 CSS 聚合入口
│   └── js/
│       ├── main.js                   # 入口逻辑、登录控制与 2FA/Passkey 二次验证弹窗
│       ├── tokens.js                 # Token 卡片渲染、多选选中、批量删除与配额展开
│       ├── security.js               # 2FA 设置、TOTP 绑定、Passkey 注册与移除
│       ├── channels.js               # 外部渠道分流管理面板与连通性测试
│       └── apikeys.js                # API Key 增删改查与额度分配
├── data/                             # 运行时数据目录 (已忽略或持久化挂载)
│   ├── tokens.json                   # 原生 Antigravity 账号数据
│   ├── channels.json                 # 外部上游渠道配置
│   ├── security_2fa.json             # 2FA 密钥、备用码与 WebAuthn Passkeys
│   ├── ip_bans.json                  # 动态封禁 IP 列表
│   └── api_keys.json                 # 开放 API 密钥数据
└── PROJECT_INFO.md                   # 本全景设计交接文档
```

---

## 🚀 三、 关键功能演进与历史改动全记录

### 1. 公网直接监听（无 Nginx 裸连）安全加固
- **TCP Peer IP 防伪造**：关闭 Express `trust proxy`，从 `req.socket.remoteAddress` 提取底层真实 TCP 连接 IP，彻底防御攻击者伪造 `X-Forwarded-For: 127.0.0.1` 绕过限流与白名单。
- **Fail2ban 级漏洞扫描自动封禁**：在 404 中间件中集成 `MALICIOUS_PROBE_REGEX`，对 `.php`、`phpunit`、`eval-stdin.php`、`.env`、`/containers/json`、`actuator` 等漏洞探测行为单次赋予 5~10 的高额违规权重，达到阈值直接秒级封禁。

### 2. 双因素二次验证 (2FA / TOTP) 与 Bitwarden 自动填充
- **RFC 6238 TOTP 引擎**：纯原生算法实现 Base32 解码与 HMAC-SHA1 动态码验证，支持 ±30 秒窗口容差，提供 10 个 8 位 Hex 一次性备用恢复码。
- **密码管理器体验优化**：表单增加 `<form id="twoFactorLoginForm">`，动态码输入框标记 `autocomplete="one-time-code"`、`name="totp"` 和 `inputmode="numeric"`，完美兼容 Bitwarden、1Password 自动识别与填充。

### 3. FIDO2 / WebAuthn 通行密钥 (Passkey) 无密码生物验证
- **免密二次验证**：支持 Windows Hello（指纹/面容/PIN）、MacBook Touch ID 以及 YubiKey / Bitwarden Passkey。
- **Bitwarden 兼容性规范化**：
  - 在 `registerPasskey` 中显式指定 `rp.id: window.location.hostname` 与 `residentKey: "preferred"`；
  - 在 `show2FALoginModal` 的 `navigator.credentials.get` 中统一注入 `rpId: window.location.hostname`，确保 Bitwarden 密码库准确命中当前域名并一键授权。

### 4. 外部上游渠道与本地路由路径分流 (Path-based Routing / token.mx.mk / AIStudio / OneAPI)
- **本地路径全动态分流 (Full Dynamic Path-based Routing)**：
  - 支持为每个添加的外部账号指定专属的**本地分流路径**（不仅支持 `/v2`、`/v3` 等版本号，还支持任意自定义英文标识如 `/vip`、`/fast`、`/backup` 等）；
  - 前端支持一键生成随机英文字符路径（如 `/vip-8f3a`），并实时提醒客户端调用端点；
  - 当客户端请求 `POST /v1/chat/completions` 时，走主程序原生 Google 账号池；
  - 当客户端请求 `POST /v2/chat/completions` 或 `POST /vip/chat/completions`、`POST /fast/messages` 时，系统全动态精准路由到绑定了对应路径的第三方上游（如 `https://token.mx.mk/v2` 等）；
  - 若多个渠道配置相同路径，系统自动在对应渠道集合中进行轮询负载均衡；
  - 核心保留路径（`/admin`, `/v1`, `/cli`, `/sdapi`, `/health`, `/ws` 等）受系统级保护，避免路由冲突；
- **端点智能规范化 (`normalizeUpstreamEndpoint`)**：自动适配 Base URL，智能处理末尾斜杠与 `/chat/completions` 防重，保障多端点兼容；
- **模型自动降级自愈 (`resolveModelForChannel`)**：支持为每个外部渠道配置**默认降级模型 (Default Model)**（如 `gpt-5`）。当客户端请求不受该渠道支持的模型时（例如前端请求 `gpt-5.5`），后端自动无感降级转换为默认模型转发至上游，杜绝 404/400/500 上游报错；
- **协议标准化与净化**：在 `externalChannelClient.js` 中自动去除 Antigravity 私有字段，兼容 OpenAI 标准 `POST /chat/completions` SSE 流式传输，并对 429/502 错误支持自动降级（Failover）。
- **三种分流路由策略（针对未指定 pathPrefix 或 /v1 默认流量）**：
  - `fallback`（智能降级，默认）：优先原生 Token，原生耗尽或故障自动降级到外部渠道；
  - `external_first`（优先外部）：优先外部通道，不足时由原生补足；
  - `external_only`（仅外部渠道）：强制所有请求走外部渠道。

### 5. Token 卡片多选与批量删除
- **批量交互体验**：卡片左上角增加复选框，选中即高亮卡片（`.selected`）；
- **动态浮动栏**：勾选时平滑展开 `Batch Action Bar`，支持全选当前筛选列表、半选状态联动、一键清空选择；
- **原子化后端接口**：`POST /admin/tokens/batch-delete` 批量清除池中 Token 并一次性刷盘持久化。

### 6. Cloudflare WARP 自动探活与重启
- **SOCKS5 自动代理**：针对 Refresh Token 刷新或请求 Google API 时出现的区域受限（`User location is not supported`），通过本地 SOCKS5 代理穿透。
- **故障触发重启**：遇到连续网络阻断时自动触发 WARP 服务重启以轮换 IP。

### 7. 轮询与性能：额度耗尽切换阈值修复（make quota threshold effective）
- **问题背景**：管理后台「设置 → 轮询与性能 → 额度耗尽切换阈值」形同虚设，账号会被一直用到 0 额度。
- **三层根因与修复**：
  1. **阈值配置被静默丢弃**：`PUT /admin/rotation` 只接收 `strategy` / `requestCount`，`minQuotaThreshold` 未落盘（`src/routes/admin.js`）；现已支持接收、0~1 范围校验、百分比写法兼容（60 → 0.6）并持久化到 `config.json`；
  2. **额度数据从不自动刷新（最致命）**：三个 handler 中定义的 `refreshQuota` 虽然传入了 `with429Retry`，但从未被调用，`quotaManager` 缓存长期为空，而空数据一律被判为「有额度」，阈值过滤完全失效。现在：① `with429Retry` 在**请求成功路径**与**429 长冷却（额度耗尽）时**自动刷新额度，并按 tokenId 节流（常规 3 分钟 / 强制 30 秒）；② 新增 `src/auth/quota_sync.js` **定时同步任务**（默认每 10 分钟，启动后 30 秒预热），批量刷新所有启用账号额度，可通过 `config.json` 的 `quota.syncIntervalMs` 调整或置 0 关闭；
  3. **策略按下标追踪账号导致错位**：`QuotaExhaustedStrategy` 原用数组下标在动态过滤后的候选列表上取模，账号被过滤/恢复时索引错位；现改为按 `tokenId` 追踪当前账号，并记录上一次候选顺序，切换时从当前账号之后循环查找，保证稳定顺延。
- **配套增强**：
  - `hasQuotaForModel` 增加数据陈旧上限（超过 60 分钟视为不可信），避免陈旧数据永久排除或永久放行某账号；
  - 新增**全账号低于阈值时的兜底降级**：`_pickLeastDepletedToken` 会选择「剩余额度最高且不在冷却中」的账号继续服务，避免阈值生效后出现整体不可用；
  - `TokenManager` 新增 `ensureInitialized()` 供定时任务安全访问 token 池；`getRotationConfig()` 返回中补充 `minQuotaThreshold`。

### 8. WARP 代理三层自愈体系（startup restart + port health monitor + widened error detection）
- **问题背景**：WARP SOCKS5 代理（127.0.0.1:40000）掉线后，后端所有依赖代理的请求（Token 刷新 / 积分同步 / 额度同步 / 定时遥测）全部失败，而系统没有任何机制能自动发现——必须人工打开面板点“重启”才能恢复。
- **三层自愈设计**：
  1. **启动自愈（面板/服务每次重启后主动换 IP）**：`server/index.js` 在 `server.listen()` **之前** `await warpManager.restartOnStartup()`，先执行一次 `warp restart` 并等待 40000 端口就绪，再对外提供服务。可用 `config.json` 的 `warp.restartOnStartup = false` 关闭；
  2. **定期健康检查**：服务启动后由 `warpManager.startHealthMonitor()` 每 2 分钟探测一次 40000 端口，**连续 3 次不可达**即自动重启 WARP 并等待端口恢复（间隔与阈值可通过 `warp.healthCheckIntervalMs` / `warp.healthCheckFailures` 配置）；
  3. **后台任务失败快速上报**：`warpManager.reportNetworkFailure()` 提供滑动窗口计数（5 分钟内累计 5 次即触发重启，默认阈值 `warp.failureReportThreshold`），已接入**额度同步全部失败**与**定时遥测（ClientRegister/ClientFeature/FrontEnd）失败**两条链路，比端口轮询更快发现代理中断。
- **错误识别缺陷修复**：原先 Token 刷新路径只匹配大写 `ECONNREFUSED`，而 `socks-proxy-agent` 实际抛出的文本是 `Socks5 proxy rejected connection - ConnectionRefused`（大小写不同）导致漏判。现已统一转小写匹配，并补充 `proxy rejected`、`connection refused`、`econnreset`、`socket hang up`、`failed to fetch`、`getaddrinfo` 等特征，同时把 `500~504` 纳入网络异常判定。
- **配套加固**：
  - `restartWarp` 的 shell 执行新增 60 秒超时（实测走 `systemctl restart warp-svc` 兜底分支时可达 25 秒，过短会在重启中途杀进程、可能让 WARP 停留在断开状态）；
  - 启动自愈设 25 秒等待预算：超时则**不阻塞服务启动**，改由后台继续等待重启完成并校验 40000 端口就绪（日志会输出「后台补完」结果）；
  - 补齐 `config.js` 中缺失的 `warp` 配置段（此前 `warp.autoRestart` 未参与配置构建，进程重启后该开关会失效）；
  - 所有自愈动作复用既有的 60 秒冷却与 `isRestarting` 并发保护，不会产生重启风暴。

### 10. 日志页分页与实时推送防卡死（每页 100 条最新）
- **问题背景**：日志页同时使用 WebSocket 实时推送与 HTTP 加载，实时推送每来一条就往 DOM 追加一个节点且从不回收，长时间运行后节点数无限增长，浏览器卡死；原「加载更多」模式还会让内存数组与 DOM 双双膨胀。
- **修复要点**：
  1. **分页化**：每页固定 **100 条**（`logsState.pageSize`），第 1 页为最新日志，通过后端已有的 `limit`/`offset` 接口按页拉取；新增分页栏（「⏮ 最新 / ◀ 较新 / 第 x/y 页 · 显示 a-b 条 · 共 N 条 / 较旧 ▶」），并把原「加载更多」按钮移除；
  2. **实时推送硬上限**：`appendLogToDOM` 追加后立即裁剪，DOM 中最多保留一页的条数；`addNewLog` 同步裁剪内存数组，杜绝节点与内存无界增长；
  3. **不打断历史浏览**：仅在第 1 页做实时追加，翻到历史页时只更新统计与页码，不干扰当前视图；
  4. **鲁棒性**：页码越界自动夹紧（避免「第 53 / 1 页」这类异常显示），清空日志后重置回第 1 页，筛选/搜索自动回到最新页；WebSocket `history` 仅作为 HTTP 未就绪时的兜底，不再覆盖已加载的分页数据。
- **验证方式**：伪 DOM 逻辑仿真（模拟单页 250 条数据 + 连续 5000 条实时推送），确认 DOM 节点数恒定 100、翻页 offset 正确、历史页不被推送打断、越界页码被夹紧。

### 9. 请求日志账号溯源与 400 INVALID_ARGUMENT 参数自愈
- **账号全链路追踪**：控制台与 WebUI 日志实时高亮输出当前请求命中的账号标识 `[账号: user@gmail.com]`、`[账号: project-id]` 或 `[渠道: AIStudio-1]`，方便快速定位特定账号的额度或风控异常；
- **参数自适应安全钳制**：自动将超上限的 `max_tokens`（如 `128000`）钳制在 Google API 允许的安全阈值 `64000`；
- **高级 JSON Schema 深度清洗**：展开 `anyOf` / `oneOf` 联合类型，剥离 `format`、`default`、`annotations` 等 Google 禁用字段，彻底解决复杂 MCP 工具调用时的 400 校验拒绝问题。

---

## 🔧 四、 运维与常用命令

### 1. 分支管理规范
- **`dev` 分支**：当前日常迭代与功能开发主干，所有最新改动均推送至 `dev`。
- **`main` 分支**：生产稳定版发布分支，经充分测试后合并。

### 2. 常用开发与测试指令
```bash
# 启动开发服务器
npm run dev

# 语法与规范检查
node -c src/routes/admin.js && node -c public/js/tokens.js

# 推送代码至开发分支
git add .
git commit -m "feat/fix: update summary"
git push origin dev
```

### 3. SSH 自动化部署流
通过已配置的 `ssh-deploy` skill 或直接执行：
```bash
ssh -p <PORT> <USER>@<HOST> "cd /path/to/antigravity2api && git pull origin dev && pm2 restart all"
```
