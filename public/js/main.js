// 主入口：初始化和事件绑定

// 页面加载时初始化
initFontSize();
initSensitiveInfo();
initFilterState(); // 恢复筛选状态

// 检查登录状态并初始化
(async function initApp() {
    try {
        // 检查是否已登录（通过 Cookie）
        const loggedIn = await checkLoginStatus();
        
        // 验证完成，切换到 auth-ready 状态
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
        
        if (loggedIn) {
            showMainContent();
            // 恢复Tab状态，switchTab 内部会根据 tab 类型加载对应数据
            const savedTab = localStorage.getItem('currentTab');
            if (savedTab === 'settings') {
                switchTab('settings', false);
            } else if (savedTab === 'logs') {
                switchTab('logs', false);
            } else if (savedTab === 'geminicli') {
                switchTab('geminicli', false);
            } else {
                // 默认显示 tokens 页面
                switchTab('tokens', false);
            }
        }
    } catch (e) {
        // 验证失败也要切换状态，显示登录框
        document.documentElement.classList.remove('auth-checking');
        document.documentElement.classList.add('auth-ready');
    }
})();

// 登录表单提交
document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn.disabled) return;
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    btn.disabled = true;
    btn.classList.add('loading');
    const originalText = btn.textContent;
    btn.textContent = '登录中';
    
    try {
        const response = await fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        if (data.success) {
            if (data.require2FA) {
                // 需要 2FA 二次验证，弹出 2FA 验证框
                show2FALoginModal(data.tempToken);
                return;
            }
            // 不再存储 token 到 localStorage，使用 HttpOnly Cookie
            showToast('登录成功', 'success');
            showMainContent();
            loadTokens();
            loadConfig();
        } else {
            showToast(data.message || '用户名或密码错误', 'error');
        }
    } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = originalText;
    }
});

// 2FA 登录二次验证弹窗（支持 TOTP 动态码与 Passkey 通行密钥免密验证）
function show2FALoginModal(tempToken) {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.style.zIndex = '9999';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 400px;">
            <div class="modal-title">🔐 双因素二次验证 (2FA)</div>
            <div style="margin-top: 10px; font-size: 0.88rem; color: var(--text-light, #666); text-align: center;">
                账号已开启 2FA 保护，请输入 6 位动态验证码、备用恢复码或使用通行密钥
            </div>

            <!-- Passkey 通行密钥一键快捷验证按钮 -->
            <div style="margin-top: 15px; text-align: center;">
                <button type="button" id="usePasskeyLoginBtn" class="btn btn-info" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px;">
                    <span>🛡️</span> <strong>使用通行密钥 (Passkey / 指纹) 登录</strong>
                </button>
            </div>

            <div style="display: flex; align-items: center; margin: 15px 0; color: #94a3b8; font-size: 0.8rem;">
                <div style="flex: 1; height: 1px; background: #e2e8f0;"></div>
                <span style="padding: 0 10px;">或输入验证码</span>
                <div style="flex: 1; height: 1px; background: #e2e8f0;"></div>
            </div>

            <form id="twoFactorLoginForm" style="margin-top: 5px;">
                <div class="form-group compact">
                    <input type="text" 
                           id="login2FACodeInput" 
                           name="totp" 
                           autocomplete="one-time-code" 
                           inputmode="numeric" 
                           placeholder="6 位动态码或 8 位恢复码" 
                           style="letter-spacing: 4px; font-size: 1.1rem; text-align: center;" 
                           autofocus>
                </div>
                <div class="modal-actions" style="margin-top: 1.5rem;">
                    <button type="button" class="btn btn-secondary" id="cancelLogin2FABtn">取消</button>
                    <button type="submit" class="btn btn-primary" id="confirmLogin2FABtn">验证并登录</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    const form = modal.querySelector('#twoFactorLoginForm');
    const cancelBtn = modal.querySelector('#cancelLogin2FABtn');
    const codeInput = modal.querySelector('#login2FACodeInput');
    const passkeyBtn = modal.querySelector('#usePasskeyLoginBtn');

    cancelBtn.addEventListener('click', () => modal.remove());

    // 通行密钥 (Passkey) 认证逻辑
    if (passkeyBtn) {
        passkeyBtn.addEventListener('click', async () => {
            if (!window.PublicKeyCredential) {
                showToast('当前浏览器不支持 Passkey 通行密钥', 'warning');
                return;
            }

            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);

            showLoading('正在调用生物识别/通行密钥 (Windows Hello / Touch ID / 安全Key)...');
            try {
                const assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge,
                        timeout: 60000,
                        userVerification: "preferred"
                    }
                });
                hideLoading();

                if (!assertion) {
                    showToast('通行密钥验证取消', 'warning');
                    return;
                }

                showLoading('正在完成登录认证...');
                const response = await fetch('/admin/login/verify-2fa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        tempToken,
                        passkeyCredential: { id: assertion.id }
                    })
                });

                const data = await response.json();
                hideLoading();

                if (data.success) {
                    modal.remove();
                    showToast('🎉 通行密钥验证通过，登录成功', 'success');
                    showMainContent();
                    loadTokens();
                    loadConfig();
                } else {
                    showToast(data.message || '通行密钥校验失败', 'error');
                }
            } catch (err) {
                hideLoading();
                showToast('通行密钥验证失败: ' + err.message, 'error');
            }
        });
    }

    // 自动聚焦输入框
    setTimeout(() => {
        if (codeInput) codeInput.focus();
    }, 100);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = codeInput.value.trim();
        if (!code) {
            showToast('请输入验证码', 'warning');
            return;
        }

        showLoading('正在验证 2FA...');
        try {
            const response = await fetch('/admin/login/verify-2fa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ tempToken, code })
            });

            const data = await response.json();
            hideLoading();

            if (data.success) {
                modal.remove();
                showToast('登录成功', 'success');
                showMainContent();
                loadTokens();
                loadConfig();
            } else {
                showToast(data.message || '验证码错误', 'error');
                if (codeInput) {
                    codeInput.value = '';
                    codeInput.focus();
                }
            }
        } catch (err) {
            hideLoading();
            showToast('验证失败: ' + err.message, 'error');
        }
    });
}

// 配置表单提交
document.getElementById('configForm').addEventListener('submit', saveConfig);
