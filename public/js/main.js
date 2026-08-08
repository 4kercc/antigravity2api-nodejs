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

// 2FA 登录二次验证弹窗
function show2FALoginModal(tempToken) {
    const modal = document.createElement('div');
    modal.className = 'modal form-modal';
    modal.style.zIndex = '9999';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 400px;">
            <div class="modal-title">🔐 双因素二次验证 (2FA)</div>
            <div style="margin-top: 10px; font-size: 0.88rem; color: var(--text-light, #666); text-align: center;">
                账号已开启 2FA 保护，请输入 6 位动态验证码或备用恢复码
            </div>
            <div class="form-group compact" style="margin-top: 15px;">
                <input type="text" id="login2FACodeInput" placeholder="6 位动态码或 8 位恢复码" style="letter-spacing: 4px; font-size: 1.1rem; text-align: center;" autofocus>
            </div>
            <div class="modal-actions" style="margin-top: 1.5rem;">
                <button class="btn btn-secondary" id="cancelLogin2FABtn">取消</button>
                <button class="btn btn-primary" id="confirmLogin2FABtn">验证并登录</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const cancelBtn = modal.querySelector('#cancelLogin2FABtn');
    const confirmBtn = modal.querySelector('#confirmLogin2FABtn');
    const codeInput = modal.querySelector('#login2FACodeInput');

    cancelBtn.addEventListener('click', () => modal.remove());

    confirmBtn.addEventListener('click', async () => {
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
            }
        } catch (err) {
            hideLoading();
            showToast('验证失败: ' + err.message, 'error');
        }
    });
}

// 配置表单提交
document.getElementById('configForm').addEventListener('submit', saveConfig);
