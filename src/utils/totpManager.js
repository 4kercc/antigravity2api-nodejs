import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from './logger.js';
import { getDataDir } from './paths.js';

const CONFIG_PATH = path.join(getDataDir(), 'security_2fa.json');

// Base32 编码映射
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 编码 Base32 字符串
 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * 解码 Base32 字符串
 */
function base32Decode(input) {
  const cleanInput = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < cleanInput.length; i++) {
    const index = BASE32_ALPHABET.indexOf(cleanInput[i]);
    if (index === -1) continue;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * 生成 6 位 TOTP 动态验证码
 */
export function generateTOTP(secret, timeStep = 30, windowOffset = 0) {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / timeStep) + windowOffset;

  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(time, 4);

  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buffer);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

/**
 * 校验用户输入的 6 位 TOTP 验证码（允许 30s 误差窗口）
 */
export function verifyTOTP(token, secret) {
  if (!token || !secret) return false;
  const cleanToken = token.trim();

  // 允许 -1, 0, +1 步长偏差 (即前后 30 秒)
  for (let errorWindow = -1; errorWindow <= 1; errorWindow++) {
    const expected = generateTOTP(secret, 30, errorWindow);
    if (expected === cleanToken) {
      return true;
    }
  }
  return false;
}

/**
 * 随机生成全新的 2FA 密钥 (Base32 编码)
 */
export function generateSecret() {
  const buffer = crypto.randomBytes(20);
  return base32Encode(buffer);
}

/**
 * 生成 10 个 8 位的备用恢复码
 */
export function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex'); // 8位 hex 字符串
    codes.push(code);
  }
  return codes;
}

/**
 * 读取 2FA 配置文件
 */
export function get2FAConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    logger.error('读取 2FA 配置文件失败:', error.message);
  }
  return { enabled: false, secret: null, backupCodes: [] };
}

/**
 * 保存 2FA 配置文件
 */
export function save2FAConfig(data) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const current = get2FAConfig();
    const updated = { ...current, ...data, updatedAt: new Date().toISOString() };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf8');
    return true;
  } catch (error) {
    logger.error('保存 2FA 配置文件失败:', error.message);
    return false;
  }
}

/**
 * 使用并消耗一个备用恢复码
 */
export function consumeBackupCode(code) {
  const config = get2FAConfig();
  if (!config.enabled || !Array.isArray(config.backupCodes)) return false;

  const cleanCode = code.trim().toLowerCase();
  const index = config.backupCodes.findIndex(c => c.toLowerCase() === cleanCode);

  if (index !== -1) {
    config.backupCodes.splice(index, 1);
    save2FAConfig({ backupCodes: config.backupCodes });
    logger.info('已成功使用一次性 2FA 备用恢复码');
    return true;
  }

  return false;
}
