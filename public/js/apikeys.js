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
        const totalTokensNum = k.usage?.totalTokens || 0;
        const totalTokensStr = totalTokensNum.toLocaleString();

        let maxTokensDisplay = '无限制';
        let isExceeded = false;
        let quotaPercent = 0;

        if (k.maxTokens && k.maxTokens > 0) {
            maxTokensDisplay = k.maxTokens.toLocaleString();
            quotaPercent = Math.min(100, Math.round((totalTokensNum / k.maxTokens) * 100));
            if (totalTokensNum >= k.maxTokens) {
                isExceeded = true;
            }
        }

        const keyHide = typeof sensitiveInfoHidden !== 'undefined' ? sensitiveInfoHidden : true;
        const keyDisplay = keyHide
            ? (k.key.length > 12 ? (k.key.substring(0, 7) + '...' + k.key.substring(k.key.length - 4)) : '••••••••••••')
            : k.key;

        return `
            <tr style="border-bottom: 1px solid var(--border-color, #e2e8f0);">
                <td style="padding: 10px; font-weight: bold; white-space: nowrap;">
                    ${escapeHtml(k.name)}
                    ${isExceeded ? '<span style="font-size: 0.75rem; background: #ef4444; color: #fff; padding: 2px 6px; border-radius: 4px; margin-left: 5px;">额度已耗尽</span>' : ''}
                </td>
                <td style="padding: 10px; font-family: monospace; white-space: nowrap;">
                    <span title="${escapeHtml(k.key)}">${escapeHtml(keyDisplay)}</span>
                    <button class="btn btn-sm" data-key="${escapeHtml(k.key)}" onclick="copyApiKeyBtn(this)" style="padding: 2px 6px; font-size: 0.75rem; margin-left: 5px;" title="复制 Key">📋</button>
                </td>
                <td style="padding: 10px; white-space: nowrap;">
                    <label class="switch" style="transform: scale(0.8); transform-origin: left center;">
                        <input type="checkbox" ${k.enabled ? 'checked' : ''} onchange="toggleApiKeyEnabled('${k.id}', this.checked)">
                        <span class="slider"></span>
                    </label>
                </td>
                <td style="padding: 10px; white-space: nowrap;">${requests.toLocaleString()} 次</td>
                <td style="padding: 10px; white-space: nowrap;">
                    <div style="font-weight: bold; color: ${isExceeded ? '#ef4444' : 'var(--primary, #4f46e5)'};">
                        ${totalTokensStr} <span style="font-weight: normal; color: var(--text-light, #888); font-size: 0.85rem;">/ ${maxTokensDisplay}</span>
                    </div>
                    ${k.maxTokens ? `
                        <div style="background: #e2e8f0; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 4px; width: 120px;">
                            <div style="width: ${quotaPercent}%; background: ${isExceeded ? '#ef4444' : '#10b981'}; height: 100%;"></div>
                        </div>
                    ` : ''}
                </td>
                <td style="padding: 10px; font-size: 0.85rem; color: var(--text-light, #666); white-space: nowrap;">
                    <div>创建: ${createdDate}</div>
                    <div>使用: ${lastUsedDate}</div>
                </td>
                <td style="padding: 10px; text-align: right; white-space: nowrap;">
                    <button class="btn btn-sm btn-info" onclick="showEditApiKeyModal('${k.id}')" style="margin-right: 4px;">✏️ 编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteApiKey('${k.id}', '${escapeHtml(k.name)}')">🗑️ 删除</button>
                </td>
            </tr>
        `;
    }).join('');
}

function copyApiKeyBtn(btn) {
    const keyText = btn ? btn.getAttribute('data-key') : '';
    copyToClipboard(keyText, 'API 密钥已复制到剪贴板');
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
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">➕ 新建 API 密钥</div>
            <div class="form-group compact" style="margin-top: 1rem;">
                <label>密钥名称</label>
                <input type="text" id="newApiKeyName" placeholder="例如: 生产环境应用 / OpenWebUI" value="API Key">
            </div>
            <div class="form-group compact" style="margin-top: 0.5rem;">
                <label>自定义密钥字符串 (留空自动生成)</label>
                <input type="text" id="newApiKeyString" placeholder="${defaultKey}">
            </div>
            <div class="form-group compact" style="margin-top: 0.5rem;">
                <label>Token 累计消耗上限阈值 (设为 0 或留空代表无限制，例如: 100000000 即 1 亿 Token)</label>
                <input type="number" id="newApiKeyMaxTokens" placeholder="例如: 100000000">
            </div>
            <div class="modal-actions" style="margin-top: 1.5rem;">
                <button class="btn btn-secondary" id="cancelCreateApiKeyBtn">取消</button>
                <button class="btn btn-primary" id="confirmCreateApiKeyBtn">创建</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const confirmed = await new Promise((resolve) => {
        const cancelBtn = modal.querySelector('#cancelCreateApiKeyBtn');
        const confirmBtn = modal.querySelector('#confirmCreateApiKeyBtn');
        
        const cleanup = () => {
            modal.remove();
        };

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        confirmBtn.addEventListener('click', () => {
            resolve(true);
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(false);
            }
        });
    });

    if (confirmed) {
        const nameInput = document.getElementById('newApiKeyName');
        const keyInput = document.getElementById('newApiKeyString');
        const maxTokensInput = document.getElementById('newApiKeyMaxTokens');

        const name = nameInput ? nameInput.value.trim() : 'API Key';
        const key = keyInput ? keyInput.value.trim() : '';
        const maxTokensVal = maxTokensInput ? parseInt(maxTokensInput.value) : 0;
        const maxTokens = Number.isFinite(maxTokensVal) && maxTokensVal > 0 ? maxTokensVal : null;
        modal.remove();

        try {
            const res = await authFetch('/admin/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, key, maxTokens })
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

async function showEditApiKeyModal(id) {
    const keys = globalApiKeysData.keys || [];
    const targetKey = keys.find(k => k.id === id);
    if (!targetKey) return;

    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-title">✏️ 编辑 API 密钥【${escapeHtml(targetKey.name)}】</div>
            <div class="form-group compact" style="margin-top: 1rem;">
                <label>密钥名称</label>
                <input type="text" id="editApiKeyName" value="${escapeHtml(targetKey.name)}">
            </div>
            <div class="form-group compact" style="margin-top: 0.5rem;">
                <label>密钥字符串</label>
                <input type="text" id="editApiKeyString" value="${escapeHtml(targetKey.key)}">
            </div>
            <div class="form-group compact" style="margin-top: 0.5rem;">
                <label>Token 累计消耗上限阈值 (0 或留空为不限制，例如: 100000000 代表 1 亿 Token)</label>
                <input type="number" id="editApiKeyMaxTokens" value="${targetKey.maxTokens || ''}" placeholder="不限制">
            </div>
            <div class="modal-actions" style="margin-top: 1.5rem;">
                <button class="btn btn-secondary" id="cancelEditApiKeyBtn">取消</button>
                <button class="btn btn-primary" id="confirmEditApiKeyBtn">保存修改</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const confirmed = await new Promise((resolve) => {
        const cancelBtn = modal.querySelector('#cancelEditApiKeyBtn');
        const confirmBtn = modal.querySelector('#confirmEditApiKeyBtn');
        
        const cleanup = () => {
            modal.remove();
        };

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve(false);
        });

        confirmBtn.addEventListener('click', () => {
            resolve(true);
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                cleanup();
                resolve(false);
            }
        });
    });

    if (confirmed) {
        const nameInput = document.getElementById('editApiKeyName');
        const keyInput = document.getElementById('editApiKeyString');
        const maxTokensInput = document.getElementById('editApiKeyMaxTokens');

        const name = nameInput ? nameInput.value.trim() : targetKey.name;
        const key = keyInput ? keyInput.value.trim() : targetKey.key;
        const maxTokensVal = maxTokensInput ? parseInt(maxTokensInput.value) : 0;
        const maxTokens = Number.isFinite(maxTokensVal) && maxTokensVal > 0 ? maxTokensVal : null;
        modal.remove();

        try {
            const res = await authFetch(`/admin/api-keys/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, key, maxTokens })
            });
            const data = await res.json();
            if (data.success) {
                showToast('API 密钥已更新', 'success');
                loadApiKeys();
            } else {
                showToast(data.message || '更新失败', 'error');
            }
        } catch (err) {
            showToast('更新失败: ' + err.message, 'error');
        }
    }
}

async function deleteApiKey(id, name) {
    const confirmed = await showConfirm(`确定要删除 API 密钥【${name}】吗？此操作无法撤销。`, '⚠️ 删除确认');
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
