// HTML 转义函数 - 防止 XSS 注入
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 转义用于 JavaScript 字符串的内容
function escapeJs(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

// 格式化订阅类型显示名称（把 API 原始 tier id 转成简短标签）
function formatSubTier(sub) {
    if (!sub) return '';
    const lower = sub.toLowerCase();
    if (lower === 'free-tier') return 'FREE';
    // g1-pro-tier / g1-pro → PRO
    if (lower.includes('pro')) return 'PRO';
    // g1-enterprise-tier → ENT
    if (lower.includes('enterprise')) return 'ENT';
    // 其他未知 tier，取中间段大写（去掉 g1- 前缀和 -tier 后缀）
    let display = sub.replace(/^g1-/i, '').replace(/-tier$/i, '');
    return display.toUpperCase();
}

// 格式化积分数值显示
function formatCredits(credits) {
    if (credits === null || credits === undefined) return '-';
    const num = Number(credits);
    if (!Number.isFinite(num)) return '-';
    // 整数不带小数，小数保留两位
    if (Number.isInteger(num)) return String(num);
    return num.toFixed(2);
}

// 字体大小设置
function initFontSize() {
    const savedSize = localStorage.getItem('fontSize') || '18';
    document.documentElement.style.setProperty('--font-size-base', savedSize + 'px');
    updateFontSizeInputs(savedSize);
}

function changeFontSize(size) {
    size = Math.max(10, Math.min(24, parseInt(size) || 14));
    document.documentElement.style.setProperty('--font-size-base', size + 'px');
    localStorage.setItem('fontSize', size);
    updateFontSizeInputs(size);
}

function updateFontSizeInputs(size) {
    const rangeInput = document.getElementById('fontSizeRange');
    const numberInput = document.getElementById('fontSizeInput');
    if (rangeInput) rangeInput.value = size;
    if (numberInput) numberInput.value = size;
}

// 敏感信息隐藏功能
let sensitiveInfoHidden = localStorage.getItem('sensitiveInfoHidden') !== 'false';

function initSensitiveInfo() {
    updateSensitiveInfoDisplay();
    updateSensitiveBtn();
}

function toggleSensitiveInfo() {
    sensitiveInfoHidden = !sensitiveInfoHidden;
    localStorage.setItem('sensitiveInfoHidden', sensitiveInfoHidden);
    updateSensitiveInfoDisplay();
    updateSensitiveBtn();
}

function updateSensitiveBtn() {
    const btn = document.getElementById('toggleSensitiveBtn');
    if (btn) {
        if (sensitiveInfoHidden) {
            btn.innerHTML = '🙈 隐藏';
            btn.title = '点击显示敏感信息';
            btn.classList.remove('btn-info');
            btn.classList.add('btn-secondary');
        } else {
            btn.innerHTML = '👁️ 显示';
            btn.title = '点击隐藏敏感信息';
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-info');
        }
    }
}

function updateSensitiveInfoDisplay() {
    // 隐藏/显示包含敏感信息的整行
    document.querySelectorAll('.sensitive-row').forEach(row => {
        if (sensitiveInfoHidden) {
            row.style.display = 'none';
        } else {
            row.style.display = '';
        }
    });
    // 同时隐藏/显示 token-info 容器
    document.querySelectorAll('.token-info').forEach(container => {
        if (sensitiveInfoHidden) {
            container.style.display = 'none';
        } else {
            container.style.display = '';
        }
    });
    // 重新��染 API 密钥列表以响应隐/显切换
    if (typeof renderApiKeysTable === 'function' && typeof globalApiKeysData !== 'undefined' && globalApiKeysData) {
        renderApiKeysTable();
    }
}

// 通用复制文本到剪贴板函数
function copyToClipboard(text, successMessage = '已复制到剪贴板') {
    if (!text) {
        showToast('复制内容为空', 'error');
        return;
    }

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(successMessage, 'success');
        }).catch(err => {
            fallbackCopyText(text, successMessage);
        });
    } else {
        fallbackCopyText(text, successMessage);
    }
}

function fallbackCopyText(text, successMessage) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (successful) {
            showToast(successMessage, 'success');
        } else {
            showToast('复制失败，请手动选中复制', 'error');
        }
    } catch (err) {
        console.error('Fallback 复制失败:', err);
        showToast('复制失败', 'error');
    }
}
