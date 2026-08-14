#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 一键克隆、部署与 PM2 守护脚本"
echo "========================================"
echo

# 1. 配置仓库与程序运行主路径
REPO_URL="https://github.com/4kercc/antigravity2api-nodejs.git"
BRANCH="antigravity2api"
TARGET_DIR="antigravity2api-nodejs"
APP_NAME="antigravity2api"

# 2. 自动检测与安装系统基础依赖 (curl, git, openssl, bind-utils/dnsutils)
echo "[1/8] 检查系统基础依赖 (curl, git, openssl, dig)..."
if ! command -v curl &> /dev/null || ! command -v git &> /dev/null || ! command -v openssl &> /dev/null || ! command -v dig &> /dev/null; then
    echo "正在安装基础系统依赖..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update -y && sudo apt-get install -y curl git openssl dnsutils
    elif command -v yum &> /dev/null; then
        sudo yum install -y curl git openssl bind-utils
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y curl git openssl bind-utils
    elif command -v apk &> /dev/null; then
        sudo apk add curl git openssl bind-tools
    fi
fi

# 3. 自动克隆或进入确切的项目目录
echo
echo "[2/8] 获取项目代码与定位工作目录..."
if [ -f "package.json" ] && grep -q "antigravity" package.json 2>/dev/null; then
    echo "✓ 当前目录已被识别为 Antigravity 项目目录: $(pwd)"
elif [ -d "$TARGET_DIR" ]; then
    echo "发现已存在固定目录 ${TARGET_DIR}，进入该目录..."
    cd "$TARGET_DIR" || exit 1
else
    echo "正在克隆分支 [${BRANCH}] 代码到固定目录 ./${TARGET_DIR}..."
    git clone -b "$BRANCH" "$REPO_URL" "$TARGET_DIR"
    if [ $? -ne 0 ]; then
        echo "❌ 项目克隆失败，请检查网络或 Git 配置"
        exit 1
    fi
    cd "$TARGET_DIR" || exit 1
fi

# 动态获取当前绝对路径，确保 PM2 始终绑定该绝对路径
PROJECT_ABS_PATH="$(pwd)"
echo "✓ 确立程序绝对工作目录: ${PROJECT_ABS_PATH}"

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

# 6. 自动创建并配置文件及 HTTPS SSL 域名处理
echo
echo "[5/8] 配置管理员信息、凭据与 HTTPS 域名..."

SERVER_PUBLIC_IP=$(curl -s --connect-timeout 3 https://api.ipify.org || curl -s --connect-timeout 3 https://ifconfig.me || curl -s --connect-timeout 3 https://ipinfo.io/ip || echo "")

read -p "请输入要绑定的域名 (如果为空，默认为自签 IP 证书): " DOMAIN_INPUT
DOMAIN_INPUT=$(echo "$DOMAIN_INPUT" | tr -d ' ')

CERTS_DIR="${PROJECT_ABS_PATH}/data/certs"
mkdir -p "${CERTS_DIR}"

if [ -z "$DOMAIN_INPUT" ]; then
    echo "💡 未输入域名，自动为公网 IP (${SERVER_PUBLIC_IP:-127.0.0.1}) 生成自签 IP 证书..."
    TARGET_IP="${SERVER_PUBLIC_IP:-127.0.0.1}"
    
    # 动态生成 openssl 自签证书
    cat <<EOF > "${CERTS_DIR}/openssl_tmp.cnf"
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
C = CN
ST = State
L = City
O = Antigravity
CN = ${TARGET_IP}
[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:${TARGET_IP}
EOF

    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "${CERTS_DIR}/server.key" -out "${CERTS_DIR}/server.crt" -config "${CERTS_DIR}/openssl_tmp.cnf" >/dev/null 2>&1
    rm -f "${CERTS_DIR}/openssl_tmp.cnf"

    cat <<EOF > "${CERTS_DIR}/cert_info.json"
{
  "domain": "${TARGET_IP}",
  "type": "self-signed",
  "autoRenew": false,
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    echo "✓ 已生成自签 IP 证书 (${CERTS_DIR}/server.crt, ${CERTS_DIR}/server.key)"
else
    echo "🔍 检查域名 ${DOMAIN_INPUT} 的 DNS 解析..."
    DOMAIN_RESOLVED_IPS=$(dig +short "$DOMAIN_INPUT" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    
    IS_MATCH=0
    if [ -n "$SERVER_PUBLIC_IP" ] && [ -n "$DOMAIN_RESOLVED_IPS" ]; then
        for ip in $DOMAIN_RESOLVED_IPS; do
            if [ "$ip" = "$SERVER_PUBLIC_IP" ]; then
                IS_MATCH=1
                break
            fi
        done
    fi

    if [ "$IS_MATCH" -eq 0 ]; then
        echo "❌ 错误: 域名 ${DOMAIN_INPUT} 未正确解析到当前服务器公网 IP (${SERVER_PUBLIC_IP:-未检测到})！"
        echo "   域名解析结果: ${DOMAIN_RESOLVED_IPS:-解析失败/无响应}"
        echo "   请先去域名 DNS 控制台将 A 记录指向 ${SERVER_PUBLIC_IP} 后重新运行脚本。"
        exit 1
    fi

    echo "✓ 域名 DNS 校验通过！已解析到当前服务器 IP: ${SERVER_PUBLIC_IP}"
    echo "🔐 开始使用 acme.sh 签发官方 SSL 证书..."

    # 检查并安装 acme.sh
    if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
        echo "正在安装 acme.sh 证书自动化工具..."
        curl https://get.acme.sh | sh -s email=admin@${DOMAIN_INPUT} >/dev/null 2>&1
    fi
    ACME_BIN="$HOME/.acme.sh/acme.sh"

    # 申请并安装证书
    "$ACME_BIN" --issue -d "$DOMAIN_INPUT" --standalone --httpport 80 --force
    if [ $? -ne 0 ]; then
        echo "❌ 证书签发失败！请检查 80 端口是否被占用或防火墙设置。"
        exit 1
    fi

    "$ACME_BIN" --install-cert -d "$DOMAIN_INPUT" \
        --key-file "${CERTS_DIR}/server.key" \
        --fullchain-file "${CERTS_DIR}/server.crt"

    cat <<EOF > "${CERTS_DIR}/cert_info.json"
{
  "domain": "${DOMAIN_INPUT}",
  "type": "acme",
  "autoRenew": true,
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
    echo "🎉 SSL 证书已成功签发并安装！"

    # 将域名更新写入 config.json
    if [ -f "config.json" ]; then
        node -e "
            const fs = require('fs');
            try {
                const conf = JSON.parse(fs.readFileSync('config.json', 'utf8'));
                conf.server = conf.server || {};
                conf.server.domain = '$DOMAIN_INPUT';
                fs.writeFileSync('config.json', JSON.stringify(conf, null, 2), 'utf8');
            } catch (e) {}
        "
    fi
fi

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
    else
        touch .env
    fi
fi
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
# 清理死进程，确保以固定的绝对路径启动
pm2 delete "$APP_NAME" > /dev/null 2>&1 || true

echo "新建 PM2 服务实例 [工作路径: ${PROJECT_ABS_PATH}]..."
pm2 start "${PROJECT_ABS_PATH}/src/server/index.js" --name "$APP_NAME" --cwd "${PROJECT_ABS_PATH}" --node-args="--expose-gc"

pm2 save
pm2 startup 2>/dev/null || echo "💡 提示: 请复制下方系统提示的命令以完成开机自启安装"

# 动态构建 HTTPS 访问地址
if [ -n "$DOMAIN_INPUT" ]; then
    PUBLIC_URL="https://${DOMAIN_INPUT}"
elif [ -n "$SERVER_PUBLIC_IP" ]; then
    PUBLIC_URL="https://${SERVER_PUBLIC_IP}"
else
    PUBLIC_URL="https://您的服务器IP"
fi

echo
echo "=========================================================="
echo "🎉 Antigravity2API 部署成功并已提交 PM2 守护运行！"
echo "=========================================================="
echo
echo "📂 项目安装路径："
echo "   - 绝对路径: ${PROJECT_ABS_PATH}"
echo
echo "🌐 服务访问信息 (全站强制 443 HTTPS 端口)："
echo "   - 公网管理后台: ${PUBLIC_URL}"
echo "   - 本地管理后台: https://127.0.0.1"
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
