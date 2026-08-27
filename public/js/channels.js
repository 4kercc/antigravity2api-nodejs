/**
 * 外部上游渠道分流管理模块 (AIStudioToAPI / OneAPI)
 */

let cachedChannels = [];

async function loadChannels() {
  const container = document.getElementById('channelsListContainer');
  if (!container) return;

  try {
    const res = await authFetch('/admin/channels');
    const data = await res.json();
    if (data.success) {
      cachedChannels = data.data || [];
      renderChannels(cachedChannels);
    } else {
      container.innerHTML = `<div class="empty-state-small" style="color:#ef4444;">加载渠道失败: ${data.message}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state-small" style="color:#ef4444;">请求失败: ${err.message}</div>`;
  }
}

function renderChannels(channels) {
  const container = document.getElementById('channelsListContainer');
  if (!container) return;

  if (!channels || channels.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px; background: var(--bg-body, #f8fafc); border: 1px dashed var(--border-color, #e2e8f0); border-radius: 8px; color: var(--text-muted, #64748b);">
        <p style="margin-bottom: 8px; font-size: 0.95rem;">暂未配置外部上游渠道</p>
        <p style="font-size: 0.82rem; margin-bottom: 12px;">当有账号因 Google 风控无法登录客户端时，可使用 AIStudioToAPI 单独启动并通过此面板接入</p>
        <button type="button" class="btn btn-sm btn-success" onclick="showAddChannelModal()">➕ 添加第一个渠道</button>
      </div>
    `;
    return;
  }

  container.innerHTML = channels.map((c, index) => {
    const isEnabled = c.enable !== false;
    const modelsText = (c.models && c.models.length > 0) ? c.models.join(', ') : '全部支持 (*)';
    const totalReq = c.totalRequests || 0;
    const totalTok = c.totalTokens || 0;
    
    return `
      <div style="background: var(--bg-body, #f8fafc); border: 1px solid var(--border-color, #e2e8f0); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.1rem;">${isEnabled ? '🟢' : '⚪'}</span>
            <strong style="font-size: 1rem; color: var(--text-color, #1e293b);">${escapeHtml(c.name)}</strong>
            <span style="background: rgba(99, 102, 241, 0.12); color: var(--primary, #4f46e5); padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: bold;">
              ${(c.type || 'openai').toUpperCase()}
            </span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <label class="switch" style="transform: scale(0.85);" title="开启或关闭该渠道">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleChannelEnable('${c.id}', this.checked)">
              <span class="slider"></span>
            </label>
            <button type="button" class="btn btn-sm btn-info" onclick="testChannelConnectivity('${c.id}')" title="在线测试该端点延迟">⚡ 测速</button>
            <button type="button" class="btn btn-sm btn-warning" onclick="showEditChannelModal('${c.id}')" title="编辑该渠道配置">✏️ 编辑</button>
            <button type="button" class="btn btn-sm btn-danger" onclick="deleteChannel('${c.id}', '${escapeHtml(c.name)}')" title="删除该渠道">🗑️</button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; font-size: 0.85rem; color: var(--text-muted, #64748b);">
          <div><strong>Base URL:</strong> <code style="color: var(--primary);">${escapeHtml(c.baseUrl)}</code></div>
          <div><strong>API Key:</strong> <code>${c.apiKeyMasked || '（无密钥/免密）'}</code></div>
          <div><strong>累计调用 / Token:</strong> <span style="font-weight: bold; color: var(--primary);">${totalReq} 次</span> / <span>${totalTok.toLocaleString()} Tokens</span></div>
          <div><strong>优先级:</strong> ${c.priority || 10} (值越小越优先)</div>
          <div style="grid-column: 1 / -1;"><strong>支持模型:</strong> <span style="color: #059669;">${escapeHtml(modelsText)}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function showAddChannelModal() {
  const modal = document.createElement('div');
  modal.className = 'modal form-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 520px;">
      <div class="modal-title">➕ 添加外部上游渠道 (AIStudioToAPI / OneAPI)</div>
      
      <div class="form-group compact" style="margin-top: 12px;">
        <label>渠道名称</label>
        <input type="text" id="chanNameInput" placeholder="例如: AIStudio 本地端点 1" value="AIStudio 本地端点">
      </div>

      <div class="form-group compact">
        <label>渠道类型</label>
        <select id="chanTypeInput">
          <option value="openai">OpenAI 兼容接口 (/v1/chat/completions)</option>
        </select>
      </div>

      <div class="form-group compact">
        <label>Base URL (基础接口地址) *</label>
        <input type="text" id="chanBaseUrlInput" placeholder="例如: http://127.0.0.1:8088/v1" value="http://127.0.0.1:8088/v1">
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">若在服务器通过 Docker 部署 AIStudioToAPI，通常为 <code>http://127.0.0.1:8088/v1</code></div>
      </div>

      <div class="form-group compact">
        <label>API Key (可选，无密码可留空)</label>
        <input type="password" id="chanApiKeyInput" placeholder="sk-...">
      </div>

      <div class="form-group compact">
        <label>支持的模型列表 (英文逗号分隔，留空表示支持全部)</label>
        <input type="text" id="chanModelsInput" placeholder="gemini-2.5-pro, gemini-3.7-flash, claude-3-7-sonnet" value="gemini-2.5-pro, gemini-3.7-flash, claude-3-7-sonnet">
      </div>

      <div class="form-group compact">
        <label>优先级 (默认 10，数值越小优先级越高)</label>
        <input type="number" id="chanPriorityInput" value="10" min="1" max="100">
      </div>

      <div class="modal-actions" style="margin-top: 1.5rem;">
        <button type="button" class="btn btn-secondary" id="cancelAddChanBtn">取消</button>
        <button type="button" class="btn btn-success" id="confirmAddChanBtn">确认添加</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#cancelAddChanBtn').onclick = () => modal.remove();
  modal.querySelector('#confirmAddChanBtn').onclick = async () => {
    const name = modal.querySelector('#chanNameInput').value.trim();
    const type = modal.querySelector('#chanTypeInput').value;
    const baseUrl = modal.querySelector('#chanBaseUrlInput').value.trim();
    const apiKey = modal.querySelector('#chanApiKeyInput').value.trim();
    const modelsStr = modal.querySelector('#chanModelsInput').value.trim();
    const priority = Number(modal.querySelector('#chanPriorityInput').value) || 10;

    if (!baseUrl) {
      showToast('请输入 Base URL', 'warning');
      return;
    }

    showLoading('正在添加渠道...');
    try {
      const res = await authFetch('/admin/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || '外部渠道',
          type,
          baseUrl,
          apiKey,
          models: modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
          priority,
          enable: true
        })
      });
      const data = await res.json();
      hideLoading();

      if (data.success) {
        showToast(data.message, 'success');
        modal.remove();
        loadChannels();
      } else {
        showToast(data.message || '添加失败', 'error');
      }
    } catch (e) {
      hideLoading();
      showToast('请求异常: ' + e.message, 'error');
    }
  };
}

async function showEditChannelModal(id) {
  const chan = cachedChannels.find(c => c.id === id);
  if (!chan) {
    showToast('未找到该渠道信息', 'error');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'modal form-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 520px;">
      <div class="modal-title">✏️ 编辑外部上游渠道配置</div>
      
      <div class="form-group compact" style="margin-top: 12px;">
        <label>渠道名称</label>
        <input type="text" id="editChanNameInput" value="${escapeHtml(chan.name || '')}">
      </div>

      <div class="form-group compact">
        <label>渠道类型</label>
        <select id="editChanTypeInput">
          <option value="openai" ${chan.type === 'openai' ? 'selected' : ''}>OpenAI 兼容接口 (/v1/chat/completions)</option>
        </select>
      </div>

      <div class="form-group compact">
        <label>Base URL (基础接口地址) *</label>
        <input type="text" id="editChanBaseUrlInput" value="${escapeHtml(chan.baseUrl || '')}">
      </div>

      <div class="form-group compact">
        <label>API Key (留空表示不修改原密钥)</label>
        <input type="password" id="editChanApiKeyInput" placeholder="如需修改请输入新Key，否则留空">
      </div>

      <div class="form-group compact">
        <label>支持的模型列表 (英文逗号分隔，留空表示支持全部)</label>
        <input type="text" id="editChanModelsInput" value="${escapeHtml((chan.models || []).join(', '))}">
      </div>

      <div class="form-group compact">
        <label>优先级 (默认 10，数值越小优先级越高)</label>
        <input type="number" id="editChanPriorityInput" value="${chan.priority || 10}" min="1" max="100">
      </div>

      <div class="modal-actions" style="margin-top: 1.5rem;">
        <button type="button" class="btn btn-secondary" id="cancelEditChanBtn">取消</button>
        <button type="button" class="btn btn-primary" id="confirmEditChanBtn">💾 保存修改</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#cancelEditChanBtn').onclick = () => modal.remove();
  modal.querySelector('#confirmEditChanBtn').onclick = async () => {
    const name = modal.querySelector('#editChanNameInput').value.trim();
    const type = modal.querySelector('#editChanTypeInput').value;
    const baseUrl = modal.querySelector('#editChanBaseUrlInput').value.trim();
    const apiKey = modal.querySelector('#editChanApiKeyInput').value.trim();
    const modelsStr = modal.querySelector('#editChanModelsInput').value.trim();
    const priority = Number(modal.querySelector('#editChanPriorityInput').value) || 10;

    if (!baseUrl) {
      showToast('请输入 Base URL', 'warning');
      return;
    }

    const updates = {
      name: name || chan.name,
      type,
      baseUrl,
      models: modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
      priority
    };

    if (apiKey) {
      updates.apiKey = apiKey;
    }

    showLoading('正在保存修改...');
    try {
      const res = await authFetch(`/admin/channels/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json();
      hideLoading();

      if (data.success) {
        showToast(data.message, 'success');
        modal.remove();
        loadChannels();
      } else {
        showToast(data.message || '更新失败', 'error');
      }
    } catch (e) {
      hideLoading();
      showToast('更新异常: ' + e.message, 'error');
    }
  };
}

async function toggleChannelEnable(id, enable) {
  try {
    const res = await authFetch(`/admin/channels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`渠道已${enable ? '启用' : '禁用'}`, 'info');
      loadChannels();
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (e) {
    showToast('更新失败: ' + e.message, 'error');
  }
}

async function deleteChannel(id, name) {
  if (!confirm(`确定要删除外部渠道 [${name}] 吗？`)) return;

  showLoading('正在删除...');
  try {
    const res = await authFetch(`/admin/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    hideLoading();
    if (data.success) {
      showToast(data.message, 'success');
      loadChannels();
    } else {
      showToast(data.message || '删除失败', 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('删除失败: ' + e.message, 'error');
  }
}

async function testChannelConnectivity(id) {
  const chan = cachedChannels.find(c => c.id === id);
  let selectModel = 'gemini-2.5-flash';
  if (chan && chan.models && chan.models.length > 0 && chan.models[0] !== '*') {
    selectModel = chan.models[0];
  }

  const inputModel = prompt(`请输入要用于测速的模型名称:`, selectModel);
  if (inputModel === null) return; // 用户取消

  showLoading(`正在使用 [${inputModel.trim() || selectModel}] 测试外部渠道连通性...`);
  try {
    const res = await authFetch(`/admin/channels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: inputModel.trim() || selectModel })
    });
    const data = await res.json();
    hideLoading();
    if (data.success) {
      showToast(`✓ ${data.message} (测试模型: ${data.data.modelTested})`, 'success');
    } else {
      showToast(`❌ ${data.message}`, 'error');
    }
  } catch (e) {
    hideLoading();
    showToast('测试异常: ' + e.message, 'error');
  }
}
