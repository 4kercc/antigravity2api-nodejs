// 日志管理模块

// 日志状态
let logsState = {
    logs: [],            // 当前页日志（最新在前）
    total: 0,            // 后端过滤后的日志总条数
    currentLevel: 'all',
    searchKeyword: '',
    pageSize: 100,       // 每页条数（固定 100 条最新，防止日志过多导致浏览器卡死）
    currentPage: 1,      // 当前页码（1 = 最新一页）
    autoRefresh: false,
    autoRefreshTimer: null,
    stats: { total: 0, info: 0, warn: 0, error: 0, request: 0, debug: 0 },
    // WebSocket 相关
    ws: null,
    wsConnected: false,
    wsReconnectTimer: null
};

// 计算总页数
function getLogTotalPages() {
    return Math.max(1, Math.ceil(logsState.total / logsState.pageSize));
}

// 加载当前页日志
async function loadLogs() {
    try {
        const offset = (logsState.currentPage - 1) * logsState.pageSize;

        const params = new URLSearchParams({
            level: logsState.currentLevel,
            search: logsState.searchKeyword,
            limit: logsState.pageSize,
            offset
        });

        const response = await fetch(`/admin/logs?${params}`, {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('获取日志失败');
        }

        const data = await response.json();
        if (data.success) {
            logsState.logs = data.data.logs || [];
            logsState.total = data.data.total || 0;

            // 当前页超出范围（例如日志被清空或筛选后变少）时，回退到最后一页
            const maxPage = getLogTotalPages();
            if (logsState.currentPage > maxPage) {
                logsState.currentPage = maxPage;
                return loadLogs();
            }

            renderLogs();
        }
    } catch (error) {
        console.error('加载日志失败:', error);
        showToast('加载日志失败: ' + error.message, 'error');
    }
}

// 加载日志统计
async function loadLogStats() {
    try {
        const response = await fetch('/admin/logs/stats', {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('获取日志统计失败');
        }

        const data = await response.json();
        if (data.success) {
            logsState.stats = data.data;
            renderLogStats();
        }
    } catch (error) {
        console.error('加载日志统计失败:', error);
    }
}

// 清空日志
async function clearLogs() {
    if (!confirm('确定要清空所有日志吗？此操作不可恢复。')) {
        return;
    }

    try {
        const response = await fetch('/admin/logs', {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();
        if (data.success) {
            showToast('日志已清空', 'success');
            logsState.logs = [];
            logsState.total = 0;
            logsState.currentPage = 1; // 清空后回到第 1 页，避免残留越界页码
            logsState.stats = { total: 0, info: 0, warn: 0, error: 0, request: 0, debug: 0 };
            renderLogs();
            renderLogStats();
        } else {
            showToast(data.message || '清空日志失败', 'error');
        }
    } catch (error) {
        console.error('清空日志失败:', error);
        showToast('清空日志失败: ' + error.message, 'error');
    }
}

// 筛选日志级别
function filterLogLevel(level) {
    logsState.currentLevel = level;
    logsState.currentPage = 1; // 筛选后回到最新一页

    // 更新统计项的激活状态
    renderLogStats();

    loadLogs();
}

// 搜索日志
function searchLogs(keyword) {
    logsState.searchKeyword = keyword;
    logsState.currentPage = 1; // 搜索后回到最新一页
    loadLogs();
}

// ==================== 日志分页 ====================

// 跳转到指定页
function goToLogPage(page) {
    const target = Math.min(Math.max(1, Number(page) || 1), getLogTotalPages());
    if (target === logsState.currentPage) return;

    logsState.currentPage = target;
    loadLogs();
}

// 回到最新一页（第 1 页）
function goToLatestLogs() {
    goToLogPage(1);
}

// 查看较新的一页（页码减 1）
function logsPrevPage() {
    goToLogPage(logsState.currentPage - 1);
}

// 查看较旧的一页（页码加 1）
function logsNextPage() {
    goToLogPage(logsState.currentPage + 1);
}

// 渲染分页栏
function renderLogPagination() {
    const bar = document.getElementById('logPagination');
    if (!bar) return;

    const totalPages = getLogTotalPages();

    // 防御：页码越界时自动夹紧，避免出现「第 53 / 1 页」这类异常显示
    if (logsState.currentPage > totalPages) logsState.currentPage = totalPages;
    if (logsState.currentPage < 1) logsState.currentPage = 1;

    const page = logsState.currentPage;
    const total = logsState.total;
    const start = total === 0 ? 0 : (page - 1) * logsState.pageSize + 1;
    const end = Math.min(page * logsState.pageSize, total);

    bar.innerHTML = `
        <button class="btn btn-sm btn-secondary" onclick="goToLatestLogs()" ${page <= 1 ? 'disabled' : ''} title="回到最新一页">⏮ 最新</button>
        <button class="btn btn-sm btn-secondary" onclick="logsPrevPage()" ${page <= 1 ? 'disabled' : ''} title="查看比当前更新的一页">◀ 较新</button>
        <span class="log-page-info">
            第 <b>${page}</b> / ${totalPages} 页 · 显示 ${start}-${end} 条 · 共 ${total} 条（每页 ${logsState.pageSize} 条）
        </span>
        <button class="btn btn-sm btn-secondary" onclick="logsNextPage()" ${page >= totalPages ? 'disabled' : ''} title="查看比当前更早的一页">较旧 ▶</button>
        ${page > 1 ? '<span class="log-page-hint">（第 1 页为最新日志，可点「⏮ 最新」返回）</span>' : ''}
    `;
}

// 切换自动刷新
function toggleAutoRefresh() {
    logsState.autoRefresh = !logsState.autoRefresh;
    const btn = document.getElementById('autoRefreshBtn');

    if (logsState.autoRefresh) {
        btn.classList.add('active');
        btn.innerHTML = '⏸️ 停止刷新';
        logsState.autoRefreshTimer = setInterval(() => {
            loadLogs();
            loadLogStats();
        }, 3000);
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '🔄 自动刷新';
        if (logsState.autoRefreshTimer) {
            clearInterval(logsState.autoRefreshTimer);
            logsState.autoRefreshTimer = null;
        }
    }
}

// 渲染日志统计
function renderLogStats() {
    const statsContainer = document.getElementById('logStats');
    if (!statsContainer) return;

    const currentLevel = logsState.currentLevel;

    statsContainer.innerHTML = `
        <div class="log-stat-item clickable ${currentLevel === 'all' ? 'active' : ''}" onclick="filterLogLevel('all')">
            <span class="log-stat-num">${logsState.stats.total}</span>
            <span class="log-stat-label">全部</span>
        </div>
        <div class="log-stat-item info clickable ${currentLevel === 'info' ? 'active' : ''}" onclick="filterLogLevel('info')">
            <span class="log-stat-num">${logsState.stats.info}</span>
            <span class="log-stat-label">信息</span>
        </div>
        <div class="log-stat-item debug clickable ${currentLevel === 'debug' ? 'active' : ''}" onclick="filterLogLevel('debug')">
            <span class="log-stat-num">${logsState.stats.debug}</span>
            <span class="log-stat-label">调试</span>
        </div>
        <div class="log-stat-item warn clickable ${currentLevel === 'warn' ? 'active' : ''}" onclick="filterLogLevel('warn')">
            <span class="log-stat-num">${logsState.stats.warn}</span>
            <span class="log-stat-label">警告</span>
        </div>
        <div class="log-stat-item error clickable ${currentLevel === 'error' ? 'active' : ''}" onclick="filterLogLevel('error')">
            <span class="log-stat-num">${logsState.stats.error}</span>
            <span class="log-stat-label">错误</span>
        </div>
        <div class="log-stat-item request clickable ${currentLevel === 'request' ? 'active' : ''}" onclick="filterLogLevel('request')">
            <span class="log-stat-num">${logsState.stats.request}</span>
            <span class="log-stat-label">请求</span>
        </div>
    `;
}

// 判断是否为分隔符行（只包含重复的特殊字符）
function isSeparatorLine(message) {
    if (!message || typeof message !== 'string') return false;
    // 去掉首尾空格后，判断是否只由重复的 = ─ ═ - * 等符号组成
    const trimmed = message.trim();
    if (trimmed.length < 3) return false;
    // 匹配只包含分隔符字符的行
    return /^[═─=\-*_~]+$/.test(trimmed);
}

// 复制日志内容
function copyLogContent(index, buttonElement) {
    // 从排序后的日志中获取原始消息
    const filteredLogs = logsState.logs.filter(log => !isSeparatorLine(log.message));
    const sortedLogs = [...filteredLogs].reverse();
    const log = sortedLogs[index];

    if (!log) {
        showToast('复制失败：日志不存在', 'error');
        return;
    }

    const plainText = log.message;

    navigator.clipboard.writeText(plainText).then(() => {
        // 显示复制成功反馈
        if (buttonElement) {
            const originalText = buttonElement.innerHTML;
            buttonElement.innerHTML = '✓';
            buttonElement.classList.add('copied');
            setTimeout(() => {
                buttonElement.innerHTML = originalText;
                buttonElement.classList.remove('copied');
            }, 1500);
        }
        showToast('已复制到剪贴板', 'success');
    }).catch(err => {
        console.error('复制失败:', err);
        showToast('复制失败', 'error');
    });
}

// 渲染日志列表
function renderLogs() {
    const container = document.getElementById('logList');
    if (!container) return;

    // 过滤掉分隔符行
    const filteredLogs = logsState.logs.filter(log => !isSeparatorLine(log.message));

    if (filteredLogs.length === 0) {
        container.innerHTML = `
            <div class="log-empty">
                <div class="log-empty-icon">📋</div>
                <div class="log-empty-text">暂无日志</div>
            </div>
        `;
        renderLogPagination();
        return;
    }

    // 日志按时间正序显示（旧的在上面，新的在下面）
    // logsState.logs 已经是倒序的（最新在前），需要反转
    const sortedLogs = [...filteredLogs].reverse();

    const logsHtml = sortedLogs.map((log, index) => {
        const levelClass = log.level;
        const levelIcon = {
            info: 'ℹ️',
            warn: '⚠️',
            error: '❌',
            request: '🌐',
            debug: '🔍'
        }[log.level] || '📝';

        const time = new Date(log.timestamp).toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        // 高亮 IP 和 Tokens 消费及渠道标识、账号标识（支持点击 IP 快捷加入黑名单）
        let message = escapeHtml(log.message);
        message = message.replace(/\[(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]/g, '<span onclick="quickBlockIP(\'$1\')" title="点击快捷封禁此 IP" style="background: rgba(99, 102, 241, 0.15); color: var(--primary, #4f46e5); padding: 1px 5px; border-radius: 4px; font-weight: bold; font-family: monospace; cursor: pointer; text-decoration: underline dotted;">[$1]</span>');
        message = message.replace(/\(IP:\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/g, '(IP: <span onclick="quickBlockIP(\'$1\')" title="点击快捷封禁此 IP" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; padding: 1px 5px; border-radius: 4px; font-weight: bold; font-family: monospace; cursor: pointer; text-decoration: underline dotted;">$1</span>)');
        message = message.replace(/\[渠道:\s*([^\]]+)\]/g, '<span style="background: rgba(245, 158, 11, 0.15); color: #d97706; padding: 1px 6px; border-radius: 4px; font-weight: bold; margin-left: 4px;">🔀 $1</span>');
        message = message.replace(/\[账号:\s*([^\]]+)\]/g, '<span style="background: rgba(14, 165, 233, 0.15); color: #0284c7; padding: 1px 6px; border-radius: 4px; font-weight: bold; margin-left: 4px;">👤 $1</span>');
        message = message.replace(/(\s\|\sTokens:\sIn\s\d+\s\/\sOut\s\d+\s\/\sTotal\s\d+)/g, '<span style="background: rgba(16, 185, 129, 0.15); color: #10b981; padding: 1px 5px; border-radius: 4px; font-weight: bold;">$1</span>');

        if (logsState.searchKeyword) {
            const regex = new RegExp(`(${escapeRegExp(logsState.searchKeyword)})`, 'gi');
            message = message.replace(regex, '<mark>$1</mark>');
        }

        return `
            <div class="log-item ${levelClass}" data-log-index="${index}">
                <div class="log-item-header">
                    <span class="log-level-icon">${levelIcon}</span>
                    <span class="log-level-tag ${levelClass}">${log.level.toUpperCase()}</span>
                    <span class="log-time">${time}</span>
                    <button class="log-copy-btn" onclick="copyLogContent(${index}, this)" title="复制日志内容">
                        📋
                    </button>
                </div>
                <div class="log-message">${message}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = logsHtml;

    // 滚动到底部（显示最新日志）
    container.scrollTop = container.scrollHeight;

    // 更新分页栏
    renderLogPagination();
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 正则转义
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 导出日志
function exportLogs() {
    if (logsState.logs.length === 0) {
        showToast('没有日志可导出', 'warning');
        return;
    }

    const content = logsState.logs.map(log => {
        const time = new Date(log.timestamp).toLocaleString('zh-CN', { hour12: false });
        return `[${time}] [${log.level.toUpperCase()}] ${log.message}`;
    }).join('\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('日志已导出', 'success');
}

// 连接 WebSocket
function connectLogWebSocket() {
    if (logsState.ws && logsState.ws.readyState === WebSocket.OPEN) {
        return; // 已连接
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/logs`;

    try {
        logsState.ws = new WebSocket(wsUrl);

        logsState.ws.onopen = () => {
            logsState.wsConnected = true;
            console.log('WebSocket 日志连接已建立');
            updateWsStatus(true);
        };

        logsState.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleWsMessage(data);
            } catch (e) {
                console.error('解析 WebSocket 消息失败:', e);
            }
        };

        logsState.ws.onclose = () => {
            logsState.wsConnected = false;
            console.log('WebSocket 日志连接已断开');
            updateWsStatus(false);
            // 5秒后重连
            if (!logsState.wsReconnectTimer) {
                logsState.wsReconnectTimer = setTimeout(() => {
                    logsState.wsReconnectTimer = null;
                    connectLogWebSocket();
                }, 5000);
            }
        };

        logsState.ws.onerror = (error) => {
            console.error('WebSocket 错误:', error);
            logsState.wsConnected = false;
            updateWsStatus(false);
            // 回退到 HTTP 加载
            loadLogs();
        };
    } catch (e) {
        console.error('创建 WebSocket 失败:', e);
        // 回退到 HTTP 加载
        loadLogs();
    }
}

// 处理 WebSocket 消息
function handleWsMessage(data) {
    switch (data.type) {
        case 'history':
            // 仅在尚未通过 HTTP 加载到分页数据时，才用 WebSocket 历史作为兜底
            // （已有分页数据时忽略，避免覆盖当前页内容）
            if (logsState.logs.length > 0) break;

            logsState.logs = data.logs.slice().reverse(); // 转为最新在前
            if (logsState.logs.length > logsState.pageSize) {
                logsState.logs = logsState.logs.slice(0, logsState.pageSize);
            }
            logsState.total = data.logs.length;
            // 说明：统计数字以 loadLogStats() 的服务端数据为准，这里不再用局部日志重算覆盖
            renderLogs();
            break;

        case 'log':
            // 接收新日志
            addNewLog(data.log);
            break;

        case 'clear':
            // 日志被清空
            logsState.logs = [];
            logsState.total = 0;
            logsState.stats = { total: 0, info: 0, warn: 0, error: 0, request: 0, debug: 0 };
            renderLogs();
            renderLogStats();
            break;
    }
}

// 添加新日志（WebSocket 实时推送）
function addNewLog(log) {
    // 插入到开头（最新的在前）
    logsState.logs.unshift(log);

    // 严格限制当前页最多保留 pageSize 条，避免内存无限增长
    while (logsState.logs.length > logsState.pageSize) {
        logsState.logs.pop();
    }

    // 更新统计（统计口径与后端一致：不包含分隔符行）
    if (!isSeparatorLine(log.message)) {
        logsState.total++;
        logsState.stats.total++;
        if (logsState.stats[log.level] !== undefined) {
            logsState.stats[log.level]++;
        }
        renderLogStats();
    }

    // 仅在“最新一页”做实时追加；浏览历史页时不打断用户视图，只更新页码信息
    if (logsState.currentPage !== 1) {
        renderLogPagination();
        return;
    }

    // 检查是否匹配当前筛选条件
    if (logsState.currentLevel !== 'all' && log.level !== logsState.currentLevel) {
        return; // 不匹配筛选条件，不添加到显示
    }

    if (logsState.searchKeyword && !log.message.toLowerCase().includes(logsState.searchKeyword.toLowerCase())) {
        return; // 不匹配搜索关键词
    }

    // 追加到 DOM（内部会自动裁剪超出每页条数的旧节点）
    appendLogToDOM(log);
    renderLogPagination();
}

// 追加单条日志到 DOM（增量渲染）
function appendLogToDOM(log) {
    const container = document.getElementById('logList');
    if (!container) return;

    // 检查是否有空状态提示，移除它
    const emptyState = container.querySelector('.log-empty');
    if (emptyState) {
        emptyState.remove();
    }

    const levelClass = log.level;
    const levelIcon = {
        info: 'ℹ️',
        warn: '⚠️',
        error: '❌',
        request: '🌐',
        debug: '🔍'
    }[log.level] || '📝';

    const time = new Date(log.timestamp).toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    let message = escapeHtml(log.message);
    if (logsState.searchKeyword) {
        const regex = new RegExp(`(${escapeRegExp(logsState.searchKeyword)})`, 'gi');
        message = message.replace(regex, '<mark>$1</mark>');
    }

    const logElement = document.createElement('div');
    logElement.className = `log-item ${levelClass}`;
    logElement.innerHTML = `
        <div class="log-item-header">
            <span class="log-level-icon">${levelIcon}</span>
            <span class="log-level-tag ${levelClass}">${log.level.toUpperCase()}</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="log-message">${message}</div>
    `;

    // 追加到底部
    container.appendChild(logElement);

    // 严格裁剪：DOM 中最多保留一页的条数，防止长时间运行后节点无限堆积导致浏览器卡死
    while (container.children.length > logsState.pageSize) {
        container.removeChild(container.firstElementChild);
    }

    // 滚动到底部
    container.scrollTop = container.scrollHeight;
}

// 更新统计
function updateStats() {
    const stats = { total: 0, info: 0, warn: 0, error: 0, request: 0, debug: 0 };
    for (const log of logsState.logs) {
        if (isSeparatorLine(log.message)) continue;
        stats.total++;
        if (stats[log.level] !== undefined) {
            stats[log.level]++;
        }
    }
    logsState.stats = stats;
    renderLogStats();
}

// 更新 WebSocket 连接状态显示
function updateWsStatus(connected) {
    const btn = document.getElementById('autoRefreshBtn');
    if (btn) {
        if (connected) {
            btn.innerHTML = '🟢 实时推送中';
            btn.classList.add('active');
            btn.disabled = true;
        } else {
            btn.innerHTML = '🔴 已断开';
            btn.classList.remove('active');
            btn.disabled = false;
        }
    }
}

// 断开 WebSocket
function disconnectLogWebSocket() {
    if (logsState.wsReconnectTimer) {
        clearTimeout(logsState.wsReconnectTimer);
        logsState.wsReconnectTimer = null;
    }

    if (logsState.ws) {
        logsState.ws.close();
        logsState.ws = null;
    }
    logsState.wsConnected = false;
}

// 初始化日志页面
function initLogsPage() {
    // 先通过 HTTP 加载当前页（分页数据的权威来源，每页 100 条最新日志）
    loadLogs();
    // 加载统计（始终需要）
    loadLogStats();
    // 再连接 WebSocket 接收实时增量推送（仅追加，不再重复拉取全量）
    connectLogWebSocket();
}

// 清理日志页面（切换离开时）
function cleanupLogsPage() {
    // 断开 WebSocket
    disconnectLogWebSocket();

    if (logsState.autoRefreshTimer) {
        clearInterval(logsState.autoRefreshTimer);
        logsState.autoRefreshTimer = null;
    }
    logsState.autoRefresh = false;

    // 清空日志数据释放内存
    logsState.logs = [];
    logsState.total = 0;
    logsState.currentPage = 1;

    // 清空 DOM 内容
    const container = document.getElementById('logList');
    if (container) {
        container.innerHTML = '';
    }
}
