/**
 * 应用常量定义
 * @module constants
 */

// ==================== 缓存相关常量 ====================

/**
 * 文件缓存有效期（毫秒）
 * @type {number}
 */
export const FILE_CACHE_TTL = 5000;

/**
 * 文件保存延迟（毫秒）- 用于 debounce
 * @type {number}
 */
export const FILE_SAVE_DELAY = 1000;

/**
 * 额度缓存有效期（毫秒）- 5分钟
 * @type {number}
 */
export const QUOTA_CACHE_TTL = 5 * 60 * 1000;

/**
 * 额度清理间隔（毫秒）- 1小时
 * @type {number}
 */
export const QUOTA_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * 模型列表缓存默认有效期（毫秒）- 1小时
 * @type {number}
 */
export const MODEL_LIST_CACHE_TTL = 60 * 60 * 1000;

// ==================== 内存管理常量 ====================

/**
 * 默认内存清理间隔（毫秒）
 * 在该间隔内，即使处于 MEDIUM/HIGH，也不会重复触发清理回调，避免频繁扫描与释放带来的性能损耗。
 * @type {number}
 */
export const MEMORY_CLEANUP_INTERVAL = 30 * 60 * 1000;

// ==================== 服务器相关常量 ====================

/**
 * 默认心跳间隔（毫秒）
 * @type {number}
 */
export const DEFAULT_HEARTBEAT_INTERVAL = 15000;

/**
 * 默认服务器端口
 * @type {number}
 */
export const DEFAULT_SERVER_PORT = 443;

/**
 * 默认服务器主机
 * @type {string}
 */
export const DEFAULT_SERVER_HOST = '0.0.0.0';

/**
 * 默认请求超时（毫秒）
 * @type {number}
 */
export const DEFAULT_TIMEOUT = 300000;

/**
 * 默认重试次数
 * @type {number}
 */
export const DEFAULT_RETRY_TIMES = 3;

/**
 * 默认固定重试间隔（毫秒）
 * 503 直接按固定间隔重试；429 只有在上游响应体提供等待间隔/恢复时间时才会重试。
 * @type {number}
 */
export const DEFAULT_RETRY_INTERVAL_MS = 10000;

/**
 * 默认最大请求体大小
 * @type {string}
 */
export const DEFAULT_MAX_REQUEST_SIZE = '50mb';

// ==================== Token 轮询相关常量 ====================

/**
 * 默认每个 Token 请求次数后切换
 * @type {number}
 */
export const DEFAULT_REQUEST_COUNT_PER_TOKEN = 50;

/**
 * Token 过期提前刷新时间（毫秒）- 5分钟
 * @type {number}
 */
export const TOKEN_REFRESH_BUFFER = 300000;

/**
 * 长时间冷却阈值（毫秒）- 1小时
 * 当 429 恢复时间超过此值时，触发模型系列级别的禁用
 * @type {number}
 */
export const LONG_COOLDOWN_THRESHOLD = 60 * 60 * 1000;

/**
 * 短冷却阈值（毫秒）- 3秒
 * 当 429 恢复时间在此值与 LONG_COOLDOWN_THRESHOLD 之间时，
 * 对当前 token+modelId 设置冷却，然后终止重试让上层换 token
 * @type {number}
 */
export const SHORT_COOLDOWN_THRESHOLD = 3000;

// ==================== 生成参数默认值 ====================

/**
 * 默认生成参数
 */
export const DEFAULT_GENERATION_PARAMS = {
  temperature: 1,
  top_p: 0.85,
  top_k: 50,
  max_tokens: 32000,
  thinking_budget: 1024
};

/**
 * reasoning_effort 到 thinkingBudget 的映射
 */
export const REASONING_EFFORT_MAP = {
  low: 1024,
  medium: 16000,
  high: 32000
};

// ==================== 图片相关常量 ====================

/**
 * 默认最大保留图片数量
 * @type {number}
 */
export const DEFAULT_MAX_IMAGES = 10;

/**
 * MIME 类型到文件扩展名映射
 */
export const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

// ==================== 停止序列 ====================

/**
 * 默认停止序列
 * @type {string[]}
 */
export const DEFAULT_STOP_SEQUENCES = [
  '<|user|>',
  '<|bot|>',
  '<|context_request|>',
  '<|endoftext|>',
  '<|end_of_turn|>'
];

export const QA_PAIRS = [
    {
        question: "如何在 Express 中实现 JWT 认证?",
        answer: "我可以帮你实现 JWT 认证。首先需要安装 jsonwebtoken 包，然后创建中间件来验证 token。我会为你创建一个完整的认证模块。"
    },
    {
        question: "这个 API 接口返回 500 错误，帮我看看是什么问题",
        answer: "让我检查一下错误日志和相关代码。通常 500 错误是服务器端的问题，可能是未捕获的异常或数据库连接问题。"
    },
    {
        question: "如何优化这段代码的性能?",
        answer: "我会分析这段代码的性能瓶颈。常见的优化方向包括：减少循环嵌套、使用缓存、异步处理、数据库查询优化等。让我具体看看你的代码。"
    },
    {
        question: "帮我写一个 Redis 缓存工具类",
        answer: "好的，我会创建一个 Redis 缓存工具类，包含 get、set、delete 等基本方法，以及支持过期时间设置和批量操作。"
    },
    {
        question: "这个函数的逻辑有问题，总是返回 undefined",
        answer: "让我检查一下函数的返回值。常见原因包括：忘记 return 语句、异步函数未正确处理、条件判断错误等。我会帮你定位问题。"
    },
    {
        question: "如何实现文件上传功能?",
        answer: "我会帮你实现文件上传功能。使用 multer 中间件可以轻松处理文件上传，包括文件大小限制、类型验证、存储路径配置等。"
    },
    {
        question: "数据库连接池应该如何配置?",
        answer: "数据库连接池的配置需要根据实际负载调整。我会为你创建一个合理的配置，包括最大连接数、最小连接数、超时时间等参数。"
    },
    {
        question: "如何处理跨域问题?",
        answer: "跨域问题可以通过配置 CORS 中间件解决。我会帮你设置合适的 CORS 策略，包括允许的源、方法、请求头等。"
    },
    {
        question: "这个异步函数没有正确等待结果",
        answer: "异步处理需要正确使用 async/await 或 Promise。让我检查你的代码，确保所有异步操作都被正确等待。"
    },
    {
        question: "如何实现 API 请求限流?",
        answer: "我会帮你实现 API 限流功能。可以使用 express-rate-limit 中间件，或者基于 Redis 实现更灵活的限流策略。"
    },
    {
        question: "内存占用太高了，如何优化?",
        answer: "内存优化需要从多个方面入手：对象池复用、及时释放资源、避免内存泄漏、使用流式处理大数据等。让我分析你的代码。"
    },
    {
        question: "如何实现 WebSocket 实时通信?",
        answer: "我会帮你实现 WebSocket 功能。使用 ws 或 socket.io 库可以轻松实现双向实时通信，包括连接管理、消息广播等。"
    }
];

// ==================== 管理员默认配置 ====================

// 注意：管理员凭据（用户名、密码、JWT密钥）现在由 config.js 自动生成随机值
// 如果用户未配置，启动时会在控制台显示生成的凭据
// 不再使用硬编码的默认值，提高安全性
