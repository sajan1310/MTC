import json
from flask import Blueprint, request, jsonify, redirect, url_for, render_template, current_app
from flask_login import login_user, logout_user, login_required
import requests
from requests.exceptions import HTTPError, RequestException
from oauthlib.oauth2 import WebApplicationClient
import database
import psycopg2.extras
from werkzeug.security import check_password_hash

auth = Blueprint('auth', __name__)

# Initialize the client lazily within the request context
def get_oauth_client():
    """Creates and returns a WebApplicationClient instance."""
    return WebApplicationClient(current_app.config['GOOGLE_CLIENT_ID'])

def get_google_provider_cfg():
    return requests.get(current_app.config['GOOGLE_DISCOVERY_URL']).json()

@auth.route("/login")
def login():
    print("Login route called")
    return render_template("login.html")

@auth.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json()
    email = data.get("email")
    password = data.get("password")

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user_row = cur.fetchone()

            if user_row and user_row['password_hash'] and check_password_hash(user_row['password_hash'], password):
                from models import User
                user_obj = User(user_row)
                login_user(user_obj)
                return jsonify({"success": True, "redirect_url": url_for("home")})
            
            return jsonify({"error": "Invalid credentials"}), 401
    except Exception as e:
        current_app.logger.error(f"API login error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500

@auth.route("/auth/google")
def auth_google():
    """Initiate Google OAuth login flow."""
    client = get_oauth_client()
    google_provider_cfg = get_google_provider_cfg()
    authorization_endpoint = google_provider_cfg["authorization_endpoint"]

    # ✅ OAUTH FIX: Build redirect URI and log it for debugging
    redirect_uri = url_for("auth.auth_google_callback", _external=True)
    current_app.logger.info(f"[OAuth] Initiating Google login with redirect_uri: {redirect_uri}")
    
    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=redirect_uri,
        scope=["openid", "email", "profile"],
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
