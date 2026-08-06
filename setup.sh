#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 一键克隆、部署与 PM2 守护脚本"
echo "========================================"
echo

# 1. 自动检测环境与获取当前目录
REPO_URL="https://github.com/liuw1535/antigravity2api-nodejs.git"
TARGET_DIR="antigravity2api-nodejs"
APP_NAME="antigravity2api"

# 2. 自动检测与安装系统基础依赖 (curl, git)
echo "[1/8] 检查系统基础依赖 (curl, git)..."
if ! command -v curl &> /dev/null || ! command -v git &> /dev/null; then
    echo "正在安装基础系统依赖..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update -y && sudo apt-get install -y curl git
    elif command -v yum &> /dev/null; then
        sudo yum install -y curl git
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y curl git
    elif command -v apk &> /dev/null; then
        sudo apk add curl git
    fi
fi

# 3. 自动克隆或进入项目目录
echo
echo "[2/8] 获取项目代码..."
if [ -f "package.json" ] && grep -q "antigravity" package.json 2>/dev/null; then
    echo "✓ 当前已在项目目录中，准备开始配置..."
elif [ -d "$TARGET_DIR" ]; then
    echo "发现已存在 ${TARGET_DIR} 目录，进入该目录..."
    cd "$TARGET_DIR" || exit 1
else
    echo "正在从 GitHub 克隆项目代码: ${REPO_URL}..."
    git clone "$REPO_URL" "$TARGET_DIR"
    if [ $? -ne 0 ]; then
        echo "❌ 项目克隆失败，请检查网络或 Git 配置"
        exit 1
    fi
    cd "$TARGET_DIR" || exit 1
fi

# 自动为指纹二进制分配执行权限
if [ -d "src/bin" ]; then
    chmod +x src/bin/fingerprint_* 2>/dev/null || true
fi

# 4. 自动检测与安装 Node.js (如缺失，自动安装 Node.js LTS)
echo
echo "[3/8] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo "⚠️ 未检测到 Node.js，正在自动为您安装 Node.js LTS (v20)..."
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v yum &> /dev/null || command -v dnf &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs 2>/dev/null || sudo dnf install -y nodejs
    else
        echo "❌ 无法自动安装 Node.js，请手动安装 Node.js v18+ 后重试。"
        exit 1
    fi
fi

NODE_VER=$(node -v)
echo "✓ Node.js 环境正常: ${NODE_VER}"

# 5. 安装 Node.js 项目依赖
echo
echo "[4/8] 安装项目 NPM 依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ NPM 依赖安装失败，请检查网络或源配置。"
    exit 1
fi

# 6. 自动创建并配置文件
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
    else
        touch .env
    fi
fi

echo
echo "[5/8] 配置管理员信息与凭据..."
read -p "请输入管理员用户名 (默认: admin): " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -p "请输入管理员密码 (默认: admin123): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin123}

# 生成随机 API Key
DEFAULT_GEN_KEY="sk-$(head /dev/urandom | tr -dc a-z0-9 | head -c 24 2>/dev/null || echo "key_$(date +%s)")"
read -p "请输入初始 API 密钥 (按回车自动生成随机 Key): " API_KEY_INPUT
FINAL_API_KEY=${API_KEY_INPUT:-$DEFAULT_GEN_KEY}

# 生成随机 JWT 密钥
RANDOM_JWT_SECRET=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 32 2>/dev/null || echo "secret_$(date +%s)")

if grep -q "^# ADMIN_USERNAME=" .env 2>/dev/null || grep -q "^ADMIN_USERNAME=" .env 2>/dev/null; then
    sed -i.bak "s/^#\? ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USER/" .env
    sed -i.bak "s/^#\? ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASS/" .env
    sed -i.bak "s/^#\? API_KEY=.*/API_KEY=$FINAL_API_KEY/" .env
    sed -i.bak "s/^#\? JWT_SECRET=.*/JWT_SECRET=$RANDOM_JWT_SECRET/" .env
    rm -f .env.bak
else
    echo "ADMIN_USERNAME=$ADMIN_USER" >> .env
    echo "ADMIN_PASSWORD=$ADMIN_PASS" >> .env
    echo "API_KEY=$FINAL_API_KEY" >> .env
    echo "JWT_SECRET=$RANDOM_JWT_SECRET" >> .env
fi

# 7. 检测并自动全局安装 PM2
echo
echo "[6/8] 检查并安装 PM2 进程管理器..."
if ! command -v pm2 &> /dev/null; then
    echo "正在全局安装 PM2..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "⚠️ PM2 全局安装失败，尝试以 sudo 权限安装..."
        sudo npm install -g pm2
    fi
else
    echo "✓ PM2 已安装"
fi

# 8. 加入 PM2 服务与开机自启动
echo
echo "[7/8] 启动 PM2 进程守护并配置自启动..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    echo "重置并重启已有的 PM2 实例: ${APP_NAME}..."
    pm2 restart "$APP_NAME"
else
    echo "新建 PM2 服务实例: ${APP_NAME}..."
    pm2 start src/server/index.js --name "$APP_NAME" --node-args="--expose-gc"
fi

pm2 save
pm2 startup 2>/dev/null || echo "💡 提示: 请复制下方系统提示的命令以完成开机自启安装"

echo
echo "=========================================================="
echo "🎉 Antigravity2API 部署成功并已提交 PM2 守护运行！"
echo "=========================================================="
echo
echo "🌐 服务访问信息："
echo "   - 管理后台地址: http://127.0.0.1:8045"
echo "   - 管理员账号:   $ADMIN_USER"
echo "   - 管理员密码:   $ADMIN_PASS"
echo "   - 初始 API 密钥: $FINAL_API_KEY"
echo
echo "🛠️ 常用 PM2 命令说明（非常重要）："
echo "   ┌───────────────────────────────────────────┐"
echo "   │ 查看服务运行状态:   pm2 status            │"
echo "   │ 查看实时日志:       pm2 logs ${APP_NAME} │"
echo "   │ 重启 API 服务:      pm2 restart ${APP_NAME}│"
echo "   │ 停止 API 服务:      pm2 stop ${APP_NAME}   │"
echo "   │ 保存当前进程状态:   pm2 save              │"
echo "   └───────────────────────────────────────────┘"
echo "=========================================================="
