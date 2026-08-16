// 公开 API 密钥使用量查询与仪表盘渲染

/**
 * 智能数字与单位格式化 (例如: 7.4亿, 42.6万, 2,407)
 * @param {number} num 
 * @param {number} precision 
 * @returns {{ main: string, unit: string, full: string }}
 */
function formatHumanNumber(num, precision = 2) {
    const val = Number(num) || 0;
    const full = val.toLocaleString();

    if (val >= 100000000) {
        // >= 1 亿
        const formatted = (val / 100000000).toFixed(precision).replace(/\.?0+$/, '');
        return { main: formatted, unit: '亿', full };
    }
    if (val >= 10000) {
        // >= 1 万
        const formatted = (val / 10000).toFixed(precision).replace(/\.?0+$/, '');
        return { main: formatted, unit: '万', full };
    }
    return { main: val.toLocaleString(), unit: '', full };
}

function showUsageQueryModal() {
    const existingModal = document.getElementById('usageQueryModal');
    if (existingModal) existingModal.remove();

    const savedKey = localStorage.getItem('lastQueriedApiKey') || '';

    const modal = document.createElement('div');
    modal.id = 'usageQueryModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content modal-lg" style="max-width: 860px; max-height: 90vh; overflow-y: auto; padding: 1.75rem; position: relative; border-radius: 1.25rem;">
            <button type="button" onclick="document.getElementById('usageQueryModal').remove()" style="position: absolute; right: 1.25rem; top: 1.25rem; background: none; border: none; font-size: 1.25rem; cursor: pointer; color: var(--text-light, #888); width: auto; min-height: auto; padding: 0; box-shadow: none;">✕</button>
            
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 1.5rem;">
                <img src="assets/logo.svg" alt="Logo" style="width: 36px; height: 36px;">
                <div>
                    <h3 style="margin: 0; font-size: 1.25rem; color: var(--text); font-weight: 700;">📊 API 密钥额度与使用量查询</h3>
                    <div style="font-size: 0.8rem; color: var(--text-light); margin-top: 2px;">输入 API 密钥实时查询 Token 消耗、额度剩余及各模型调用分布</div>
                </div>
            </div>

            <div style="display: flex; gap: 10px; margin-bottom: 1.75rem;">
                <input type="text" id="usageQueryKeyInput" placeholder="请输入你的 API 密钥 (例如: sk-...)" value="${escapeHtml(savedKey)}" style="flex: 1; font-family: monospace; font-size: 0.95rem; padding: 0.65rem 1rem !important; border-radius: 0.6rem;">
                <button type="button" class="btn btn-primary" id="usageQuerySubmitBtn" onclick="doQueryUsageReport()" style="min-width: 110px; font-size: 0.95rem; border-radius: 0.6rem;">🔍 查询</button>
            </div>

            <!-- 查询结果容器 -->
            <div id="usageQueryResultArea">
                <div style="text-align: center; padding: 3.5rem 1rem; color: var(--text-light, #888);">
                    <div style="font-size: 3rem; margin-bottom: 0.75rem; opacity: 0.7;">📈</div>
                    <div style="font-size: 1rem; font-weight: 500;">输入 API Key 点击查询，即可查看详细统计</div>
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
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-light, #888);">
            <div class="spinner" style="margin: 0 auto 1.25rem auto; width: 36px; height: 36px; border-width: 3px; border-top-color: var(--primary, #0891b2);"></div>
            <div style="font-size: 0.95rem;">正在获取实时使用量数据...</div>
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
                <div style="text-align: center; padding: 2.5rem 1rem; color: var(--danger, #ef4444); background: rgba(239, 68, 68, 0.05); border-radius: 12px; border: 1.5px dashed rgba(239, 68, 68, 0.3);">
                    <div style="font-size: 2.25rem; margin-bottom: 0.5rem;">❌</div>
                    <div style="font-weight: bold; font-size: 1.05rem; margin-bottom: 0.25rem;">查询失败</div>
                    <div style="font-size: 0.88rem; color: var(--text-light);">${escapeHtml(res.message || '未找到该 API Key')}</div>
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

    // 格式化总体数据
    const totalTok = formatHumanNumber(data.totalTokens || 0, 2);
    const inputTok = formatHumanNumber(data.inputTokens || 0, 2);
    const outputTok = formatHumanNumber(data.outputTokens || 0, 2);
    const requests = formatHumanNumber(data.requests || 0, 1);
    
    let quotaMain = '无限制';
    let quotaSub = '不设上限';
    let progressColor = 'var(--primary, #4f46e5)';
    let maxTokensFormatted = '';

    if (data.maxTokens && data.maxTokens > 0) {
        const maxTok = formatHumanNumber(data.maxTokens, 2);
        maxTokensFormatted = `${maxTok.main}${maxTok.unit}`;
        if (data.isExceeded) {
            quotaMain = '已超限';
            quotaSub = `上限: ${maxTokensFormatted}`;
            progressColor = '#ef4444';
        } else {
            const remainTokens = Math.max(0, data.maxTokens - (data.totalTokens || 0));
            const remainTok = formatHumanNumber(remainTokens, 2);
            quotaMain = `余 ${remainTok.main}${remainTok.unit}`;
            quotaSub = `上限: ${maxTokensFormatted} (已用 ${data.percentage}%)`;
            progressColor = data.percentage > 75 ? '#f59e0b' : '#10b981';
        }
    }

    const statusBadge = data.isExceeded
        ? `<span style="background: rgba(239,68,68,0.15); color: #ef4444; padding: 4px 10px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600;">⚠️ 额度已耗尽</span>`
        : (data.enabled 
            ? `<span style="background: rgba(16,185,129,0.15); color: #10b981; padding: 4px 10px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600;">✓ 正常可用</span>` 
            : `<span style="background: rgba(100,116,139,0.15); color: #64748b; padding: 4px 10px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600;">已禁用</span>`);

    let lastDateStr = '-';
    let lastTimeStr = '未使用';
    if (data.lastUsedAt) {
        const d = new Date(data.lastUsedAt);
        lastDateStr = d.toLocaleDateString();
        lastTimeStr = d.toTimeString().split(' ')[0]; // 包含 HH:mm:ss 精确到秒
    }

    // 渲染模型分布列表
    const modelsList = data.models || [];
    let modelsHtml = '';
    if (modelsList.length === 0) {
        modelsHtml = `
            <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-light, #888); font-size: 0.9rem;">
                暂无模型调用记录
            </div>
        `;
    } else {
        modelsHtml = `
            <div class="table-responsive" style="overflow-x: auto; margin-top: 0.75rem;">
                <table style="width: 100%; min-width: 600px; border-collapse: collapse; font-size: 0.88rem;">
                    <thead>
                        <tr style="border-bottom: 2px solid var(--border, #e2e8f0); text-align: left; color: var(--text-light, #888);">
                            <th style="padding: 10px 12px;">模型名称</th>
                            <th style="padding: 10px 12px;">请求次数</th>
                            <th style="padding: 10px 12px;">输入 Tokens</th>
                            <th style="padding: 10px 12px;">输出 Tokens</th>
                            <th style="padding: 10px 12px;">总 Tokens</th>
                            <th style="padding: 10px 12px; min-width: 120px;">消耗占比</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${modelsList.map(m => {
                            const mTotal = formatHumanNumber(m.totalTokens, 2);
                            const mInput = formatHumanNumber(m.inputTokens, 2);
                            const mOutput = formatHumanNumber(m.outputTokens, 2);
                            return `
                                <tr style="border-bottom: 1px solid var(--border, #e2e8f0);">
                                    <td style="padding: 12px; font-weight: 600; font-family: 'Ubuntu Mono', monospace; color: var(--text);">${escapeHtml(m.name)}</td>
                                    <td style="padding: 12px;">${m.requests.toLocaleString()} 次</td>
                                    <td style="padding: 12px; color: #10b981;" title="精确值: ${m.inputTokens.toLocaleString()}">${mInput.main}${mInput.unit}</td>
                                    <td style="padding: 12px; color: #f59e0b;" title="精确值: ${m.outputTokens.toLocaleString()}">${mOutput.main}${mOutput.unit}</td>
                                    <td style="padding: 12px; font-weight: bold; color: var(--primary);" title="精确值: ${m.totalTokens.toLocaleString()}">${mTotal.main}${mTotal.unit}</td>
                                    <td style="padding: 12px;">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <div style="flex: 1; height: 8px; background: rgba(0,0,0,0.06); border-radius: 4px; overflow: hidden; min-width: 50px;">
                                                <div style="width: ${m.percentage}%; background: var(--primary); height: 100%;"></div>
                                            </div>
                                            <span style="font-size: 0.78rem; color: var(--text-light); min-width: 42px; text-align: right;">${m.percentage}%</span>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    resultArea.innerHTML = `
        <!-- 密钥基本信息条 -->
        <div style="background: rgba(8, 145, 178, 0.05); border: 1.5px solid var(--border); border-radius: 12px; padding: 0.85rem 1.25rem; margin-bottom: 1.25rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <strong style="font-size: 1.05rem; color: var(--text);">${escapeHtml(data.name)}</strong>
                <span style="font-family: monospace; font-size: 0.88rem; color: var(--text-light); background: var(--card); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border);">${escapeHtml(data.maskedKey)}</span>
            </div>
            <div>${statusBadge}</div>
        </div>

        <!-- 4个核心指标大卡片 (单行4列平铺，移动端自适应) -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 1.5rem;" class="usage-cards-grid">
            
            <!-- 总请求数 -->
            <div style="background: var(--card); border: 1.5px solid var(--border); border-radius: 12px; padding: 1rem 0.85rem; text-align: left; display: flex; flex-direction: column; justify-content: space-between; min-width: 0;">
                <div style="font-size: 0.82rem; color: var(--text-light); display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    <span>📄</span> <span>总请求次数</span>
                </div>
                <div style="margin: 0.5rem 0 0.2rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    <span style="font-size: 1.85rem; font-weight: 800; color: var(--primary); letter-spacing: -0.5px;" title="精确值: ${requests.full} 次">${requests.main}</span>
                    ${requests.unit ? `<span style="font-size: 1rem; font-weight: 700; color: var(--primary); margin-left: 1px;">${requests.unit}</span>` : ''}
                    <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-light); margin-left: 2px;">次</span>
                </div>
                <div style="font-size: 0.72rem; color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">共 ${requests.full} 次</div>
            </div>

            <!-- 总 Token 消耗 (大字 + 易读单位) -->
            <div style="background: var(--card); border: 1.5px solid var(--border); border-radius: 12px; padding: 1rem 0.85rem; text-align: left; display: flex; flex-direction: column; justify-content: space-between; min-width: 0;">
                <div style="font-size: 0.82rem; color: var(--text-light); display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    <span>🔥</span> <span>Tokens 用量</span>
                </div>
                <div style="margin: 0.5rem 0 0.2rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    <span style="font-size: 1.85rem; font-weight: 800; color: var(--text); letter-spacing: -0.5px;" title="精确值: ${totalTok.full}">${totalTok.main}</span>
                    <span style="font-size: 1.05rem; font-weight: 700; color: var(--text); margin-left: 1px;">${totalTok.unit || 'Token'}</span>
                </div>
                <div style="font-size: 0.72rem; color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="输入: ${inputTok.full} / 输出: ${outputTok.full}">
                    入: ${inputTok.main}${inputTok.unit} · 出: ${outputTok.main}${outputTok.unit}
                </div>
            </div>

            <!-- 额度上限与剩余 -->
            <div style="background: var(--card); border: 1.5px solid var(--border); border-radius: 12px; padding: 1rem 0.85rem; text-align: left; display: flex; flex-direction: column; justify-content: space-between; min-width: 0;">
                <div style="font-size: 0.82rem; color: var(--text-light); display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    <span>🎯</span> <span>额度状态</span>
                </div>
                <div style="margin: 0.5rem 0 0.2rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    <span style="font-size: 1.65rem; font-weight: 800; color: ${progressColor}; letter-spacing: -0.5px;">${quotaMain}</span>
                </div>
                <div style="min-width: 0;">
                    ${data.maxTokens ? `
                        <div style="background: rgba(0,0,0,0.06); height: 5px; border-radius: 3px; overflow: hidden; margin-bottom: 3px;">
                            <div style="width: ${data.percentage}%; background: ${progressColor}; height: 100%;"></div>
                        </div>
                        <div style="font-size: 0.72rem; color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${quotaSub}</div>
                    ` : '<div style="font-size: 0.72rem; color: #10b981; white-space: nowrap;">无使用上限</div>'}
                </div>
            </div>

            <!-- 最后活跃时间 (日期 + 时分秒两行清晰展示) -->
            <div style="background: var(--card); border: 1.5px solid var(--border); border-radius: 12px; padding: 1rem 0.85rem; text-align: left; display: flex; flex-direction: column; justify-content: space-between; min-width: 0;">
                <div style="font-size: 0.82rem; color: var(--text-light); display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    <span>⏱️</span> <span>最后活跃时间</span>
                </div>
                <div style="margin: 0.4rem 0 0.2rem 0; display: flex; flex-direction: column; gap: 1px;">
                    <div style="font-size: 1.05rem; font-weight: 700; color: var(--text); font-family: 'Ubuntu Mono', monospace; line-height: 1.2;">${escapeHtml(lastDateStr)}</div>
                    <div style="font-size: 1.15rem; font-weight: 800; color: var(--text); font-family: 'Ubuntu Mono', monospace; line-height: 1.2; letter-spacing: -0.2px;">${escapeHtml(lastTimeStr)}</div>
                </div>
                <div style="font-size: 0.72rem; color: var(--text-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">创建于: ${data.createdAt ? new Date(data.createdAt).toLocaleDateString() : '-'}</div>
            </div>

        </div>

        <!-- 各模型消耗分布 -->
        <div style="background: var(--card); border: 1.5px solid var(--border); border-radius: 12px; padding: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 1.1rem;">🌐</span>
                    <strong style="font-size: 1.05rem; color: var(--text);">各模型消耗分布</strong>
                </div>
                <span style="font-size: 0.8rem; color: var(--text-light); background: rgba(0,0,0,0.04); padding: 3px 8px; border-radius: 6px;">已调用 ${modelsList.length} 个模型</span>
            </div>
            ${modelsHtml}
        </div>
    `;
}
