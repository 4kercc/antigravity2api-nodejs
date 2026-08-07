import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns';
import { exec } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';
import { getDataDir } from './paths.js';

const execAsync = promisify(exec);

// 证书保存目录: <dataDir>/certs
const CERTS_DIR = path.join(getDataDir(), 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const INFO_PATH = path.join(CERTS_DIR, 'cert_info.json');

/**
 * 确保证书目录存在
 */
export function ensureCertsDir() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }
}

/**
 * 获取证书文件路径
 */
export function getCertPaths() {
  ensureCertsDir();
  return {
    certPath: CERT_PATH,
    keyPath: KEY_PATH,
    infoPath: INFO_PATH,
    certsDir: CERTS_DIR
  };
}

/**
 * 检查证书和私钥文件是否存在
 */
export function certsExist() {
  return fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
}

/**
 * 读取证书及元数据信息
 */
export function getCertificateInfo() {
  if (!certsExist()) {
    return {
      exists: false,
      domain: '',
      type: 'none',
      validFrom: null,
      validTo: null,
      daysRemaining: 0,
      issuer: '',
      autoRenew: true
    };
  }

  try {
    const certPem = fs.readFileSync(CERT_PATH, 'utf8');
    const x509 = new crypto.X509Certificate(certPem);

    const validFrom = new Date(x509.validFrom);
    const validTo = new Date(x509.validTo);
    const now = new Date();
    const daysRemaining = Math.max(0, Math.ceil((validTo - now) / (1000 * 60 * 60 * 24)));

    let meta = { type: 'custom', domain: '', autoRenew: true };
    if (fs.existsSync(INFO_PATH)) {
      try {
        meta = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
      } catch (e) {
        // 忽略解析错误
      }
    }

    // 从 Subject 或 SAN 获取域名信息
    let subjectDomain = '';
    if (x509.subject) {
      const match = x509.subject.match(/CN=([^,\n]+)/);
      if (match) subjectDomain = match[1];
    }

    return {
      exists: true,
      domain: meta.domain || subjectDomain || '',
      type: meta.type || (subjectDomain.includes('localhost') || subjectDomain.match(/^\d+\.\d+\.\d+\.\d+$/) ? 'self-signed' : 'acme'),
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysRemaining,
      issuer: x509.issuer,
      subject: x509.subject,
      autoRenew: meta.autoRenew !== false
    };
  } catch (error) {
    logger.error('解析证书信息失败:', error.message);
    return {
      exists: true,
      error: error.message,
      daysRemaining: 0,
      autoRenew: true
    };
  }
}

/**
 * 保存证书元数据
 */
export function saveCertMeta(meta) {
  ensureCertsDir();
  const current = fs.existsSync(INFO_PATH) ? JSON.parse(fs.readFileSync(INFO_PATH, 'utf8')) : {};
  const updated = { ...current, ...meta, updatedAt: new Date().toISOString() };
  fs.writeFileSync(INFO_PATH, JSON.stringify(updated, null, 2), 'utf8');
}

/**
 * 校验域名的 DNS 是否指向给定 IP 或本地公网 IP
 */
export async function verifyDomainDNS(domain, expectedIp = null) {
  if (!domain) return { valid: false, reason: '域名不能为空' };

  try {
    const addresses = await dns.promises.resolve4(domain);
    if (!addresses || addresses.length === 0) {
      return { valid: false, reason: `域名 ${domain} 未解析到任何 IPv4 地址` };
    }

    if (expectedIp) {
      const matches = addresses.includes(expectedIp);
      return {
        valid: matches,
        resolvedIps: addresses,
        expectedIp,
        reason: matches ? 'DNS 解析正确' : `域名解析到的 IP (${addresses.join(', ')}) 与期望 IP (${expectedIp}) 不符`
      };
    }

    return {
      valid: true,
      resolvedIps: addresses,
      reason: 'DNS 解析成功'
    };
  } catch (error) {
    return { valid: false, reason: `DNS 解析异常: ${error.message}` };
  }
}

/**
 * 生成自签证书 (包含 IP 或 localhost)
 */
export async function generateSelfSignedCert(ipOrDomain = '127.0.0.1') {
  ensureCertsDir();
  logger.info(`正在为 ${ipOrDomain} 生成自签 SSL 证书...`);

  // 使用 openssl 生成配置
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(ipOrDomain);
  const san = isIp ? `IP:${ipOrDomain}` : `DNS:${ipOrDomain}`;

  const configFile = path.join(CERTS_DIR, 'openssl_tmp.cnf');
  const configContent = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
C = CN
ST = State
L = City
O = Antigravity
CN = ${ipOrDomain}

[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${san}
`;

  fs.writeFileSync(configFile, configContent, 'utf8');

  try {
    const cmd = `openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -config "${configFile}"`;
    await execAsync(cmd);
    fs.unlinkSync(configFile);

    saveCertMeta({
      domain: ipOrDomain,
      type: 'self-signed',
      autoRenew: false
    });

    logger.info(`自签 SSL 证书生成成功: ${CERT_PATH}`);
    return true;
  } catch (error) {
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    logger.error('OpenSSL 自签证书生成失败:', error.message);
    throw new Error('生成自签证书失败，请检查系统是否已安装 openssl');
  }
}

/**
 * 使用 acme.sh 自动申请签发免费官方 SSL 证书
 */
export async function issueAcmeCert(domain, email = 'admin@example.com') {
  ensureCertsDir();
  logger.info(`正在通过 acme.sh 为域名 ${domain} 申请签发官方 SSL 证书...`);

  // 1. 检查 DNS 解析
  const dnsCheck = await verifyDomainDNS(domain);
  if (!dnsCheck.valid) {
    throw new Error(`DNS 校验失败: ${dnsCheck.reason}`);
  }

  // 2. 检查 acme.sh 安装
  const acmeHome = path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.acme.sh');
  const acmeBin = path.join(acmeHome, 'acme.sh');

  if (!fs.existsSync(acmeBin)) {
    logger.info('未检测到 acme.sh，正在自动安装 acme.sh...');
    try {
      await execAsync(`curl https://get.acme.sh | sh -s email=${email}`);
    } catch (e) {
      throw new Error(`安装 acme.sh 失败: ${e.message}`);
    }
  }

  // 3. 申请证书 (使用 standalone 模式，需占用 80 端口或 HTTP 验证)
  try {
    const issueCmd = `"${acmeBin}" --issue -d ${domain} --standalone --httpport 80 --force`;
    await execAsync(issueCmd);

    const installCmd = `"${acmeBin}" --install-cert -d ${domain} --key-file "${KEY_PATH}" --fullchain-file "${CERT_PATH}"`;
    await execAsync(installCmd);

    saveCertMeta({
      domain,
      type: 'acme',
      autoRenew: true,
      issuedAt: new Date().toISOString()
    });

    logger.info(`ACME SSL 证书成功为 ${domain} 签发并安装！`);
    return true;
  } catch (error) {
    logger.error(`acme.sh 签发证书失败: ${error.message}`);
    throw new Error(`证书签发失败: ${error.stderr || error.message}`);
  }
}

/**
 * 手动写入/更新 SSL 证书及私钥文本
 */
export function updateCustomCert(certContent, keyContent, domain = '') {
  ensureCertsDir();
  try {
    // 校验私钥和证书格式合法性
    new crypto.X509Certificate(certContent);
    crypto.createPrivateKey(keyContent);

    fs.writeFileSync(CERT_PATH, certContent, 'utf8');
    fs.writeFileSync(KEY_PATH, keyContent, 'utf8');

    saveCertMeta({
      domain,
      type: 'custom',
      autoRenew: false,
      updatedAt: new Date().toISOString()
    });

    logger.info('手动更新 SSL 证书及私钥成功');
    return true;
  } catch (error) {
    throw new Error(`证书或私钥格式非法: ${error.message}`);
  }
}
