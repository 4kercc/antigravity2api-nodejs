// 公开 API 密钥使用量查询与仪表盘渲染

function showUsageQueryModal() {
    const existingModal = document.getElementById('usageQueryModal');
    if (existingModal) existingModal.remove();

    const savedKey = localStorage.getItem('lastQueriedApiKey') || '';

    const modal = document.createElement('div');
    modal.id = 'usageQueryModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content modal-lg" style="max-width: 820px; max-height: 90vh; overflow-y: auto; padding: 1.5rem; position: relative;">
            <button type="button" onclick="document.getElementById('usageQueryModal').remove()" style="position: absolute; right: 1rem; top: 1rem; background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-light, #888); width: auto; min-height: auto; padding: 0; box-shadow: none;">✕</button>
            
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 1.25rem;">
                <img src="assets/logo.svg" alt="Logo" style="width: 32px; height: 32px;">
                <h3 style="margin: 0; font-size: 1.2rem; color: var(--text);">📊 API 密钥使用量与额度查询</h3>
            </div>

            <div style="display: flex; gap: 8px; margin-bottom: 1.5rem;">
                <input type="text" id="usageQueryKeyInput" placeholder="请输入你的 API 密钥 (例如: sk-...)" value="${escapeHtml(savedKey)}" style="flex: 1; font-family: monospace; font-size: 0.9rem;">
                <button type="button" class="btn btn-primary" id="usageQuerySubmitBtn" onclick="doQueryUsageReport()" style="min-width: 100px;">🔍 查询</button>
            </div>

            <!-- 查询结果容器 -->
            <div id="usageQueryResultArea">
                <div style="text-align: center; padding: 3rem 1rem; color: var(--text-light, #888);">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem; opacity: 0.6;">📈</div>
                    <div style="font-size: 0.95rem;">输入 API Key 点击查询，即可查看实时请求次数、Token 消耗及模型使用分布</div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });

    const input = document.getElementById('usageQueryKeyInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doQueryUsageReport();
        });
        if (savedKey) {
            doQueryUsageReport();
        } else {
            input.focus();
        }
    }
}

async function doQueryUsageReport() {
    const input = document.getElementById('usageQueryKeyInput');
    const resultArea = document.getElementById('usageQueryResultArea');
    const btn = document.getElementById('usageQuerySubmitBtn');

    if (!input || !resultArea) return;
    const key = input.value.trim();

    if (!key) {
        showToast('请输入 API 密钥', 'warning');
        input.focus();
        return;
    }

    localStorage.setItem('lastQueriedApiKey', key);

    const origBtnText = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 查询中...';
    }

    resultArea.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-light, #888);">
            <div class="spinner" style="margin: 0 auto 1rem auto; width: 32px; height: 32px; border-width: 3px; border-top-color: var(--primary, #0891b2);"></div>
            <div>正在获取使用量数据...</div>
        </div>
    `;

    try {
        const response = await fetch('/api/check-usage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        });
        const res = await response.json();

        if (res.success && res.data) {
            renderUsageQueryResult(res.data);
        } else {
            resultArea.innerHTML = `
                <div style="text-align: center; padding: 2.5rem 1rem; color: var(--danger, #ef4444); background: rgba(239, 68, 68, 0.05); border-radius: 8px; border: 1px dashed rgba(239, 68, 68, 0.3);">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem;">❌</div>
                    <div style="font-weight: bold; font-size: 1rem; margin-bottom: 0.25rem;">查询失败</div>
                    <div style="font-size: 0.85rem; color: var(--text-light);">${escapeHtml(res.message || '未找到该 API Key')}</div>
                </div>
            `;
        }
    } catch (err) {
        resultArea.innerHTML = `
            <div style="text-align: center; padding: 2.5rem 1rem; color: var(--danger, #ef4444);">
                <div>请求出错: ${escapeHtml(err.message)}</div>
            </div>
        `;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = origBtnText;
        }
    }
}

function renderUsageQueryResult(data) {
    const resultArea = document.getElementById('usageQueryResultArea');
    if (!resultArea) return;

    const totalTokensStr = (data.totalTokens || 0).toLocaleString();
    const inputTokensStr = (data.inputTokens || 0).toLocaleString();
    const outputTokensStr = (data.outputTokens || 0).toLocaleString();
    const requestsStr = (data.requests || 0).toLocaleString();
    
    let quotaDisplay = '无限制';
    let progressColor = 'var(--primary, #4f46e5)';
    if (data.maxTokens && data.maxTokens > 0) {
        quotaDisplay = `${(data.maxTokens).toLocaleString()} Token`;
        if (data.isExceeded) {
            progressColor = '#ef4444';
        } else if (data.percentage > 75) {
            progressColor = '#f59e0b';
        } else {
            progressColor = '#10b981';
        }
    }

    const statusBadge = data.isExceeded
        ? `<span style="background: rgba(239,68,68,0.15); color: #ef4444; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">⚠️ 额度已耗尽</span>`
        : (data.enabled 
            ? `<span style="background: rgba(16,185,129,0.15); color: #10b981; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">✓ 正常可用</span>` 
            : `<span style="background: rgba(100,116,139,0.15); color: #64748b; padding: 3px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">已禁用</span>`);

    const lastUsedFormatted = data.lastUsedAt ? new Date(data.lastUsedAt).toLocaleString() : '未使用';

    // 渲染模型分布列表
    const modelsList = data.models || [];
    let modelsHtml = '';
    if (modelsList.length === 0) {
        modelsHtml = `
            <div style="text-align: center; padding: 2rem 1rem; color: var(--text-light, #888); font-size: 0.85rem;">
                暂无模型调用记录
            </div>
        `;
    } else {
        modelsHtml = `
            <div class="table-responsive" style="overflow-x: auto; margin-top: 0.5rem;">
                <table style="width: 100%; min-width: 550px; border-collapse: collapse; font-size: 0.85rem;">
                    <thead>
                        <tr style="border-bottom: 2px solid var(--border, #e2e8f0); text-align: left; color: var(--text-light, #888);">
                            <th style="padding: 8px 10px;">模型名称</th>
                            <th style="padding: 8px 10px;">请求次数</th>
                            <th style="padding: 8px 10px;">输入 Tokens</th>
                            <th style="padding: 8px 10px;">输出 Tokens</th>
                            <th style="padding: 8px 10px;">总 Tokens</th>
                            <th style="padding: 8px 10px;">消耗占比</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${modelsList.map(m => `
                            <tr style="border-bottom: 1px solid var(--border, #e2e8f0);">
                                <td style="padding: 10px; font-weight: bold; font-family: monospace; color: var(--text);">${escapeHtml(m.name)}</td>
                                <td style="padding: 10px;">${m.requests.toLocaleString()} 次</td>
                                <td style="padding: 10px; color: #10b981;">${m.inputTokens.toLocaleString()}</td>
                                <td style="padding: 10px; color: #f59e0b;">${m.outputTokens.toLocaleString()}</td>
                                <td style="padding: 10px; font-weight: bold; color: var(--primary);">${m.totalTokens.toLocaleString()}</td>
                                <td style="padding: 10px;">
                                    <div style="display: flex; align-items: center; gap: 6px;">
                                        <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.06); border-radius: 3px; overflow: hidden; min-width: 50px;">
                                            <div style="width: ${m.percentage}%; background: var(--primary); height: 100%;"></div>
                                        </div>
                                        <span style="font-size: 0.75rem; color: var(--text-light);">${m.percentage}%</span>
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    resultArea.innerHTML = `
        <!-- 密钥基本信息条 -->
        <div style="background: rgba(8, 145, 178, 0.05); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <strong style="font-size: 1rem; color: var(--text);">${escapeHtml(data.name)}</strong>
                <span style="font-family: monospace; font-size: 0.85rem; color: var(--text-light);">(${escapeHtml(data.maskedKey)})</span>
            </div>
            <div>${statusBadge}</div>
        </div>

        <!-- 4个核心指标大卡片 -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 1.25rem;">
            <!-- 总请求数 -->
            <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center;">
                <div style="font-size: 0.8rem; color: var(--text-light);">📄 总请求次数</div>
                <div style="font-size: 1.6rem; font-weight: bold; color: var(--primary); margin-top: 4px;">${requestsStr} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-light);">次</span></div>
            </div>

            <!-- 总 Token -->
            <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center;">
                <div style="font-size: 0.8rem; color: var(--text-light);">📦 总 Token 消耗</div>
                <div style="font-size: 1.6rem; font-weight: bold; color: #3b82f6; margin-top: 4px;">${totalTokensStr}</div>
                <div style="font-size: 0.7rem; color: var(--text-light); margin-top: 2px;">入: ${inputTokensStr} / 出: ${outputTokensStr}</div>
            </div>

            <!-- 额度上限 -->
            <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center;">
                <div style="font-size: 0.8rem; color: var(--text-light);">🎯 额度上限阈值</div>
                <div style="font-size: 1.3rem; font-weight: bold; color: ${progressColor}; margin-top: 4px;">${quotaDisplay}</div>
                ${data.maxTokens ? `
                    <div style="background: rgba(0,0,0,0.06); height: 5px; border-radius: 3px; overflow: hidden; margin-top: 6px;">
                        <div style="width: ${data.percentage}%; background: ${progressColor}; height: 100%;"></div>
                    </div>
                    <div style="font-size: 0.7rem; color: var(--text-light); margin-top: 2px;">已消耗 ${data.percentage}%</div>
                ` : '<div style="font-size: 0.7rem; color: #10b981; margin-top: 2px;">不设上限</div>'}
            </div>

            <!-- 最后活跃时间 -->
            <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center;">
                <div style="font-size: 0.8rem; color: var(--text-light);">⏱️ 最后活跃时间</div>
                <div style="font-size: 0.95rem; font-weight: 600; color: var(--text); margin-top: 10px;">${lastUsedFormatted}</div>
            </div>
        </div>

        <!-- 模型分布面板 -->
        <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <strong style="font-size: 0.95rem; color: var(--text);">🌐 各模型消耗分布</strong>
                <span style="font-size: 0.75rem; color: var(--text-light);">已调用 ${modelsList.length} 个模型</span>
            </div>
            ${modelsHtml}
        </div>
    `;
}
