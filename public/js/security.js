// IP封禁管理

async function loadBlockedIPs() {
  try {
    const response = await authFetch('/admin/blocked-ips');
    
    if (!response.ok) throw new Error('获取封禁列表失败');
    
    const data = await response.json();
    renderBlockedIPs(data.data);
  } catch (error) {
    console.error('加载封禁列表失败:', error);
    showToast('加载封禁列表失败', 'error');
  }
}

function renderBlockedIPs(blockedIPs) {
  const container = document.getElementById('blockedIPsList');
  
  if (!blockedIPs || blockedIPs.length === 0) {
    container.innerHTML = '<div class="empty-state-small">暂无封禁IP</div>';
    return;
  }
  
  container.innerHTML = blockedIPs.map(item => {
    const isPermanent = item.permanent;
    const expiresAt = item.expiresAt ? new Date(item.expiresAt).toLocaleString('zh-CN') : '';
    const tempBlockCount = item.tempBlockCount || 0;
    
    return `
      <div class="blocked-ip-item ${isPermanent ? 'permanent' : 'temporary'}">
        <div class="blocked-ip-header">
          <span class="blocked-ip-address">${item.ip}</span>
          <span class="blocked-ip-type ${isPermanent ? 'permanent' : 'temporary'}">
            ${isPermanent ? '永久封禁' : '临时封禁'}
          </span>
        </div>
        <div class="blocked-ip-info">
          ${!isPermanent && expiresAt ? `<div>⏰ 解封时间: ${expiresAt}</div>` : ''}
          <div>🔢 累计封禁: ${tempBlockCount} 次</div>
        </div>
        <div class="blocked-ip-actions">
          <button class="btn btn-sm btn-warning" onclick="unblockIP('${item.ip}')">
            🔓 解除封禁
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function manualAddBlockIP() {
  const input = document.getElementById('manualBlockIPInput');
  const ip = (input?.value || '').trim();

  if (!ip) {
    showToast('请输入要封禁的 IP 地址', 'warning');
    return;
  }

  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^([a-fA-F0-9:]+)$/;
  if (!ipPattern.test(ip)) {
    showToast('IP 地址格式不正确', 'warning');
    return;
  }

  showLoading(`正在封禁 IP ${ip}...`);
  try {
    const response = await authFetch('/admin/block-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, permanent: true })
    });
    const data = await response.json();
    hideLoading();

    if (data.success) {
      showToast(data.message, 'success');
      if (input) input.value = '';
      loadBlockedIPs();
    } else {
      showToast(data.message || '封禁失败', 'error');
    }
  } catch (error) {
    hideLoading();
    showToast('请求失败: ' + error.message, 'error');
  }
}

// 快速封禁 IP（供日志页面等跨模块直接调用）
async function quickBlockIP(ip) {
  if (!confirm(`🚨 确认立即将扫描/违规 IP [${ip}] 加入黑名单并永久拦截吗？`)) {
    return;
  }

  showLoading(`正在封禁 IP [${ip}]...`);
  try {
    const response = await authFetch('/admin/block-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, permanent: true })
    });
    const data = await response.json();
    hideLoading();

    if (data.success) {
      showToast(`✓ IP [${ip}] 已成功加入黑名单封禁！`, 'success');
      if (typeof loadBlockedIPs === 'function') {
        loadBlockedIPs();
      }
    } else {
      showToast(data.message || '封禁失败', 'error');
    }
  } catch (error) {
    hideLoading();
    showToast('封禁请求失败: ' + error.message, 'error');
  }
}

async function unblockIP(ip) {
  if (!confirm(`确定要解除 ${ip} 的封禁吗？`)) return;
  
  try {
    const response = await authFetch('/admin/unblock-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(data.message || 'IP已解除封禁', 'success');
      loadBlockedIPs();
    } else {
      showToast(data.message || '解除封禁失败', 'error');
    }
  } catch (error) {
    console.error('解除封禁失败:', error);
    showToast('解除封禁失败', 'error');
  }
}

// 白名单管理
async function loadWhitelistIPs() {
  try {
    const response = await authFetch('/admin/security-config');
    const data = await response.json();
    
    if (data.success) {
      // 更新临时列表
      tempWhitelistIPs = [...(data.data.whitelist.ips || [])];
      renderWhitelistIPs(tempWhitelistIPs);
      
      // 更新封禁开关状态
      const checkbox = document.getElementById('blockingEnabled');
      if (checkbox) checkbox.checked = data.data.blocking.enabled;
    }
  } catch (error) {
    console.error('加载白名单失败:', error);
  }
}

function renderWhitelistIPs(ips) {
  const container = document.getElementById('whitelistIPsList');
  
  if (!ips || ips.length === 0) {
    container.innerHTML = '<div class="empty-state-small">暂无白名单IP</div>';
    return;
  }
  
  container.innerHTML = ips.map(ip => `
    <div class="whitelist-ip-tag">
      <span>${ip}</span>
      <button onclick="removeWhitelistIP('${ip}')" title="移除">✕</button>
    </div>
  `).join('');
}

// 临时存储白名单IP列表（未保存状态）
let tempWhitelistIPs = [];

function addWhitelistIP() {
  const input = document.getElementById('whitelistIPInput');
  const ip = input.value.trim();
  
  if (!ip) {
    showToast('请输入IP地址', 'warning');
    return;
  }
  
  // 简单的IP格式验证
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (!ipPattern.test(ip)) {
    showToast('IP地址格式不正确', 'warning');
    return;
  }
  
  // 检查是否已存在
  if (tempWhitelistIPs.includes(ip)) {
    showToast('该IP已在白名单中', 'warning');
    return;
  }
  
  // 添加到临时列表
  tempWhitelistIPs.push(ip);
  input.value = '';
  
  // 更新显示
  renderWhitelistIPs(tempWhitelistIPs);
  //showToast('已添加，请点击保存配置按钮保存', 'info');
}

function removeWhitelistIP(ip) {
  // 从临时列表中移除
  tempWhitelistIPs = tempWhitelistIPs.filter(item => item !== ip);
  
  // 更新显示
  renderWhitelistIPs(tempWhitelistIPs);
  //showToast('已移除，请点击保存配置按钮保存', 'info');
}

// ---------------- 2FA 双因素身份验证管理 ----------------

async function load2FAStatus() {
  try {
    const res = await authFetch('/admin/2fa/status');
    const data = await res.json();
    if (data.success) {
      const { enabled, remainingBackupCodes, passkeys } = data.data;
      const badge = document.getElementById('twoFactorStatusBadge');
      const enableBtn = document.getElementById('twoFactorEnableBtn');
      const disableBtn = document.getElementById('twoFactorDisableBtn');
      const backupInfo = document.getElementById('twoFactorBackupCodesInfo');
      const backupCount = document.getElementById('twoFactorBackupCodesCount');
      const passkeyContainer = document.getElementById('passkeyListContainer');
      const passkeyList = document.getElementById('passkeyItemsList');

      if (badge) {
        badge.textContent = enabled ? '已开启' : '未开启';
        badge.style.color = enabled ? '#10b981' : '#ef4444';
      }
      if (enableBtn) enableBtn.style.display = enabled ? 'none' : 'inline-block';
      if (disableBtn) disableBtn.style.display = enabled ? 'inline-block' : 'none';
      if (backupInfo && backupCount) {
        if (enabled && remainingBackupCodes > 0) {
          backupInfo.style.display = 'block';
          backupCount.textContent = remainingBackupCodes || 0;
        } else {
          backupInfo.style.display = 'none';
        }
      }

      // 渲染已绑定的通行密钥列表
      if (passkeyContainer && passkeyList) {
        if (Array.isArray(passkeys) && passkeys.length > 0) {
          passkeyContainer.style.display = 'block';
          passkeyList.innerHTML = passkeys.map(p => `
            <div style="display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px;">
              <div>
                <strong>🔑 ${escapeHtml(p.name)}</strong>
                <span style="color: #64748b; font-size: 0.78rem; margin-left: 8px;">ID: ${escapeHtml(p.id.substring(0, 12))}...</span>
              </div>
              <button type="button" class="btn btn-sm btn-danger" onclick="deletePasskey('${p.id}', '${escapeHtml(p.name)}')" style="padding: 2px 8px; font-size: 0.75rem;">移除</button>
            </div>
          `).join('');
        } else {
          passkeyContainer.style.display = 'none';
          passkeyList.innerHTML = '';
        }
      }
    }
  } catch (err) {
    console.error('获取 2FA 状态失败:', err);
  }
}

// 绑定/注册 WebAuthn 通行密钥 (Passkey)
async function registerPasskey() {
  if (!window.PublicKeyCredential) {
    showToast('当前浏览器环境不支持 WebAuthn / 通行密钥 (Passkey)', 'error');
    return;
  }

  const keyName = prompt('请为这个通行密钥命名 (例如: 我的 MacBook 指纹 / Windows Hello / YubiKey):', '我的通行密钥');
  if (keyName === null) return;

  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);
  const userId = new Uint8Array(16);
  window.crypto.getRandomValues(userId);

  const createOptions = {
    publicKey: {
      challenge,
      rp: { name: "Antigravity2API 管理面板" },
      user: {
        id: userId,
        name: "admin",
        displayName: "系统管理员"
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },  // ES256
        { alg: -257, type: "public-key" } // RS256
      ],
      authenticatorSelection: {
        userVerification: "preferred"
      },
      timeout: 60000
    }
  };

  showLoading('请在弹出的系统提示中进行生物识别（指纹/人脸/PIN/安全密钥）...');
  try {
    const credential = await navigator.credentials.create(createOptions);
    hideLoading();
    if (!credential) {
      showToast('通行密钥创建已取消', 'warning');
      return;
    }

    const passkeyId = credential.id;
    showLoading('正在保存通行密钥...');
    const res = await authFetch('/admin/2fa/passkey/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passkeyId,
        name: keyName.trim() || '我的通行密钥'
      })
    });
    const data = await res.json();
    hideLoading();

    if (data.success) {
      showToast('🎉 通行密钥绑定成功！下次登录可直接免输动态码', 'success');
      load2FAStatus();
    } else {
      showToast(data.message || '绑定失败', 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('通行密钥注册失败: ' + err.message, 'error');
  }
}

// 移除通行密钥
async function deletePasskey(id, name) {
  if (!confirm(`确定要移除通行密钥 [${name}] 吗？`)) return;

  showLoading('正在删除...');
  try {
    const res = await authFetch(`/admin/2fa/passkey/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    hideLoading();
    if (data.success) {
      showToast(data.message, 'success');
      load2FAStatus();
    } else {
      showToast(data.message || '删除失败', 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('删除失败: ' + err.message, 'error');
  }
}

async function show2FASetupModal() {
  showLoading('正在生成 2FA 密钥...');
  try {
    const res = await authFetch('/admin/2fa/setup', { method: 'POST' });
    const data = await res.json();
    hideLoading();

    if (!data.success) {
      showToast(data.message || '生成 2FA 密钥失败', 'error');
      return;
    }

    const { secret } = data.data;
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 480px;">
        <div class="modal-title">🔑 绑定 2FA 双因素验证</div>
        <div style="margin-top: 12px; font-size: 0.88rem; color: var(--text-light, #666); line-height: 1.5;">
          请使用身份验证器软件（如 <strong>Google Authenticator</strong>、<strong>Microsoft Authenticator</strong> 或 <strong>1Password</strong>）添加以下密钥：
        </div>

        <div style="background: #f1f5f9; padding: 12px; border-radius: 6px; text-align: center; margin: 12px 0;">
          <div style="font-size: 0.8rem; color: #64748b;">绑定密钥 (Secret Key)</div>
          <div style="font-family: monospace; font-size: 1.2rem; font-weight: bold; color: var(--primary, #4f46e5); margin-top: 4px; letter-spacing: 2px;">${secret}</div>
          <button class="btn btn-sm" onclick="copyToClipboard('${secret}', '2FA 密钥已复制')" style="margin-top: 6px; padding: 2px 8px; font-size: 0.75rem;">📋 复制密钥</button>
        </div>

        <div class="form-group compact" style="margin-top: 12px;">
          <label>请输入验证码软件上显示的 6 位动态数字</label>
          <input type="text" id="verify2FACodeInput" placeholder="例如: 123456" maxlength="6" style="letter-spacing: 4px; font-size: 1.1rem; text-align: center;">
        </div>

        <div class="modal-actions" style="margin-top: 1.5rem;">
          <button class="btn btn-secondary" id="cancel2FASetupBtn">取消</button>
          <button class="btn btn-primary" id="confirm2FASetupBtn">验证并开启</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const cancelBtn = modal.querySelector('#cancel2FASetupBtn');
    const confirmBtn = modal.querySelector('#confirm2FASetupBtn');
    const inputCode = modal.querySelector('#verify2FACodeInput');

    cancelBtn.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    confirmBtn.addEventListener('click', async () => {
      const code = inputCode.value.trim();
      if (!code || code.length !== 6) {
        showToast('请输入 6 位有效验证码', 'warning');
        return;
      }

      showLoading('正在校验并开启 2FA...');
      try {
        const verifyRes = await authFetch('/admin/2fa/verify-enable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, code })
        });
        const verifyData = await verifyRes.json();
        hideLoading();

        if (verifyData.success) {
          modal.remove();
          showBackupCodesModal(verifyData.data.backupCodes);
          load2FAStatus();
        } else {
          showToast(verifyData.message || '验证码错误，无法开启 2FA', 'error');
        }
      } catch (err) {
        hideLoading();
        showToast('开启 2FA 失败: ' + err.message, 'error');
      }
    });

  } catch (err) {
    hideLoading();
    showToast('请求失败: ' + err.message, 'error');
  }
}

function showBackupCodesModal(codes) {
  const modal = document.createElement('div');
  modal.className = 'modal form-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 480px;">
      <div class="modal-title" style="color: #10b981;">🎉 2FA 开启成功！备用恢复码</div>
      <div style="margin-top: 10px; font-size: 0.85rem; color: #ef4444; font-weight: bold; line-height: 1.5;">
        ⚠️ 请妥善保存以下备用恢复码！当您丢失手机验证码软件时，可以使用恢复码登录。每个恢复码仅限使用一次。
      </div>

      <div style="background: #0f172a; color: #38bdf8; padding: 12px; border-radius: 6px; margin: 12px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-family: monospace; font-size: 1rem; text-align: center;">
        ${codes.map(c => `<div>${c}</div>`).join('')}
      </div>

      <div style="text-align: center; margin-top: 10px;">
        <button class="btn btn-sm btn-info" onclick="copyToClipboard('${codes.join('\\n')}', '备用恢复码已复制到剪贴板')">📋 复制全部恢复码</button>
      </div>

      <div class="modal-actions" style="margin-top: 1.5rem;">
        <button class="btn btn-primary" onclick="this.closest('.modal').remove()">我已保存并理解</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function show2FADisableModal() {
  const modal = document.createElement('div');
  modal.className = 'modal form-modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 420px;">
      <div class="modal-title" style="color: #ef4444;">⚠️ 关闭 2FA 双因素身份验证</div>
      <div class="form-group compact" style="margin-top: 1rem;">
        <label>请输入管理员密码</label>
        <input type="password" id="disable2FAPassword" placeholder="当前管理员密码">
      </div>
      <div class="form-group compact" style="margin-top: 0.5rem;">
        <label>请输入当前 2FA 动态码或备用恢复码</label>
        <input type="text" id="disable2FACode" placeholder="6 位动态码或 8 位恢复码">
      </div>
      <div class="modal-actions" style="margin-top: 1.5rem;">
        <button class="btn btn-secondary" id="cancelDisable2FABtn">取消</button>
        <button class="btn btn-danger" id="confirmDisable2FABtn">确认关闭 2FA</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const cancelBtn = modal.querySelector('#cancelDisable2FABtn');
  const confirmBtn = modal.querySelector('#confirmDisable2FABtn');

  cancelBtn.addEventListener('click', () => modal.remove());

  confirmBtn.addEventListener('click', async () => {
    const password = document.getElementById('disable2FAPassword').value;
    const code = document.getElementById('disable2FACode').value;

    if (!password) {
      showToast('请输入密码', 'warning');
      return;
    }

    showLoading('正在关闭 2FA...');
    try {
      const res = await authFetch('/admin/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, code })
      });
      const data = await res.json();
      hideLoading();

      if (data.success) {
        modal.remove();
        showToast(data.message, 'success');
        load2FAStatus();
      } else {
        showToast(data.message || '关闭 2FA 失败', 'error');
      }
    } catch (err) {
      hideLoading();
      showToast('请求失败: ' + err.message, 'error');
    }
  });
}
