// API Key 管理与统计前端逻辑

let globalApiKeysData = { keys: [], stats: {} };

async function loadApiKeys() {
    try {
        const res = await authFetch('/admin/api-keys');
        const data = await res.json();
        if (data.success) {
            globalApiKeysData = data.data;
            renderApiKeysTable();
            renderStatsDashboard();
        } else {
            showToast(data.message || '加载 API 密钥失败', 'error');
        }
    } catch (err) {
        showToast('加载 API 密钥出错: ' + err.message, 'error');
    }
}

function renderApiKeysTable() {
    const tbody = document.getElementById('apiKeysTableBody');
    const statTotal = document.getElementById('statApiKeyTotal');
    const statEnabled = document.getElementById('statApiKeyEnabled');

    if (statTotal) statTotal.textContent = globalApiKeysData.stats?.totalKeys || globalApiKeysData.keys?.length || 0;
    if (statEnabled) statEnabled.textContent = globalApiKeysData.stats?.enabledKeys || 0;

    if (!tbody) return;

    const keys = globalApiKeysData.keys || [];
    if (keys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 20px; color: var(--text-light, #888);">暂无 API 密钥，点击右上角新建</td></tr>`;
        return;
    }

    tbody.innerHTML = keys.map(k => {
        const createdDate = k.createdAt ? new Date(k.createdAt).toLocaleString() : '-';
        const lastUsedDate = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '未使用';
        const requests = k.usage?.requests || 0;
        const totalTokens = (k.usage?.totalTokens || 0).toLocaleString();

        const keyDisplay = isSensitiveInfoHidden
            ? (k.key.substring(0, 7) + '...' + k.key.substring(k.key.length - 4))
            : k.key;

        return `
            <tr style="border-bottom: 1px solid var(--border-color, #e2e8f0);">
                <td style="padding: 10px; font-weight: bold;">${escapeHtml(k.name)}</td>
                <td style="padding: 10px; font-family: monospace;">
                    <span title="${escapeHtml(k.key)}">${escapeHtml(keyDisplay)}</span>
                    <button class="btn btn-sm" onclick="copyToClipboard('${escapeHtml(k.key)}')" style="padding: 2px 6px; font-size: 0.75rem; margin-left: 5px;" title="复制 Key">📋</button>
                </td>
                <td style="padding: 10px;">
                    <label class="switch" style="transform: scale(0.8); transform-origin: left center;">
                        <input type="checkbox" ${k.enabled ? 'checked' : ''} onchange="toggleApiKeyEnabled('${k.id}', this.checked)">
                        <span class="slider"></span>
                    </label>
                </td>
                <td style="padding: 10px;">${requests.toLocaleString()} 次</td>
                <td style="padding: 10px; font-weight: bold; color: var(--primary, #4f46e5);">${totalTokens}</td>
                <td style="padding: 10px; font-size: 0.85rem; color: var(--text-light, #666);">
                    <div>创建: ${createdDate}</div>
                    <div>使用: ${lastUsedDate}</div>
                </td>
                <td style="padding: 10px; text-align: right;">
                    <button class="btn btn-sm btn-danger" onclick="deleteApiKey('${k.id}', '${escapeHtml(k.name)}')">🗑️ 删除</button>
                </td>
            </tr>
        `;
    }).join('');
}

async function toggleApiKeyEnabled(id, enabled) {
    try {
        const res = await authFetch(`/admin/api-keys/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`API 密钥已${enabled ? '启用' : '禁用'}`, 'success');
            loadApiKeys();
        } else {
            showToast(data.message || '修改状态失败', 'error');
        }
    } catch (err) {
        showToast('请求失败: ' + err.message, 'error');
    }
}

async function showCreateApiKeyModal() {
    const defaultKey = 'sk-' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    const content = `
        <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
            <div class="form-group compact">
                <label>密钥名称</label>
                <input type="text" id="newApiKeyName" placeholder="例如: 生产环境应用 / OpenWebUI" value="API Key">
            </div>
            <div class="form-group compact">
                <label>自定义密钥字符串 (留空自动生成)</label>
                <input type="text" id="newApiKeyString" placeholder="${defaultKey}">
            </div>
        </div>
    `;

    const confirmed = await showConfirmModal('➕ 新建 API 密钥', content);
    if (confirmed) {
        const nameInput = document.getElementById('newApiKeyName');
        const keyInput = document.getElementById('newApiKeyString');

        const name = nameInput ? nameInput.value : 'API Key';
        const key = keyInput ? keyInput.value : '';

        try {
            const res = await authFetch('/admin/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, key })
            });
            const data = await res.json();
            if (data.success) {
                showToast('API 密钥创建成功', 'success');
                loadApiKeys();
            } else {
                showToast(data.message || '创建失败', 'error');
            }
        } catch (err) {
            showToast('创建失败: ' + err.message, 'error');
        }
    }
}

async function deleteApiKey(id, name) {
    const confirmed = await showConfirmModal('⚠️ 删除确认', `确定要删除 API 密钥【${name}】吗？此操作无法撤销。`);
    if (confirmed) {
        try {
            const res = await authFetch(`/admin/api-keys/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                showToast('API 密钥已删除', 'success');
                loadApiKeys();
            } else {
                showToast(data.message || '删除失败', 'error');
            }
        } catch (err) {
            showToast('删除失败: ' + err.message, 'error');
        }
    }
}

function renderStatsDashboard() {
    const keys = globalApiKeysData.keys || [];
    const select = document.getElementById('statsApiKeySelect');

    if (select) {
        const currentVal = select.value || 'all';
        select.innerHTML = `<option value="all">全部 API 密钥</option>` + keys.map(k =>
            `<option value="${k.id}">${escapeHtml(k.name)} (${k.key.substring(0, 6)}...)</option>`
        ).join('');
        select.value = currentVal;
    }

    const selectedId = select ? select.value : 'all';
    let filteredKeys = keys;
    if (selectedId !== 'all') {
        filteredKeys = keys.filter(k => k.id === selectedId);
    }

    let totalRequests = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalAll = 0;

    filteredKeys.forEach(k => {
        if (k.usage) {
            totalRequests += k.usage.requests || 0;
            totalInput += k.usage.inputTokens || 0;
            totalOutput += k.usage.outputTokens || 0;
            totalAll += k.usage.totalTokens || 0;
        }
    });

    const elReq = document.getElementById('dashTotalRequests');
    const elIn = document.getElementById('dashInputTokens');
    const elOut = document.getElementById('dashOutputTokens');
    const elTot = document.getElementById('dashTotalTokens');

    if (elReq) elReq.textContent = totalRequests.toLocaleString();
    if (elIn) elIn.textContent = totalInput.toLocaleString();
    if (elOut) elOut.textContent = totalOutput.toLocaleString();
    if (elTot) elTot.textContent = totalAll.toLocaleString();

    const tbody = document.getElementById('statsTableBody');
    if (!tbody) return;

    const overallTotalTokens = globalApiKeysData.stats?.totalTokens || totalAll || 1;

    if (filteredKeys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-light, #888);">暂无使用统计数据</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredKeys.map(k => {
        const u = k.usage || { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const percent = overallTotalTokens > 0 ? ((u.totalTokens / overallTotalTokens) * 100).toFixed(1) : '0.0';

        return `
            <tr style="border-bottom: 1px solid var(--border-color, #e2e8f0);">
                <td style="padding: 10px; font-weight: bold;">${escapeHtml(k.name)}</td>
                <td style="padding: 10px;">${(u.requests || 0).toLocaleString()} 次</td>
                <td style="padding: 10px; color: #10b981; font-weight: 500;">${(u.inputTokens || 0).toLocaleString()}</td>
                <td style="padding: 10px; color: #f59e0b; font-weight: 500;">${(u.outputTokens || 0).toLocaleString()}</td>
                <td style="padding: 10px; color: #3b82f6; font-weight: bold;">${(u.totalTokens || 0).toLocaleString()}</td>
                <td style="padding: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div style="flex: 1; background: #e2e8f0; height: 8px; border-radius: 4px; overflow: hidden;">
                            <div style="width: ${percent}%; background: var(--primary, #4f46e5); height: 100%;"></div>
                        </div>
                        <span style="font-size: 0.85rem; color: var(--text-light, #666); min-width: 45px;">${percent}%</span>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}
