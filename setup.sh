#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 一键部署与 PM2 守护脚本"
echo "========================================"
echo

# 1. 自动检测环境与获取当前目录
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="antigravity2api"

echo "[1/7] 确认当前项目路径: ${CURRENT_DIR}"
cd "${CURRENT_DIR}" || exit 1

# 自动为指纹二进制分配执行权限
if [ -d "src/bin" ]; then
    chmod +x src/bin/fingerprint_* 2>/dev/null || true
fi

# 2. 检查 Node.js 环境
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未检测到 Node.js，请先安装 Node.js (推荐 v18+)"
    exit 1
fi

# 3. 安装依赖
echo
echo "[2/7] 安装 Node.js 项目依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败，请检查网络或 npm 源设置"
    exit 1
fi

# 4. 自动创建并配置文件
echo
echo "[3/7] 检查与初始化配置文件..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
    else
        touch .env
    fi
fi

echo
echo "[4/7] 配置管理员信息与凭据..."
read -p "请输入管理员用户名 (默认: admin): " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -p "请输入管理员密码 (默认: admin123): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin123}

# 生成随机 JWT 密钥
RANDOM_JWT_SECRET=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 32 2>/dev/null || echo "secret_$(date +%s)")

if grep -q "^# ADMIN_USERNAME=" .env 2>/dev/null || grep -q "^ADMIN_USERNAME=" .env 2>/dev/null; then
    sed -i.bak "s/^#\? ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USER/" .env
    sed -i.bak "s/^#\? ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASS/" .env
    sed -i.bak "s/^#\? JWT_SECRET=.*/JWT_SECRET=$RANDOM_JWT_SECRET/" .env
    rm -f .env.bak
else
    echo "ADMIN_USERNAME=$ADMIN_USER" >> .env
    echo "ADMIN_PASSWORD=$ADMIN_PASS" >> .env
    echo "JWT_SECRET=$RANDOM_JWT_SECRET" >> .env
fi

# 5. 检测并安装 PM2
echo
echo "[5/7] 检查并安装 PM2 进程管理器..."
if ! command -v pm2 &> /dev/null; then
    echo "正在全局安装 pm2..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "⚠️ PM2 全局安装失败，尝试以 sudo 权限安装..."
        sudo npm install -g pm2
    fi
else
    echo "✓ PM2 已安装"
fi

# 6. 加入 PM2 服务
echo
echo "[6/7] 启动 PM2 进程守护..."
# 如果服务已存在则重启，不存在则新建启动
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    echo "重置并重启已有的 PM2 实例: ${APP_NAME}..."
    pm2 restart "$APP_NAME"
else
    echo "新建 PM2 服务实例: ${APP_NAME}..."
    pm2 start src/server/index.js --name "$APP_NAME" --node-args="--expose-gc"
fi

# 7. 设置 PM2 开机自启
echo
echo "[7/7] 设置 PM2 开机自启动..."
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
