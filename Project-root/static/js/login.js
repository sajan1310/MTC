document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message');

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            window.location.href = data.redirect_url;
        } else {
            errorMessage.textContent = data.error || 'An unknown error occurred.';
        }
    } catch (error) {
        console.error('Login request failed:', error);
        errorMessage.textContent = 'A network error occurred. Please try again.';
    }
});
