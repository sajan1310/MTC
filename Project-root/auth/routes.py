import json
import os
from flask import Blueprint, request, jsonify, redirect, url_for, render_template, current_app, session
from flask_login import login_user, logout_user, login_required, current_user
import re
import requests
from requests.exceptions import HTTPError, RequestException
from oauthlib.oauth2 import WebApplicationClient
import database
import psycopg2.extras
from werkzeug.security import check_password_hash, generate_password_hash

auth = Blueprint('auth', __name__)

# Initialize the client lazily within the request context
def get_oauth_client():
    """Creates and returns a WebApplicationClient instance."""
    return WebApplicationClient(current_app.config['GOOGLE_CLIENT_ID'])

def get_google_provider_cfg():
    return requests.get(current_app.config['GOOGLE_DISCOVERY_URL']).json()

@auth.route("/login")
def login():
    # If already authenticated, send to dashboard
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return render_template("login.html")

@auth.route("/signup")
def signup():
    return render_template("signup.html")

@auth.route("/forgot-password")
def forgot_password():
    return render_template("forgot_password.html")

@auth.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    remember = bool(data.get("remember"))

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user_row = cur.fetchone()

            if user_row and user_row['password_hash'] and check_password_hash(user_row['password_hash'], password):
                from models import User
                user_obj = User(user_row)
                login_user(user_obj, remember=remember)
                # Align session permanence to remember flag
                session.permanent = bool(remember)
                return jsonify({"success": True, "redirect_url": url_for("home")})

            # Optional demo login (dev/test only)
            if current_app.debug or current_app.config.get('TESTING'):
                demo_user = current_app.config.get('DEMO_USER_EMAIL', 'demo@example.com')
                demo_pass = current_app.config.get('DEMO_USER_PASSWORD', 'Demo@1234')
                if email == demo_user and password == demo_pass:
                    # Build a faux user row compatible with models.User
                    demo_row = {
                        'user_id': -1,
                        'name': 'Demo User',
                        'email': demo_user,
                        'role': 'admin',
                        'profile_picture': None,
                        'company': None,
                        'mobile': None,
                    }
                    from models import User
                    user_obj = User(demo_row)
                    login_user(user_obj, remember=remember)
                    session.permanent = bool(remember)
                    return jsonify({"success": True, "redirect_url": url_for("home")})

            return jsonify({"error": "Invalid credentials"}), 401
    except Exception as e:
        current_app.logger.error(f"API login error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500

def _is_valid_email(email: str) -> bool:
    if not email:
        return False
    # Simple RFC5322-lite pattern
    pattern = r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$"
    return re.match(pattern, email) is not None

def _validate_password_strength(password: str):
    # Similar to app.validate_password, duplicated here to avoid circular imports
    if len(password) < 8:
        return False, "Password must be at least 8 characters long"
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter"
    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter"
    if not re.search(r"[0-9]", password):
        return False, "Password must contain at least one number"
    if not re.search(r"[!@#$%^&*()_\-+=\[\]{};:'\",.<>?/\\|`~]", password):
        return False, "Password must contain at least one special character"
    return True, "OK"

@auth.route("/api/signup", methods=["POST"])
def api_signup():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    confirm = data.get("confirm_password") or data.get("confirm") or ""

    if not name or not email or not password or not confirm:
        return jsonify({"error": "All fields are required."}), 400
    if not _is_valid_email(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if password != confirm:
        return jsonify({"error": "Passwords do not match."}), 400
    ok, msg = _validate_password_strength(password)
    if not ok:
        return jsonify({"error": msg}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            # Check existing user
            cur.execute("SELECT user_id FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                return jsonify({"error": "An account with this email already exists."}), 409

            # Create user with default role 'user'
            password_hash = generate_password_hash(password)
            cur.execute(
                """
                INSERT INTO users (name, email, role, password_hash)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (name, email, "user", password_hash)
            )
            new_user = cur.fetchone()
            from models import User
            user_obj = User(new_user)
            login_user(user_obj)
            session.permanent = False
            return jsonify({"success": True, "redirect_url": url_for("home")}), 201
    except Exception as e:
        current_app.logger.error(f"API signup error: {e}")
        return jsonify({"error": "Failed to create account. Please try again."}), 500

@auth.route("/api/forgot-password", methods=["POST"])
def api_forgot_password():
    # Keep it simple: accept an email and always return a generic message.
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    if _is_valid_email(email):
        current_app.logger.info(f"[ForgotPassword] Request received for {email}")
    # Generic response to avoid user enumeration
    return jsonify({"message": "If an account exists for that email, a reset link will be sent."}), 200

@auth.route("/auth/google")
def auth_google():
    """Initiate Google OAuth login flow with state to prevent CSRF."""
    client = get_oauth_client()
    google_provider_cfg = get_google_provider_cfg()
    authorization_endpoint = google_provider_cfg["authorization_endpoint"]

    # Build redirect URI and state
    redirect_uri = url_for("auth.auth_google_callback", _external=True)
    state = os.urandom(24).hex()
    session['oauth_state'] = state
    current_app.logger.info(f"[OAuth] Initiating Google login with redirect_uri: {redirect_uri}")

    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=redirect_uri,
        scope=["openid", "email", "profile"],
        state=state,
        prompt="select_account"
    )
    current_app.logger.info(f"[OAuth] Redirecting user to: {request_uri[:100]}...")
    return redirect(request_uri)

@auth.route("/auth/google/callback")
def auth_google_callback():
    """Handle Google OAuth callback."""
    current_app.logger.info(f"[OAuth] Callback received at {request.url}")
    
    # ✅ OAUTH FIX: Check for error from Google
    error = request.args.get('error')
    if error:
        current_app.logger.error(f"[OAuth] Google returned error: {error}")
        return f"Google OAuth error: {error}", 400
    
    # Validate state to prevent CSRF attacks
    returned_state = request.args.get('state')
    expected_state = session.pop('oauth_state', None)
    if expected_state and returned_state != expected_state:
        current_app.logger.error("[OAuth] State mismatch in callback")
        return "Invalid OAuth state", 400

    client = get_oauth_client()
    code = request.args.get("code")
    if not code:
        current_app.logger.error("[OAuth] No authorization code in callback")
        return "Missing authorization code", 400
    
    google_provider_cfg = get_google_provider_cfg()
    token_endpoint = google_provider_cfg["token_endpoint"]

    try:
        # ✅ OAUTH FIX: Use same redirect_uri as authorization request
        redirect_uri = url_for("auth.auth_google_callback", _external=True)
        current_app.logger.info(f"[OAuth] Exchanging code for token with redirect_uri: {redirect_uri}")
        
        token_url, headers, body = client.prepare_token_request(
            token_endpoint,
            authorization_response=request.url,
            # oauthlib expects redirect_url param name; it will emit 'redirect_uri' in the request body
            redirect_url=redirect_uri,
            code=code
        )
        token_response = requests.post(
            token_url,
            headers=headers,
            data=body,
            auth=(current_app.config['GOOGLE_CLIENT_ID'], current_app.config['GOOGLE_CLIENT_SECRET']),
        )
        token_response.raise_for_status()

        client.parse_request_body_response(json.dumps(token_response.json()))

        userinfo_endpoint = google_provider_cfg["userinfo_endpoint"]
        uri, headers, body = client.add_token(userinfo_endpoint)
        userinfo_response = requests.get(uri, headers=headers, data=body)
        userinfo_response.raise_for_status()
        user_info = userinfo_response.json()
        current_app.logger.info(f"[OAuth] Successfully retrieved user info for {user_info.get('email')}")

        if user_info.get("email_verified"):
            from app import get_or_create_user
            user_obj, is_new = get_or_create_user(user_info)
            
            if user_obj:
                login_user(user_obj)
                current_app.logger.info(f"[OAuth] User {user_obj.email} logged in successfully (new={is_new})")
                return redirect(url_for("home"))

        current_app.logger.warning("[OAuth] User email not verified by Google")
        return "User email not available or not verified by Google.", 400
    except HTTPError as e:
        current_app.logger.error(f"[OAuth] HTTP error during token exchange: {e.response.status_code} - {e.response.text}")
        return f"An error occurred during authentication: {e.response.status_code}", 500
    except RequestException as e:
        current_app.logger.error(f"[OAuth] Request error during token/userinfo exchange: {type(e).__name__}: {e}")
        return "A network error occurred during authentication.", 502
    except Exception as e:
        current_app.logger.error(f"[OAuth] Unexpected error in callback: {type(e).__name__}: {e}")
        return "An error occurred during the authentication process.", 500


@auth.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("auth.login"))
