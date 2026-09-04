/**
 * 外部上游渠道分流管理模块 (AIStudioToAPI / token.mx.mk / OneAPI)
 */

// 生成随机英文字符串作为分流路径 (如 /vip-a8f2 或 /fast-k9x2)
function generateRandomPathPrefix() {
  const words = ['vip', 'fast', 'chan', 'pro', 'speed', 'turbo', 'relay', 'edge', 'pool', 'direct'];
  const word = words[Math.floor(Math.random() * words.length)];
  const randStr = Math.random().toString(36).substring(2, 6);
  return `/${word}-${randStr}`;
}

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
        <p style="font-size: 0.82rem; margin-bottom: 12px;">可添加多个第三方账号，并设置本地分流路径（如 <code>/v2</code>、<code>/v3</code> 等）进行独立路由分流</p>
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
    
    // 识别接口来源标签
    let endpointTag = '自定义接口';
    if (c.baseUrl?.includes('token.mx.mk/v2')) endpointTag = '⚡ mx.mk v2';
    else if (c.baseUrl?.includes('token.mx.mk/v3')) endpointTag = '⚡ mx.mk v3';
    else if (c.baseUrl?.includes('token.mx.mk/v1')) endpointTag = '⚡ mx.mk v1';
    else if (c.baseUrl?.includes('127.0.0.1') || c.baseUrl?.includes('localhost')) endpointTag = '💻 AIStudio 本地';

    const pathPrefix = c.pathPrefix ? (c.pathPrefix.startsWith('/') ? c.pathPrefix : '/' + c.pathPrefix) : '';
    const defaultModelText = c.defaultModel ? c.defaultModel : '无 (保持原模型)';
    
    return `
      <div style="background: var(--bg-body, #f8fafc); border: 1px solid var(--border-color, #e2e8f0); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-size: 1.1rem;">${isEnabled ? '🟢' : '⚪'}</span>
            <strong style="font-size: 1rem; color: var(--text-color, #1e293b);">${escapeHtml(c.name)}</strong>
            <span style="background: rgba(99, 102, 241, 0.12); color: var(--primary, #4f46e5); padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: bold;">
              ${(c.type || 'openai').toUpperCase()}
            </span>
            <span style="background: rgba(16, 185, 129, 0.12); color: #059669; padding: 1px 6px; border-radius: 4px; font-size: 0.75rem;">
              ${endpointTag}
            </span>
            ${pathPrefix ? `
              <span style="background: rgba(245, 158, 11, 0.15); color: #b45309; padding: 1px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; border: 1px dashed rgba(245, 158, 11, 0.4);">
                🔀 分流路径: ${escapeHtml(pathPrefix)}
              </span>
            ` : `
              <span style="background: rgba(148, 163, 184, 0.15); color: #64748b; padding: 1px 6px; border-radius: 4px; font-size: 0.75rem;">
                全局默认轮询/降级
              </span>
            `}
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
          ${pathPrefix ? `
            <div style="grid-column: 1 / -1; background: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between;">
              <div>
                <strong>📍 客户端分流调用端点:</strong> 
                <code style="color: #b45309; font-weight: bold;">${escapeHtml(pathPrefix)}/chat/completions</code> 或 <code style="color: #b45309; font-weight: bold;">${escapeHtml(pathPrefix)}/messages</code>
              </div>
              <button class="btn btn-xs btn-secondary" onclick="navigator.clipboard.writeText('${escapeJs(pathPrefix)}/chat/completions'); showToast('已复制分流端点路径', 'info');">📋 复制</button>
            </div>
          ` : ''}
          <div><strong>上游接口地址 (Base URL):</strong> <code style="color: var(--primary); word-break: break-all;">${escapeHtml(c.baseUrl)}</code></div>
          <div><strong>API Key:</strong> <code>${c.apiKeyMasked || '（无密钥/免密）'}</code></div>
          <div><strong>累计调用 / Token:</strong> <span style="font-weight: bold; color: var(--primary);">${totalReq} 次</span> / <span>${totalTok.toLocaleString()} Tokens</span></div>
          <div><strong>优先级:</strong> ${c.priority || 10} (值越小越优先)</div>
          <div style="grid-column: 1 / -1;"><strong>支持模型:</strong> <span style="color: #059669;">${escapeHtml(modelsText)}</span></div>
          <div style="grid-column: 1 / -1;"><strong>默认降级模型:</strong> <span style="color: #b45309; font-weight: bold;">${escapeHtml(defaultModelText)}</span> <span style="font-size: 0.78rem; color: #94a3b8;">（当请求不受支持的模型时自动转换为此模型转发）</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function showAddChannelModal() {
  const modal = document.createElement('div');
  modal.className = 'modal form-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 540px;">
      <div class="modal-title">➕ 添加外部上游渠道</div>

      <div class="form-group compact" style="margin-top: 12px;">
        <label>渠道名称</label>
        <input type="text" id="chanNameInput" placeholder="例如: mx.mk v2 账号" value="">
      </div>

      <div class="form-group compact">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <label style="margin-bottom: 0;">🔀 本地分流路径 (支持任意英文/版本)</label>
          <button type="button" class="btn btn-xs btn-secondary" id="randomGenAddPathBtn" style="padding: 1px 6px; font-size: 0.75rem;">🎲 随机生成英文字符</button>
        </div>
        <div style="display: flex; gap: 6px; margin-top: 4px;">
          <input type="text" id="chanPathPrefixInput" placeholder="例如: /v2, /v3, /vip, /fast" value="" style="flex: 1;">
        </div>
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 4px; line-height: 1.4;">
          💡 支持 <code>/v2</code>、<code>/v3</code> 或任意英文如 <code>/vip</code>、<code>/fast</code>、<code>/backup</code>。设置后客户端访问 <code>http://IP:8045/xxx/chat/completions</code> 直接走此专属渠道；若多个渠道填相同路径则自动负载均衡；留空则仅参与全局轮询。
        </div>
      </div>

      <div class="form-group compact">
        <label>渠道类型</label>
        <select id="chanTypeInput">
          <option value="openai">OpenAI 兼容接口 (/chat/completions)</option>
        </select>
      </div>

      <div class="form-group compact">
        <label>上游接口地址 (Base URL) *</label>
        <input type="text" id="chanBaseUrlInput" placeholder="例如: https://token.mx.mk/v2" value="">
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">例如: <code>https://token.mx.mk/v2</code>、<code>https://token.mx.mk/v3</code> 或 <code>http://127.0.0.1:8088/v1</code></div>
      </div>

      <div class="form-group compact">
        <label>API Key (密钥，无密码可留空)</label>
        <input type="password" id="chanApiKeyInput" placeholder="sk-...">
      </div>

      <div class="form-group compact">
        <label>支持的模型列表 (英文逗号分隔，留空表示支持全部)</label>
        <input type="text" id="chanModelsInput" placeholder="例如: gpt-4o, claude-3-7-sonnet" value="">
      </div>

      <div class="form-group compact">
        <label>🛡️ 默认降级模型 (Default Fallback Model)</label>
        <input type="text" id="chanDefaultModelInput" placeholder="例如: gpt-5 或 gemini-2.5-pro (可选)">
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">
          当客户端请求该渠道不支持的模型（例如请求 <code>gpt-5.5</code>）时，自动降级为该默认模型（如 <code>gpt-5</code>）转发，防止上游报错。留空则直接透传。
        </div>
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

  const baseUrlInput = modal.querySelector('#chanBaseUrlInput');
  const pathPrefixInput = modal.querySelector('#chanPathPrefixInput');
  const nameInput = modal.querySelector('#chanNameInput');
  const modelsInput = modal.querySelector('#chanModelsInput');
  const defaultModelInput = modal.querySelector('#chanDefaultModelInput');

  const randomAddBtn = modal.querySelector('#randomGenAddPathBtn');
  if (randomAddBtn) {
    randomAddBtn.onclick = () => {
      pathPrefixInput.value = generateRandomPathPrefix();
    };
  }

  modal.querySelector('#cancelAddChanBtn').onclick = () => modal.remove();
  modal.querySelector('#confirmAddChanBtn').onclick = async () => {
    const name = modal.querySelector('#chanNameInput').value.trim();
    const pathPrefix = modal.querySelector('#chanPathPrefixInput').value.trim();
    const type = modal.querySelector('#chanTypeInput').value;
    const baseUrl = modal.querySelector('#chanBaseUrlInput').value.trim();
    const apiKey = modal.querySelector('#chanApiKeyInput').value.trim();
    const modelsStr = modal.querySelector('#chanModelsInput').value.trim();
    const defaultModel = modal.querySelector('#chanDefaultModelInput').value.trim();
    const priority = Number(modal.querySelector('#chanPriorityInput').value) || 10;

    if (!baseUrl) {
      showToast('请输入上游接口 Base URL', 'warning');
      return;
    }

    showLoading('正在添加渠道...');
    try {
      const res = await authFetch('/admin/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || '外部渠道',
          pathPrefix,
          type,
          baseUrl,
          apiKey,
          models: modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
          defaultModel,
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
    <div class="modal-content" style="max-width: 540px;">
      <div class="modal-title">✏️ 编辑外部上游渠道配置</div>

      <div class="form-group compact" style="margin-top: 12px;">
        <label>渠道名称</label>
        <input type="text" id="editChanNameInput" value="${escapeHtml(chan.name || '')}">
      </div>

      <div class="form-group compact">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <label style="margin-bottom: 0;">🔀 本地分流路径 (支持任意英文/版本)</label>
          <button type="button" class="btn btn-xs btn-secondary" id="randomGenEditPathBtn" style="padding: 1px 6px; font-size: 0.75rem;">🎲 随机生成英文字符</button>
        </div>
        <div style="display: flex; gap: 6px; margin-top: 4px;">
          <input type="text" id="editChanPathPrefixInput" value="${escapeHtml(chan.pathPrefix || '')}" placeholder="例如: /v2, /v3, /vip, /fast" style="flex: 1;">
        </div>
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 4px; line-height: 1.4;">
          💡 支持 <code>/v2</code>、<code>/v3</code> 或任意英文如 <code>/vip</code>、<code>/fast</code>、<code>/backup</code>。设置后客户端访问 <code>http://IP:8045/xxx/chat/completions</code> 直接走此专属渠道；若多个渠道填相同路径则自动负载均衡；留空则仅参与全局轮询。
        </div>
      </div>

      <div class="form-group compact">
        <label>渠道类型</label>
        <select id="editChanTypeInput">
          <option value="openai" ${chan.type === 'openai' ? 'selected' : ''}>OpenAI 兼容接口 (/chat/completions)</option>
        </select>
      </div>

      <div class="form-group compact">
        <label>上游接口地址 (Base URL) *</label>
        <input type="text" id="editChanBaseUrlInput" value="${escapeHtml(chan.baseUrl || '')}">
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">例如: <code>https://token.mx.mk/v2</code> 或 <code>https://token.mx.mk/v3</code></div>
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
        <label>🛡️ 默认降级模型 (Default Fallback Model)</label>
        <input type="text" id="editChanDefaultModelInput" value="${escapeHtml(chan.defaultModel || '')}" placeholder="例如: gpt-5 或 gemini-2.5-pro (可选)">
        <div style="font-size: 0.78rem; color: #64748b; margin-top: 2px;">
          当客户端请求该渠道不支持的模型（例如请求 <code>gpt-5.5</code>）时，自动降级为该默认模型（如 <code>gpt-5</code>）转发，防止上游报错。留空则直接透传。
        </div>
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

  const editBaseUrlInput = modal.querySelector('#editChanBaseUrlInput');
  const editPathPrefixInput = modal.querySelector('#editChanPathPrefixInput');

  const randomEditBtn = modal.querySelector('#randomGenEditPathBtn');
  if (randomEditBtn) {
    randomEditBtn.onclick = () => {
      editPathPrefixInput.value = generateRandomPathPrefix();
    };
  }

  modal.querySelector('#cancelEditChanBtn').onclick = () => modal.remove();
  modal.querySelector('#confirmEditChanBtn').onclick = async () => {
    const name = modal.querySelector('#editChanNameInput').value.trim();
    const pathPrefix = modal.querySelector('#editChanPathPrefixInput').value.trim();
    const type = modal.querySelector('#editChanTypeInput').value;
    const baseUrl = modal.querySelector('#editChanBaseUrlInput').value.trim();
    const apiKey = modal.querySelector('#editChanApiKeyInput').value.trim();
    const modelsStr = modal.querySelector('#editChanModelsInput').value.trim();
    const defaultModel = modal.querySelector('#editChanDefaultModelInput').value.trim();
    const priority = Number(modal.querySelector('#editChanPriorityInput').value) || 10;

    if (!baseUrl) {
      showToast('请输入上游接口 Base URL', 'warning');
      return;
    }

    const updates = {
      name: name || chan.name,
      pathPrefix,
      type,
      baseUrl,
      models: modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
      defaultModel,
      priority
    };

    if (apiKey) {
      updates.apiKey = apiKey;
    }

    showLoading('正在保存配置...');
    try {
      const res = await authFetch(`/admin/channels/${encodeURIComponent(chan.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json();
      hideLoading();

      if (data.success) {
        showToast('渠道配置已更新！', 'success');
        modal.remove();
        loadChannels();
      } else {
        showToast(data.message || '更新失败', 'error');
      }
    } catch (e) {
      hideLoading();
      showToast('请求异常: ' + e.message, 'error');
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

  showLoading(`正在使用 [${inputModel.trim() || selectModel}] 测试渠道连通性...`);
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

