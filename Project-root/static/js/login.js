function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
}

// Toggle password visibility
const passwordInput = document.getElementById('password');
const toggleBtn = document.getElementById('toggle-password');
if (toggleBtn && passwordInput) {
    toggleBtn.addEventListener('click', () => {
        const isPassword = passwordInput.getAttribute('type') === 'password';
        passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
        toggleBtn.textContent = isPassword ? 'Hide' : 'Show';
        toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    });
}

document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message');
    const btn = document.getElementById('login-btn');
    const remember = document.getElementById('remember')?.checked || false;

    errorMessage.textContent = '';

    if (!email || !password) {
        errorMessage.textContent = 'Email and password are required.';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCsrfToken()
            },
            body: JSON.stringify({ email, password, remember }),
            credentials: 'same-origin'
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok && data && data.success) {
            window.location.href = data.redirect_url || '/';
        } else {
            errorMessage.textContent = (data && data.error) || `Login failed (code ${response.status}).`;
        }
    } catch (error) {
        console.error('Login request failed:', error);
        errorMessage.textContent = 'A network error occurred. Please try again.';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in';
    }
});
