import json
from flask import Blueprint, request, jsonify, redirect, url_for, render_template, current_app
from flask_login import login_user, logout_user, login_required
import requests
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
                from app import User  # Local import to avoid circular dependency
                user_obj = User(user_row)
                login_user(user_obj)
                return jsonify({"success": True, "redirect_url": url_for("home")})
            
            return jsonify({"error": "Invalid credentials"}), 401
    except Exception as e:
        current_app.logger.error(f"API login error: {e}")
        return jsonify({"error": "An internal error occurred"}), 500

@auth.route("/auth/google")
def auth_google():
    client = get_oauth_client()
    google_provider_cfg = get_google_provider_cfg()
    authorization_endpoint = google_provider_cfg["authorization_endpoint"]

    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=current_app.config["GOOGLE_REDIRECT_URI"],
        scope=["openid", "email", "profile"],
    )
    return redirect(request_uri)

@auth.route("/auth/google/callback")
def auth_google_callback():
    client = get_oauth_client()
    code = request.args.get("code")
    google_provider_cfg = get_google_provider_cfg()
    token_endpoint = google_provider_cfg["token_endpoint"]

    token_url, headers, body = client.prepare_token_request(
        token_endpoint,
        authorization_response=request.url,
        redirect_url=current_app.config["GOOGLE_REDIRECT_URI"],
        code=code
    )
    token_response = requests.post(
        token_url,
        headers=headers,
        data=body,
        auth=(current_app.config['GOOGLE_CLIENT_ID'], current_app.config['GOOGLE_CLIENT_SECRET']),
    )

    client.parse_request_body_response(json.dumps(token_response.json()))

    userinfo_endpoint = google_provider_cfg["userinfo_endpoint"]
    uri, headers, body = client.add_token(userinfo_endpoint)
    userinfo_response = requests.get(uri, headers=headers, data=body)
    user_info = userinfo_response.json()

    if user_info.get("email_verified"):
        # Use the helper from app.py to get or create the user
        from app import get_or_create_user
        user_obj, is_new = get_or_create_user(user_info)
        
        if user_obj:
            login_user(user_obj)
            return redirect(url_for("home"))

    return "User email not available or not verified by Google.", 400


@auth.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("auth.login"))
