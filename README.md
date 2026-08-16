# Antigravity to OpenAI API 代理服务

将 Google Antigravity API 转换为 OpenAI 兼容格式的代理服务，支持流式响应、工具调用和多账号管理。

## ✨ 功能特性

| 特性 | 说明 |
| :--- | :--- |
| 🔒 **全站原生 HTTPS & ACME 证书** | 默认支持 443 端口加密传输，集成 acme.sh 自动化签发与到期无感热重载，支持 DNS 解析校验与 IP 自签证书兜底 |
| 🔑 **2FA 双因素身份验证** | 支持使用 Google Authenticator 等动态口令 App 绑定 2FA，提供 10 个一次性备用恢复码防丢防护 |
| 🎛️ **CLI 功能开关控制** | 可在设置中开启或关闭 Gemini CLI (/cli/*) API 反代功能，关闭后自动隐藏 CLI 页面标签 |
| 🎯 **API 密钥 Token 消耗上限** | 支持为单个 API Key 设置最大 Token 消耗限制（如设置 1 亿 Token 阈值），用完后自动禁用防止超量使用 |
| 🔑 **多 API 密钥管理** | 支持创建、编辑、开启/禁用、删除多个 API Key，且每个 Key 独立记录请求数与 Token 使用明细 |
| 📊 **Token 消费统计** | 提供基于 API Key 维度的 Input / Output / Total Token 使用量实时仪表盘统计与百分比显示 |
| 🔄 **额度自动控制** | 可在“轮询与性能”中自定义最低额度阈值，低于阈值自动停止轮询，恢复后自动激活 |
| 🌐 **域名与证书动态管理** | 后台提供“域名与 SSL 证书”管理页面，可在线更新域名、查看证书剩余天数、一键续期及贴入自定义证书 |
| 🌐 **请求来源与明细日志** | 实时日志面板清晰标注客户端来源 IP，并高亮单次 API 请求消耗的 Token 数量 |
| 📦 **配置导入导出与全防护** | 支持全量配置与 Token 一键导入/导出；自动屏蔽敏感文件，防止推送 Git 泄露凭据 |
| 📈 **周额度与全屏大屏展示** | 卡片与面板完整呈现 5h 及周额度限制，全屏铺满布局保障时间与数据无遮挡展示 |
| ⚡ **一键自动化安装部署** | 脚本（`setup.sh`）支持 Node.js、PM2、基础依赖全自动检测安装与开机自启守护 |
| 🔐 **登录安全审计** | 实时记录管理员登录与退出日志（带来源 IP 与账号），支持自动 IP 封禁 |
| ✅ **OpenAI / Gemini / Claude 兼容** | 完整兼容 OpenAI、Gemini v1beta 与 Claude 格式 API |
| ✅ **流式与结构化输出** | 支持 SSE 流式响应、结构化 JSON（`response_format`）与工具调用（Function Calling） |
| ✅ **思维链 (Thinking) 输出** | 兼容 OpenAI `reasoning_effort` 参数和 DeepSeek `reasoning_content` 格式 |
| ✅ **图片生成与多模态** | 支持 Base64 图片输入与 `gemini-3-pro-image` 图片生成（SD WebUI API 兼容） |
| ✅ **多账号轮询与配额** | 支持均衡负载、额度耗尽与自定义次数轮流切号，自动刷新 Token |
| ✅ **系统级预编译二进制** | 提供免 Node.js 环境的 Linux / Windows 预编译可执行文件与 TLS 指纹伪装 |

## 环境要求

- Node.js >= 18.0.0

## 快速开始

### 方式一：一键部署脚本（推荐）

**Windows (cmd.exe)**：
```bash
curl -O https://raw.githubusercontent.com/4kercc/antigravity2api-nodejs/antigravity2api/setup.bat && setup.bat
```

**Windows (PowerShell)**：
```powershell
IwR -Uri https://raw.githubusercontent.com/4kercc/antigravity2api-nodejs/antigravity2api/setup.bat -OutFile setup.bat; .\setup.bat
```

**Linux/macOS**：
```bash
wget https://raw.githubusercontent.com/4kercc/antigravity2api-nodejs/antigravity2api/setup.sh && chmod +x setup.sh && ./setup.sh
```

或使用 curl：
```bash
curl -O https://raw.githubusercontent.com/4kercc/antigravity2api-nodejs/antigravity2api/setup.sh && chmod +x setup.sh && ./setup.sh
```

脚本会自动完成以下操作：
1. 检测并自动安装 git, curl, openssl, Node.js, PM2 等系统依赖
2. 克隆项目仓库或直接在当前目录准备环境
3. 安装 npm 项目依赖
4. 交互式配置域名与 HTTPS 证书（提示输入域名并校验 DNS；为空则生成自签 IP 证书，非空自动使用 acme.sh 签发官方 SSL 证书）
5. 交互式配置管理员凭据与 API 密钥（回车自动生成随机 Key）
6. 提交 PM2 服务守护并设置开机自启（默认强制使用 443 HTTPS 端口访问）

### 快速启动（已部署）

如果已经部署成功，可以使用启动脚本快速启动服务：

**Windows**：
```bash
start.bat
```

**Linux/macOS**：
```bash
chmod +x start.sh
./start.sh
```

### 更新项目

使用更新脚本可以安全地更新到最新版本（自动保存本地修改）：

**Windows**：
```bash
update.bat
```

**Linux/macOS**：
```bash
chmod +x update.sh
./update.sh
```

更新完成后，可以选择：
- 恢复本地修改：`git stash pop`
- 删除本地修改：`git stash drop`

### 方式二：手动部署

#### 1. 安装依赖

```bash
npm install
```

#### 2. 配置环境变量

首次启动时，如果 `.env` 和 `config.json` 不存在，系统会自动创建默认配置文件。

你也可以手动复制示例文件：

```bash
cp .env.example .env
cp config.json.example config.json
```

编辑 `.env` 文件配置必要参数：

```env
# 必填配置（留空则自动生成随机凭据）
API_KEY=sk-text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# 可选配置
# PROXY=http://127.0.0.1:7890
# SYSTEM_INSTRUCTION=你是聊天机器人
# IMAGE_BASE_URL=http://your-domain.com
```

#### 3. 登录获取 Token

```bash
npm run login
```

浏览器会自动打开 Google 授权页面，授权后 Token 会保存到 `data/accounts.json`。

#### 4. 启动服务

```bash
npm start
```

服务将在 `http://localhost:8045` 启动。

## 二进制文件部署（推荐）

无需安装 Node.js，直接下载预编译的二进制文件即可运行。
