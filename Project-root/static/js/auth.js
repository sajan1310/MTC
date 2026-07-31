/* Shared behavior for every auth page (login, signup, forgot-password,
 * reset-password): CSRF header, password-visibility toggles, and a single
 * submit-JSON-form-and-show-error helper. Each page only supplies the
 * handful of lines specific to its own form -- see the bottom of this file.
 */

function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
}

// bi-eye / bi-eye-slash (Bootstrap Icons), matching the icon language
// already used elsewhere on these pages (16x16 viewBox, fill-rule paths).
const ICON_EYE = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>';
const ICON_EYE_SLASH = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z"/><path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z"/><path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .708-.708 12 12-.708.708z"/></svg>';

// Any <button data-toggle-password="input-id"> toggles that input between
// type="password" and type="text". Works for any number of password
// fields on a page (login has one, reset-password has two). Icon reflects
// the action a click performs: eye = "reveal it", eye-slash = "hide it".
document.querySelectorAll('[data-toggle-password]').forEach((toggleBtn) => {
    const input = document.getElementById(toggleBtn.getAttribute('data-toggle-password'));
    if (!input) return;
    toggleBtn.innerHTML = ICON_EYE;
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.getAttribute('type') === 'password';
        input.setAttribute('type', isPassword ? 'text' : 'password');
        toggleBtn.innerHTML = isPassword ? ICON_EYE_SLASH : ICON_EYE;
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
