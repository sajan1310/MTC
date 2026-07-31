/* Shared behavior for every auth page (login, signup, forgot-password,
 * reset-password): CSRF header, password-visibility toggles, and a single
 * submit-JSON-form-and-show-error helper. Each page only supplies the
 * handful of lines specific to its own form -- see the bottom of this file.
 */

function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
}

// Any <button data-toggle-password="input-id"> toggles that input between
// type="password" and type="text". Works for any number of password
// fields on a page (login has one, reset-password has two).
document.querySelectorAll('[data-toggle-password]').forEach((toggleBtn) => {
    const input = document.getElementById(toggleBtn.getAttribute('data-toggle-password'));
    if (!input) return;
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.getAttribute('type') === 'password';
        input.setAttribute('type', isPassword ? 'text' : 'password');
        toggleBtn.textContent = isPassword ? 'Hide' : 'Show';
        toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
    });
});

/**
 * Wires a form's submit event to POST JSON to `endpoint` and handle the
 * common success/error/loading-state bookkeeping every auth form needs.
 *
 * @param {Object} opts
 * @param {HTMLFormElement} opts.form
 * @param {HTMLButtonElement} opts.button - disabled + relabeled while in flight
 * @param {HTMLElement} [opts.errorEl] - text content set to the error message on failure
 * @param {string} opts.endpoint
 * @param {string} opts.loadingLabel - button text while the request is in flight
 * @param {() => (object|null)} opts.buildPayload - return the JSON body, or
 *   null after setting errorEl.textContent yourself to abort client-side
 *   (e.g. "passwords do not match") without making a request.
 * @param {(data: object) => void} opts.onSuccess - called with the parsed
 *   JSON body whenever the response status is 2xx.
 */
function submitAuthForm({ form, button, errorEl, endpoint, loadingLabel, buildPayload, onSuccess }) {
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (errorEl) errorEl.textContent = '';

        const payload = buildPayload();
        if (payload === null) return;

        const originalLabel = button.textContent;
        button.disabled = true;
        button.textContent = loadingLabel;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
            });
            const data = await response.json().catch(() => ({}));

            if (response.ok) {
                onSuccess(data);
            } else if (errorEl) {
                errorEl.textContent = data.error || `Request failed (code ${response.status}).`;
            }
        } catch (err) {
            console.error('Auth request failed:', err);
            if (errorEl) errorEl.textContent = 'A network error occurred. Please try again.';
        } finally {
            button.disabled = false;
            button.textContent = originalLabel;
        }
    });
}

// ── Per-page wiring: each block only runs if its form is on the page ───────

const loginForm = document.getElementById('login-form');
if (loginForm) {
    submitAuthForm({
        form: loginForm,
        button: document.getElementById('login-btn'),
        errorEl: document.getElementById('error-message'),
        endpoint: '/auth/api/login',
        loadingLabel: 'Signing in…',
        buildPayload() {
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const remember = document.getElementById('remember')?.checked || false;
            if (!email || !password) {
                document.getElementById('error-message').textContent = 'Email and password are required.';
                return null;
            }
            return { email, password, remember };
        },
        onSuccess(data) {
            window.location.href = data.redirect_url || '/';
        },
    });
}

const signupForm = document.getElementById('signup-form');
if (signupForm) {
    submitAuthForm({
        form: signupForm,
        button: document.getElementById('signup-btn'),
        errorEl: document.getElementById('signup-error'),
        endpoint: '/auth/api/signup',
        loadingLabel: 'Creating…',
        buildPayload() {
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const confirm_password = document.getElementById('confirm_password').value;
            const errorEl = document.getElementById('signup-error');
            if (!name || !email || !password || !confirm_password) {
                errorEl.textContent = 'All fields are required.';
                return null;
            }
            if (password !== confirm_password) {
                errorEl.textContent = 'Passwords do not match.';
                return null;
            }
            return { name, email, password, confirm_password };
        },
        onSuccess(data) {
            window.location.href = data.redirect_url || '/';
        },
    });
}

const forgotForm = document.getElementById('forgot-form');
if (forgotForm) {
    submitAuthForm({
        form: forgotForm,
        button: document.getElementById('forgot-btn'),
        endpoint: '/auth/api/forgot-password',
        loadingLabel: 'Sending…',
        buildPayload() {
            const email = document.getElementById('email').value.trim();
            const msgEl = document.getElementById('forgot-msg');
            if (!email) {
                msgEl.textContent = 'Email is required.';
                msgEl.classList.remove('success-message');
                msgEl.style.display = 'block';
                return null;
            }
            return { email };
        },
        onSuccess(data) {
            const msgEl = document.getElementById('forgot-msg');
            msgEl.textContent = data.message || 'If an account exists for that email, a reset link will be sent.';
            msgEl.classList.add('success-message');
            msgEl.style.display = 'block';
            // Dev-mode only: the backend includes reset_url directly in the
            // response when FLASK_ENV=development, since no SMTP/email
            // delivery is configured yet -- see app/auth/routes.py.
            if (data.reset_url) {
                const link = document.createElement('a');
                link.href = data.reset_url;
                link.textContent = 'Open reset link (dev mode only)';
                link.style.display = 'block';
                link.style.marginTop = '0.75rem';
                msgEl.appendChild(link);
            }
        },
    });
}

const resetForm = document.getElementById('reset-form');
if (resetForm) {
    submitAuthForm({
        form: resetForm,
        button: document.getElementById('reset-btn'),
        errorEl: document.getElementById('reset-error'),
        endpoint: '/auth/api/reset-password',
        loadingLabel: 'Resetting…',
        buildPayload() {
            const password = document.getElementById('password').value;
            const confirm_password = document.getElementById('confirm_password').value;
            const errorEl = document.getElementById('reset-error');
            if (!password || !confirm_password) {
                errorEl.textContent = 'Please enter and confirm your new password.';
                return null;
            }
            if (password !== confirm_password) {
                errorEl.textContent = 'Passwords do not match.';
                return null;
            }
            return { token: resetForm.dataset.token, password, confirm_password };
        },
        onSuccess(data) {
            window.location.href = data.redirect_url || '/auth/login';
        },
    });
}
