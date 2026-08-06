#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 一键启动脚本"
echo "========================================"
echo

echo "[1/6] 克隆项目..."
if [ -d "antigravity2api-nodejs" ]; then
    echo "当前目录已经存在同名文件夹，已退出"
    exit 1
fi
git clone https://github.com/4kercc/antigravity2api-nodejs.git
if [ $? -ne 0 ]; then
    echo "克隆失败，请检查网络或 Git 是否已安装"
    exit 1
fi

echo
echo "[2/6] 进入项目目录..."
cd antigravity2api-nodejs

echo
echo "[3/6] 安装依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "安装依赖失败"
    exit 1
fi

echo
echo "[4/6] 复制配置文件..."
cp .env.example .env

echo
echo "[5/6] 配置管理员信息..."
echo
read -p "请输入管理员用户名 (默认: admin): " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -p "请输入管理员密码 (默认: admin123): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin123}

read -p "请输入 API 密钥 (默认: sk-text): " API_KEY
API_KEY=${API_KEY:-sk-text}

sed -i.bak "s/^# API_KEY=.*/API_KEY=$API_KEY/" .env
sed -i.bak "s/^# ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USER/" .env
sed -i.bak "s/^# ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASS/" .env
sed -i.bak "s/^# JWT_SECRET=.*/JWT_SECRET=change-this-secret-key/" .env
rm -f .env.bak

echo
echo "========================================"
echo "配置完成！启动服务..."
echo "========================================"
echo
echo "可用服务："
echo
echo "1. 管理界面: http://127.0.0.1:8045"
echo "   - 使用账号: $ADMIN_USER"
echo "   - 使用密码: $ADMIN_PASS"
echo "   - 请先登录配置反重力或 Gemini CLI 凭证"
echo
echo "2. 反重力 API 端口:"
echo "   - OpenAI 格式: http://127.0.0.1:8045/v1"
echo "   - Gemini 格式: http://127.0.0.1:8045/v1beta"
echo "   - Claude 格式: http://127.0.0.1:8045/v1"
echo
echo "3. Gemini CLI API 端口:"
echo "   - OpenAI 格式: http://127.0.0.1:8045/cli/v1"
echo "   - Gemini 格式: http://127.0.0.1:8045/cli/v1beta"
echo
echo "========================================"
echo

echo "[6/6] 启动服务..."
npm start
