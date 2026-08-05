/**
 * 日志工具模块
 * 支持控制台输出、WebSocket 实时推送、文件持久化
 */
import logWsServer from './logWsServer.js';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  blue: '\x1b[34m'
};

/**
 * 格式化日志参数为字符串
 */
function formatArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

function logMessage(level, ...args) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const color = { info: colors.green, warn: colors.yellow, error: colors.red, debug: colors.blue }[level];
  const message = formatArgs(args);

  // 输出到控制台
  console.log(`${colors.gray}${timestamp}${colors.reset} ${color}[${level}]${colors.reset}`, ...args);

  // 存储日志并推送 WebSocket
  logWsServer.storeLog(level, message);
}

function logRequest(method, path, status, duration, ip = '', tokenUsage = null) {
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  let ipStr = ip ? `[${ip}] ` : '';
  let usageStr = '';
  if (tokenUsage) {
    const input = tokenUsage.prompt_tokens || tokenUsage.input_tokens || tokenUsage.promptTokenCount || 0;
    const output = tokenUsage.completion_tokens || tokenUsage.output_tokens || tokenUsage.candidatesTokenCount || 0;
    const total = tokenUsage.total_tokens || tokenUsage.totalTokenCount || (input + output);
    usageStr = ` | Tokens: In ${input} / Out ${output} / Total ${total}`;
  }

  const message = `${ipStr}[${method}] - ${path} ${status} ${duration}ms${usageStr}`;

  // 输出到控制台
  console.log(`${colors.gray}${timestampStr()}${colors.reset} ${colors.cyan}[${method}]${colors.reset} ${ipStr}- ${path} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}${usageStr}`);

  // 存储日志（根据状态码决定级别）
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'request';
  logWsServer.storeLog(level, message);
}

function timestampStr() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export const log = {
  info: (...args) => logMessage('info', ...args),
  warn: (...args) => logMessage('warn', ...args),
  error: (...args) => logMessage('error', ...args),
  debug: (...args) => logMessage('debug', ...args),
  request: logRequest,
  // API 方法（委托给 logWsServer）
  getLogs: (options) => logWsServer.getLogs(options),
  clearLogs: () => logWsServer.clearLogs(),
  getLogStats: () => logWsServer.getLogStats()
};

export default log;
