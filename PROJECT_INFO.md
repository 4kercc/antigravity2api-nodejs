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

### 7. 请求日志账号溯源与 400 INVALID_ARGUMENT 参数自愈
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
