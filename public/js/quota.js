// 额度管理：查看、刷新、缓存

let currentQuotaToken = null;

const quotaCache = {
    data: {},
    ttl: 5 * 60 * 1000,
    maxSize: 50, // 最大缓存条目数
    cleanupTimer: null,

    get(tokenId) {
        const cached = this.data[tokenId];
        if (!cached) return null;
        if (Date.now() - cached.timestamp > this.ttl) {
            delete this.data[tokenId];
            return null;
        }
        return cached.data;
    },

    set(tokenId, data) {
        // 检查缓存大小，超出时清理最旧的条目
        const keys = Object.keys(this.data);
        if (keys.length >= this.maxSize) {
            this._evictOldest(Math.ceil(this.maxSize * 0.2)); // 清理20%
        }
        this.data[tokenId] = { data, timestamp: Date.now() };
    },

    clear(tokenId) {
        if (tokenId) {
            delete this.data[tokenId];
        } else {
            this.data = {};
        }
    },

    // 清理过期缓存
    cleanup() {
        const now = Date.now();
        const keys = Object.keys(this.data);
        let cleaned = 0;
        for (const key of keys) {
            if (now - this.data[key].timestamp > this.ttl) {
                delete this.data[key];
                cleaned++;
            }
        }
        return cleaned;
    },

    // 清理最旧的 n 个条目
    _evictOldest(n) {
        const entries = Object.entries(this.data)
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < Math.min(n, entries.length); i++) {
            delete this.data[entries[i][0]];
        }
    },

    // 启动定期清理
    startCleanupTimer() {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, 60 * 1000); // 每分钟清理一次过期缓存
    },

    // 停止定期清理
    stopCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    },

    // 获取缓存统计信息
    getStats() {
        return {
            size: Object.keys(this.data).length,
            maxSize: this.maxSize
        };
    }
};

// 页面加载时启动缓存清理定时器
if (typeof document !== 'undefined') {
    quotaCache.startCleanupTimer();

    // 页面卸载时清理
    window.addEventListener('beforeunload', () => {
        quotaCache.stopCleanupTimer();
        quotaCache.clear();
    });
}

const QUOTA_GROUPS = [
    {
        key: 'claude',
        label: 'Claude',
        iconSrc: '/assets/icons/claude.svg',
        match: (modelId) => modelId.toLowerCase().includes('claude') || modelId.toLowerCase().includes('gpt')
    },
    {
        key: 'gemini',
        label: 'Gemini',
        iconSrc: '/assets/icons/gemini.svg',
        match: (modelId) => modelId.toLowerCase().includes('gemini') || modelId.toLowerCase().includes('publishers/google/')
    },
    {
        key: 'other',
        label: '其他',
        iconSrc: '',
        match: () => true
    }
];

const QUOTA_SUMMARY_KEYS = ['claude', 'gemini'];

function getGroupIconHtml(group) {
    const src = group?.iconSrc || '';
    const alt = escapeHtml(group?.label || '');
    const safeSrc = escapeHtml(src);
    if (!safeSrc) return '';
    return `<img class="quota-icon-img" src="${safeSrc}" alt="${alt}" loading="lazy" decoding="async">`;
}

function clamp01(value) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return 0;
    return Math.min(1, Math.max(0, numberValue));
}

function toPercentage(fraction01) {
    return clamp01(fraction01) * 100;
}

function formatPercentage(fraction01) {
    return `${toPercentage(fraction01).toFixed(2)}%`;
}

function getBarColor(percentage) {
    if (percentage > 50) return '#10b981';
    if (percentage > 20) return '#f59e0b';
    return '#ef4444';
}

function groupModels(models) {
    const grouped = { claude: [], gemini: [], banana: [], other: [] };

    Object.entries(models || {}).forEach(([modelId, quota]) => {
        const groupKey = (QUOTA_GROUPS.find(g => g.match(modelId)) || QUOTA_GROUPS[QUOTA_GROUPS.length - 1]).key;
        if (!grouped[groupKey]) grouped[groupKey] = [];
        grouped[groupKey].push({ modelId, quota });
    });

    return grouped;
}

// 不同模型系列的每次请求消耗百分比（与后端 GROUP_COST_PERCENT 保持一致）
const GROUP_COST_PERCENT = {
    claude: 0.6667,
    gemini: 0.6667,
    other: 0.6667
};

function formatTimeCountdown(resetTimeRaw, resetTimeText) {
    if (!resetTimeRaw && !resetTimeText) return '--';

    let targetMs = null;
    let localFormatted = '';

    if (resetTimeRaw) {
        const ms = Date.parse(resetTimeRaw);
        if (Number.isFinite(ms)) {
            targetMs = ms;
            const date = new Date(ms);
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            const h = String(date.getHours()).padStart(2, '0');
            const min = String(date.getMinutes()).padStart(2, '0');
            localFormatted = `${m}/${d} ${h}:${min}`;
        }
    }

    if (!targetMs && resetTimeText) {
        const match = resetTimeText.match(/(\d{2})[-/](\d{2})\s+(\d{2}):(\d{2})/);
        if (match) {
            const [, mStr, dStr, hStr, minStr] = match;
            const now = new Date();
            let year = now.getFullYear();
            const month = parseInt(mStr, 10) - 1;
            const day = parseInt(dStr, 10);
            const hour = parseInt(hStr, 10);
            const minute = parseInt(minStr, 10);

            let targetDate = new Date(year, month, day, hour, minute);
            if (targetDate.getTime() - now.getTime() < -86400000) {
                targetDate = new Date(year + 1, month, day, hour, minute);
            }
            targetMs = targetDate.getTime();
            localFormatted = `${mStr}/${dStr} ${hStr}:${minStr}`;
        }
    }

    if (!targetMs) return resetTimeText || '--';

    const diffMs = targetMs - Date.now();
    if (diffMs <= 0) {
        return `已重置 (${localFormatted})`;
    }

    const totalSec = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);

    let cd = '';
    if (days > 0) {
        cd = `${days}d ${hours}h`;
    } else if (hours > 0) {
        cd = `${hours}h ${mins}m`;
    } else {
        cd = `${mins}m`;
    }

    return `${cd} (${localFormatted})`;
}

function summarizeGroup(items, requestCount = 0, groupKey = null) {
    if (!items || items.length === 0) {
        return {
            percentage: 0,
            percentageText: '--',
            resetTime: '--',
            resetTimeRaw: null,
            estimatedRequests: 0,
            weeklyPercentage: null,
            weeklyPercentageText: null,
            weeklyResetTime: null,
            weeklyResetTimeRaw: null
        };
    }

    let minRemaining = 1;
    let earliestResetMs = null;
    let earliestResetText = null;
    let earliestResetRaw = null;

    let minWeeklyRemaining = null;
    let earliestWeeklyResetMs = null;
    let earliestWeeklyResetText = null;
    let earliestWeeklyResetRaw = null;

    items.forEach(({ quota }) => {
        const remaining = clamp01(quota?.remaining);
        if (remaining < minRemaining) minRemaining = remaining;

        const resetRaw = quota?.resetTimeRaw;
        const resetText = quota?.resetTime;

        if (resetRaw) {
            const ms = Date.parse(resetRaw);
            if (Number.isFinite(ms) && (earliestResetMs === null || ms < earliestResetMs)) {
                earliestResetMs = ms;
                earliestResetText = resetText || null;
                earliestResetRaw = resetRaw;
            }
        } else if (!earliestResetText && resetText) {
            earliestResetText = resetText;
        }

        if (quota?.weeklyRemaining !== null && quota?.weeklyRemaining !== undefined) {
            const wRemaining = clamp01(quota.weeklyRemaining);
            if (minWeeklyRemaining === null || wRemaining < minWeeklyRemaining) {
                minWeeklyRemaining = wRemaining;
            }

            const wResetRaw = quota.weeklyResetTimeRaw;
            const wResetText = quota.weeklyResetTime;

            if (wResetRaw) {
                const ms = Date.parse(wResetRaw);
                if (Number.isFinite(ms) && (earliestWeeklyResetMs === null || ms < earliestWeeklyResetMs)) {
                    earliestWeeklyResetMs = ms;
                    earliestWeeklyResetText = wResetText || null;
                    earliestWeeklyResetRaw = wResetRaw;
                }
            } else if (!earliestWeeklyResetText && wResetText) {
                earliestWeeklyResetText = wResetText;
            }
        }
    });

    // 根据模型系列使用不同的消耗率
    const costPercent = (groupKey && GROUP_COST_PERCENT[groupKey]) || 0.6667;
    // 基于当前阈值计算总的可用次数，然后减去已记录的请求次数
    const percentageValue = toPercentage(minRemaining);
    const totalFromThreshold = Math.floor(percentageValue / costPercent);
    const estimatedRequests = Math.max(0, totalFromThreshold - requestCount);

    return {
        percentage: percentageValue,
        percentageText: formatPercentage(minRemaining),
        resetTime: earliestResetText || '--',
        resetTimeRaw: earliestResetRaw || null,
        estimatedRequests,
        weeklyPercentage: minWeeklyRemaining !== null ? toPercentage(minWeeklyRemaining) : null,
        weeklyPercentageText: minWeeklyRemaining !== null ? formatPercentage(minWeeklyRemaining) : null,
        weeklyResetTime: earliestWeeklyResetText || null,
        weeklyResetTimeRaw: earliestWeeklyResetRaw || null
    };
}

function syncTokenMetaFromQuotaData(tokenId, quotaData) {
    const tokenMeta = quotaData?.tokenMeta;
    if (!tokenMeta || !Array.isArray(cachedTokens)) {
        return;
    }

    const token = cachedTokens.find(item => item.id === tokenId);
    if (!token) {
        return;
    }

    token.sub = tokenMeta.sub ?? token.sub ?? null;
    token.credits = tokenMeta.credits ?? null;

    updateTokenCardMeta(tokenId, token);
}

function updateTokenCardMeta(tokenId, token) {
    const cardId = tokenId.substring(0, 8);
    const card = document.getElementById(`card-${cardId}`);
    if (!card) return;

    const headerLeft = card.querySelector('.token-header-left');
    if (!headerLeft) return;

    const refreshBtn = headerLeft.querySelector('.token-refresh-btn');
    let subEl = headerLeft.querySelector('.status-subscription');
    if (token.sub) {
        if (!subEl) {
            subEl = document.createElement('span');
            if (refreshBtn) {
                headerLeft.insertBefore(subEl, refreshBtn);
            } else {
                headerLeft.appendChild(subEl);
            }
        }
        subEl.className = `status-subscription subscription-badge ${token.sub === 'free-tier' ? 'free-tier' : 'paid-tier'}`;
        subEl.title = token.sub;
        subEl.textContent = formatSubTier(token.sub);
    } else if (subEl) {
        subEl.remove();
    }
}

// 使用 tokenId 加载额度摘要
async function loadTokenQuotaSummary(tokenId) {
    const cardId = tokenId.substring(0, 8);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);
    if (!summaryEl) return;

    const cached = quotaCache.get(tokenId);
    if (cached) {
        renderQuotaSummary(summaryEl, cached);
        return;
    }

    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas`);
        const data = await response.json();

        if (data.success && data.data && data.data.models) {
            quotaCache.set(tokenId, data.data);
            renderQuotaSummary(summaryEl, data.data);
        } else if (data.success && data.data) {
            // 禁用的 token 可能返回空数据
            renderQuotaSummary(summaryEl, data.data);
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 ${errMsg}</span>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            console.error('加载额度摘要失败:', error);
            summaryEl.innerHTML = `<span class="quota-summary-error">📊 加载失败</span>`;
        }
    }
}

function renderQuotaSummary(summaryEl, quotaData) {
    const models = quotaData.models;
    const requestCounts = quotaData.requestCounts || {};
    const modelEntries = Object.entries(models || {});

    if (modelEntries.length === 0) {
        summaryEl.textContent = '📊 暂无额度';
        return;
    }

    const grouped = groupModels(models);
    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));

    const columnsHtml = QUOTA_SUMMARY_KEYS.map((groupKey) => {
        const group = groupByKey[groupKey];
        const summary = summarizeGroup(grouped[groupKey], requestCounts[groupKey] || 0, groupKey);

        const dailyBarColor = summary.percentageText === '--' ? '#9ca3af' : getBarColor(summary.percentage);
        const hasWeekly = summary.weeklyPercentage !== null;
        const weeklyBarColor = hasWeekly ? getBarColor(summary.weeklyPercentage) : '#9ca3af';

        const dailyCountdown = formatTimeCountdown(summary.resetTimeRaw, summary.resetTime);
        const weeklyCountdown = hasWeekly ? formatTimeCountdown(summary.weeklyResetTimeRaw, summary.weeklyResetTime) : '--';

        const safeLabel = escapeHtml(group?.label || groupKey);
        const title = `${group?.label || groupKey} - 5h: ${summary.percentageText} (${dailyCountdown}) | 周额度: ${summary.weeklyPercentageText || '--'} (${weeklyCountdown})`;

        return `
            <div class="quota-cockpit-col" title="${escapeHtml(title)}">
                <div class="quota-cockpit-header">
                    <span class="quota-cockpit-icon">${getGroupIconHtml(group)}</span>
                    <span class="quota-cockpit-title">${safeLabel}</span>
                </div>

                <div class="quota-cockpit-item">
                    <div class="quota-cockpit-meta">
                        <span class="quota-cockpit-tag">5h</span>
                        <span class="quota-cockpit-pct">${summary.percentageText}</span>
                    </div>
                    <div class="quota-cockpit-bar"><span style="width:${summary.percentage}%;background:${dailyBarColor}"></span></div>
                    <div class="quota-cockpit-time">${escapeHtml(dailyCountdown)}</div>
                </div>

                <div class="quota-cockpit-item">
                    <div class="quota-cockpit-meta">
                        <span class="quota-cockpit-tag">Weekly</span>
                        <span class="quota-cockpit-pct">${summary.weeklyPercentageText || '--'}</span>
                    </div>
                    <div class="quota-cockpit-bar"><span style="width:${summary.weeklyPercentage || 0}%;background:${weeklyBarColor}"></span></div>
                    <div class="quota-cockpit-time">${escapeHtml(weeklyCountdown)}</div>
                </div>
            </div>
        `;
    }).join('');

    summaryEl.innerHTML = `
        <div class="quota-cockpit-grid">
            ${columnsHtml}
        </div>
    `;
}

async function toggleQuotaExpand(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const toggleEl = document.getElementById(`quota-toggle-${cardId}`);
    if (!detailEl) return;

    const isHidden = detailEl.classList.contains('hidden');

    if (isHidden) {
        detailEl.classList.remove('hidden');
        detailEl.classList.remove('collapsing');
        if (toggleEl) toggleEl.classList.add('expanded');

        if (!detailEl.dataset.loaded) {
            detailEl.innerHTML = '<div class="quota-loading-small">加载中...</div>';
            await loadQuotaDetail(cardId, tokenId);
            detailEl.dataset.loaded = 'true';
        }
    } else {
        // 添加收起动画
        detailEl.classList.add('collapsing');
        if (toggleEl) toggleEl.classList.remove('expanded');

        // 动画结束后隐藏
        setTimeout(() => {
            detailEl.classList.add('hidden');
            detailEl.classList.remove('collapsing');
        }, 200);
    }
}

async function loadQuotaDetail(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    if (!detailEl) return;

    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas`);
        const data = await response.json();

        if (data.success && data.data && data.data.models) {
            const models = data.data.models;
            const modelEntries = Object.entries(models);

            if (modelEntries.length === 0) {
                detailEl.innerHTML = '<div class="quota-empty-small">暂无额度信息</div>';
                return;
            }

            const grouped = groupModels(models);

            let html = '<div class="quota-detail-grid">';

            const renderGroup = (items, icon) => {
                if (items.length === 0) return '';
                let groupHtml = '';
                items.forEach(({ modelId, quota }) => {
                    const percentage = toPercentage(quota?.remaining);
                    const percentageText = formatPercentage(quota?.remaining);
                    const barColor = getBarColor(percentage);
                    const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', '').split('/').pop());
                    const safeModelId = escapeHtml(modelId);
                    const safeResetTime = escapeHtml(quota.resetTime);
                    const weeklyText = quota.weeklyRemaining !== null && quota.weeklyRemaining !== undefined
                        ? ` · 周:${formatPercentage(quota.weeklyRemaining)}`
                        : '';
                    groupHtml += `
                        <div class="quota-detail-row" title="${safeModelId} - 重置: ${safeResetTime}${quota.weeklyResetTime ? ' - 周重置: ' + escapeHtml(quota.weeklyResetTime) : ''}">
                            <span class="quota-detail-icon">${icon}</span>
                            <span class="quota-detail-name">${shortName}</span>
                            <span class="quota-detail-bar"><span style="width:${percentage}%;background:${barColor}"></span></span>
                            <span class="quota-detail-pct">${percentageText}${weeklyText}</span>
                        </div>
                    `;
                });
                return groupHtml;
            };

            const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
            html += renderGroup(grouped.claude, getGroupIconHtml(groupByKey.claude));
            html += renderGroup(grouped.gemini, getGroupIconHtml(groupByKey.gemini));
            html += renderGroup(grouped.other, '');
            html += '</div>';
            html += `<button class="btn btn-info btn-xs quota-refresh-btn" onclick="refreshInlineQuota('${escapeJs(cardId)}', '${escapeJs(tokenId)}')">🔄 刷新额度</button>`;

            detailEl.innerHTML = html;
        } else {
            const errMsg = escapeHtml(data.message || '未知错误');
            detailEl.innerHTML = `<div class="quota-error-small">加载失败: ${errMsg}</div>`;
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
            detailEl.innerHTML = `<div class="quota-error-small">网络错误</div>`;
        }
    }
}

async function refreshInlineQuota(cardId, tokenId) {
    const detailEl = document.getElementById(`quota-detail-${cardId}`);
    const summaryEl = document.getElementById(`quota-summary-${cardId}`);

    if (detailEl) detailEl.innerHTML = '<div class="quota-loading-small">刷新中...</div>';
    if (summaryEl) summaryEl.textContent = '📊 刷新中...';

    quotaCache.clear(tokenId);

    try {
        const response = await authFetch(`/admin/tokens/${encodeURIComponent(tokenId)}/quotas?refresh=true`);
        const data = await response.json();
        if (data.success && data.data) {
            quotaCache.set(tokenId, data.data);
            syncTokenMetaFromQuotaData(tokenId, data.data);
        }
    } catch (e) { }

    await loadTokenQuotaSummary(tokenId);
    await loadQuotaDetail(cardId, tokenId);
}

// 存储当前弹窗的事件处理器引用，便于清理
let quotaModalWheelHandler = null;

async function showQuotaModal(tokenId) {
    currentQuotaToken = tokenId;

    const activeIndex = cachedTokens.findIndex(t => t.id === tokenId);

    const emailTabs = cachedTokens.map((t, index) => {
        const email = t.email || '未知';
        const shortEmail = email.length > 20 ? email.substring(0, 17) + '...' : email;
        const isActive = index === activeIndex;
        const safeEmail = escapeHtml(email);
        const safeShortEmail = escapeHtml(shortEmail);
        return `<button type="button" class="quota-tab${isActive ? ' active' : ''}" data-index="${index}" onclick="switchQuotaAccountByIndex(${index})" title="${safeEmail}">${safeShortEmail}</button>`;
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'quotaModal';
    modal.innerHTML = `
        <div class="modal-content modal-xl">
            <div class="quota-modal-header">
                <div class="modal-title">📊 模型额度</div>
                <div class="quota-update-time" id="quotaUpdateTime"></div>
            </div>
            <div class="quota-tabs" id="quotaEmailList">
                ${emailTabs}
            </div>
            <div id="quotaContent" class="quota-container">
                <div class="quota-loading">加载中...</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary btn-sm" onclick="closeQuotaModal()">关闭</button>
                <button class="btn btn-info btn-sm" id="quotaRefreshBtn" onclick="refreshQuotaData()">🔄 刷新</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // 关闭弹窗时清理事件监听器
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeQuotaModal();
        }
    };

    await loadQuotaData(tokenId);

    const tabsContainer = document.getElementById('quotaEmailList');
    if (tabsContainer) {
        // 创建事件处理器并保存引用
        quotaModalWheelHandler = (e) => {
            if (e.deltaY !== 0) {
                e.preventDefault();
                tabsContainer.scrollLeft += e.deltaY;
            }
        };
        tabsContainer.addEventListener('wheel', quotaModalWheelHandler, { passive: false });
    }
}

// 关闭额度弹窗并清理事件监听器
function closeQuotaModal() {
    const modal = document.getElementById('quotaModal');

    // 清理滚轮事件监听器
    if (quotaModalWheelHandler) {
        const tabsContainer = document.getElementById('quotaEmailList');
        if (tabsContainer) {
            tabsContainer.removeEventListener('wheel', quotaModalWheelHandler);
        }
        quotaModalWheelHandler = null;
    }

    if (modal) {
        modal.remove();
    }

    currentQuotaToken = null;
}

async function switchQuotaAccountByIndex(index) {
    if (index < 0 || index >= cachedTokens.length) return;

    const token = cachedTokens[index];
    currentQuotaToken = token.id;

    document.querySelectorAll('.quota-tab').forEach((tab, i) => {
        if (i === index) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    await loadQuotaData(token.id);
}

async function switchQuotaAccount(tokenId) {
    const index = cachedTokens.findIndex(t => t.id === tokenId);
    if (index >= 0) {
        await switchQuotaAccountByIndex(index);
    }
}

async function loadQuotaData(tokenId, forceRefresh = false) {
    const quotaContent = document.getElementById('quotaContent');
    if (!quotaContent) return;

    const refreshBtn = document.getElementById('quotaRefreshBtn');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 加载中...';
    }

    if (!forceRefresh) {
        const cached = quotaCache.get(tokenId);
        if (cached) {
            renderQuotaModal(quotaContent, cached);
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 刷新';
            }
            return;
        }
    } else {
        quotaCache.clear(tokenId);
    }

    quotaContent.innerHTML = '<div class="quota-loading">加载中...</div>';

    try {
        const url = `/admin/tokens/${encodeURIComponent(tokenId)}/quotas${forceRefresh ? '?refresh=true' : ''}`;
        const response = await authFetch(url);

        const data = await response.json();

        if (data.success) {
            quotaCache.set(tokenId, data.data);
            if (forceRefresh) {
                syncTokenMetaFromQuotaData(tokenId, data.data);
            }
            renderQuotaModal(quotaContent, data.data);
        } else {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(data.message)}</div>`;
        }
    } catch (error) {
        if (quotaContent) {
            quotaContent.innerHTML = `<div class="quota-error">加载失败: ${escapeHtml(error.message)}</div>`;
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 刷新';
        }
    }
}

async function refreshQuotaData() {
    if (currentQuotaToken) {
        await loadQuotaData(currentQuotaToken, true);
    }
}

// 刷新所有 Token 的额度数据
async function refreshAllQuotas() {
    if (!cachedTokens || cachedTokens.length === 0) {
        showToast('没有可刷新的 Token', 'warning');
        return;
    }

    // 过滤出启用的 token，禁用的不刷新
    const enabledTokens = cachedTokens.filter(t => t.enable !== false);
    if (enabledTokens.length === 0) {
        showToast('没有已启用的 Token 可刷新', 'warning');
        return;
    }

    const btn = document.getElementById('refreshQuotasBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 刷新中...';
    }

    // 只清除启用 token 的缓存
    enabledTokens.forEach(t => quotaCache.clear(t.id));

    try {
        // 并行刷新已启用 Token 的额度
        const refreshPromises = enabledTokens.map(async (token) => {
            try {
                const response = await authFetch(`/admin/tokens/${encodeURIComponent(token.id)}/quotas?refresh=true`);
                const data = await response.json();
                if (data.success && data.data) {
                    quotaCache.set(token.id, data.data);
                    syncTokenMetaFromQuotaData(token.id, data.data);
                }
            } catch (e) {
                // 单个 Token 刷新失败不影响其他
                console.error(`刷新 Token ${token.email || token.id.substring(0, 8)} 额度失败:`, e);
            }
        });

        await Promise.all(refreshPromises);
        await loadTokens();

        if (currentQuotaToken) {
            await loadQuotaData(currentQuotaToken);
        }

        showToast(`已刷新 ${enabledTokens.length} 个 Token 的额度和积分`, 'success');
    } catch (error) {
        showToast('刷新额度失败: ' + error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📊 刷新额度';
        }
    }
}

function renderQuotaModal(quotaContent, quotaData) {
    const models = quotaData.models;
    const requestCounts = quotaData.requestCounts || {};

    const updateTimeEl = document.getElementById('quotaUpdateTime');
    if (updateTimeEl && quotaData.lastUpdated) {
        const lastUpdated = new Date(quotaData.lastUpdated).toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        updateTimeEl.textContent = `更新于 ${lastUpdated}`;
    }

    if (Object.keys(models).length === 0) {
        quotaContent.innerHTML = '<div class="quota-empty">暂无额度信息</div>';
        return;
    }

    const grouped = groupModels(models);

    let html = '';

        const renderGroup = (items, group, groupKey) => {
            const summary = summarizeGroup(items, requestCounts[groupKey] || 0, groupKey);
            const safeLabel = escapeHtml(group.label);
            const safeResetTime = escapeHtml(summary.resetTime);
            const safeWeeklyReset = summary.weeklyResetTime ? escapeHtml(summary.weeklyResetTime) : null;
            const resetMetaText = safeWeeklyReset ? `日:${safeResetTime} · 周:${safeWeeklyReset}` : `日重置: ${safeResetTime}`;
            const estimatedText = summary.estimatedRequests > 0 ? ` · 约${summary.estimatedRequests}次` : '';
            const iconHtml = getGroupIconHtml(group);
            let groupHtml = `
                <div class="quota-group-title">
                    <span class="quota-group-left">
                        <span class="quota-group-icon">${iconHtml}</span>
                        <span class="quota-group-label">${safeLabel}</span>
                    </span>
                    <span class="quota-group-meta">${escapeHtml(summary.percentageText)} · ${resetMetaText}${estimatedText}</span>
                </div>
            `;

        if (items.length === 0) {
            groupHtml += '<div class="quota-empty-small">暂无</div>';
            return groupHtml;
        }

        groupHtml += '<div class="quota-grid">';
        items.forEach(({ modelId, quota }) => {
            const percentage = toPercentage(quota?.remaining);
            const percentageText = formatPercentage(quota?.remaining);
            const barColor = getBarColor(percentage);
            const shortName = escapeHtml(modelId.replace('models/', '').replace('publishers/google/', ''));
            const safeModelId = escapeHtml(modelId);
            const safeResetTime = escapeHtml(quota.resetTime);

            const hasWeekly = quota.weeklyRemaining !== null && quota.weeklyRemaining !== undefined;
            const weeklyPercentage = hasWeekly ? toPercentage(quota.weeklyRemaining) : 0;
            const weeklyPercentageText = hasWeekly ? formatPercentage(quota.weeklyRemaining) : null;
            const weeklyBarColor = hasWeekly ? getBarColor(weeklyPercentage) : '#9ca3af';
            const safeWeeklyResetTime = quota.weeklyResetTime ? escapeHtml(quota.weeklyResetTime) : null;

            const weeklyHtml = hasWeekly ? `
                <div class="quota-weekly-section" style="margin-top: 0.375rem; pt: 0.25rem; border-top: 1px dashed var(--border);">
                    <div class="quota-bar-container" style="height: 4px; background: rgba(0,0,0,0.06);">
                        <div class="quota-bar" style="width: ${weeklyPercentage}%; background: ${weeklyBarColor};"></div>
                    </div>
                    <div class="quota-info-row" style="font-size: 0.7rem; opacity: 0.85; margin-top: 0.125rem;">
                        <span class="quota-reset">${safeWeeklyResetTime ? '周重置: ' + safeWeeklyResetTime : '周限额'}</span>
                        <span class="quota-percentage">${weeklyPercentageText}</span>
                    </div>
                </div>
            ` : '';

            groupHtml += `
                <div class="quota-item">
                    <div class="quota-model-name" title="${safeModelId}">
                        <span class="quota-model-icon">${iconHtml}</span>
                        <span class="quota-model-text">${shortName}</span>
                    </div>
                    <div class="quota-bar-container">
                        <div class="quota-bar" style="width: ${percentage}%; background: ${barColor};"></div>
                    </div>
                    <div class="quota-info-row">
                        <span class="quota-reset">重置: ${safeResetTime}</span>
                        <span class="quota-percentage">${percentageText}</span>
                    </div>
                    ${weeklyHtml}
                </div>
            `;
        });
        groupHtml += '</div>';
        return groupHtml;
    };

    const groupByKey = Object.fromEntries(QUOTA_GROUPS.map(g => [g.key, g]));
    html += renderGroup(grouped.claude, groupByKey.claude, 'claude');
    html += renderGroup(grouped.gemini, groupByKey.gemini, 'gemini');
    html += renderGroup(grouped.banana, groupByKey.banana, 'banana');
    if (grouped.other && grouped.other.length > 0) {
        html += renderGroup(grouped.other, groupByKey.other, 'other');
    }

    quotaContent.innerHTML = html;
}
