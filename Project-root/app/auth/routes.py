from __future__ import annotations
import os
import json
import re
from flask import Blueprint, request, jsonify, redirect, url_for, render_template, current_app, session
from flask_login import login_user, logout_user, login_required, current_user
from oauthlib.oauth2 import WebApplicationClient
import requests
from requests.exceptions import HTTPError, RequestException
import psycopg2.extras

import database
from ..models import User
from ..utils import get_or_create_user

auth_bp = Blueprint('auth', __name__)

# Lazy OAuth client

def _oauth_client() -> WebApplicationClient:
    return WebApplicationClient(current_app.config['GOOGLE_CLIENT_ID'])


def _google_cfg():
    return requests.get(current_app.config['GOOGLE_DISCOVERY_URL']).json()

# Backward-compatible name for tests that patch auth.routes.get_google_provider_cfg
def get_google_provider_cfg():
    return _google_cfg()


@auth_bp.route('/login')
def login():
    if current_user.is_authenticated:
        return redirect(url_for('main.dashboard'))
    return render_template('login.html')


@auth_bp.route('/signup')
def signup():
    return render_template('signup.html')


@auth_bp.route('/forgot-password')
def forgot_password():
    return render_template('forgot_password.html')


@auth_bp.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    email = (data.get('email') or '').strip()
    password = data.get('password') or ''
    remember = bool(data.get('remember'))

    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute('SELECT * FROM users WHERE email = %s', (email,))
            row = cur.fetchone()
            if row and row.get('password_hash'):
                from werkzeug.security import check_password_hash
                if check_password_hash(row['password_hash'], password):
                    user_obj = User(row)
                    login_user(user_obj, remember=remember)
                    session.permanent = bool(remember)
                    return jsonify({'success': True, 'redirect_url': url_for('main.home')})

        # Demo fallback in dev/test
        if current_app.debug or current_app.config.get('TESTING'):
            demo_user = current_app.config.get('DEMO_USER_EMAIL', 'demo@example.com')
            demo_pass = current_app.config.get('DEMO_USER_PASSWORD', 'Demo@1234')
            if email == demo_user and password == demo_pass:
                demo_row = {
                    'user_id': -1,
                    'name': 'Demo User',
                    'email': demo_user,
                    'role': 'admin',
                    'profile_picture': None,
                    'company': None,
                    'mobile': None,
                }
                user_obj = User(demo_row)
                login_user(user_obj, remember=remember)
                session.permanent = bool(remember)
                return jsonify({'success': True, 'redirect_url': url_for('main.home')})

        return jsonify({'error': 'Invalid credentials'}), 401
    except Exception as e:
        current_app.logger.error(f'API login error: {e}')
        return jsonify({'error': 'An internal error occurred'}), 500


@auth_bp.route('/api/signup', methods=['POST'])
def api_signup():
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    confirm = data.get('confirm_password') or data.get('confirm') or ''

    def _is_valid_email(val: str) -> bool:
        return bool(re.match(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$", val or ''))

    from .. import validate_password as _validate

    if not name or not email or not password or not confirm:
        return jsonify({'error': 'All fields are required.'}), 400
    if not _is_valid_email(email):
        return jsonify({'error': 'Please enter a valid email address.'}), 400
    if password != confirm:
        return jsonify({'error': 'Passwords do not match.'}), 400
    ok, msg = _validate(password)
    if not ok:
        return jsonify({'error': msg}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute('SELECT user_id FROM users WHERE email = %s', (email,))
            if cur.fetchone():
                return jsonify({'error': 'An account with this email already exists.'}), 409

            from werkzeug.security import generate_password_hash
            password_hash = generate_password_hash(password)
            cur.execute(
                'INSERT INTO users (name, email, role, password_hash) VALUES (%s, %s, %s, %s) RETURNING *',
                (name, email, 'user', password_hash)
            )
            new_user = cur.fetchone()
            user_obj = User(new_user)
            login_user(user_obj)
            session.permanent = False
            return jsonify({'success': True, 'redirect_url': url_for('main.home')}), 201
    except Exception as e:
        current_app.logger.error(f'API signup error: {e}')
        return jsonify({'error': 'Failed to create account. Please try again.'}), 500


@auth_bp.route('/api/forgot-password', methods=['POST'])
def api_forgot_password():
    data = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    if email:
        current_app.logger.info(f"[ForgotPassword] Request received for {email}")
    return jsonify({'message': 'If an account exists for that email, a reset link will be sent.'}), 200


@auth_bp.route('/google')
def auth_google():
    client = _oauth_client()
    authorization_endpoint = _google_cfg()["authorization_endpoint"]
    redirect_uri = url_for('auth.auth_google_callback', _external=True)
    state = os.urandom(24).hex()
    session['oauth_state'] = state
    current_app.logger.info(f"[OAuth] Initiating Google login with redirect_uri: {redirect_uri}")

    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=redirect_uri,
        scope=["openid", "email", "profile"],
        state=state,
        prompt="select_account",
    )
    return redirect(request_uri)


@auth_bp.route('/google/callback')
def auth_google_callback():
    current_app.logger.info(f"[OAuth] Callback received at {request.url}")

    error = request.args.get('error')
    if error:
        current_app.logger.error(f"[OAuth] Google returned error: {error}")
        return f"Google OAuth error: {error}", 400

    returned_state = request.args.get('state')
    expected_state = session.pop('oauth_state', None)
    if expected_state and returned_state != expected_state:
        current_app.logger.error('[OAuth] State mismatch in callback')
        return 'Invalid OAuth state', 400

    client = _oauth_client()
    code = request.args.get('code')
    if not code:
        return 'Missing authorization code', 400

    google_cfg = _google_cfg()
    token_endpoint = google_cfg['token_endpoint']

    try:
        redirect_uri = url_for('auth.auth_google_callback', _external=True)
        token_url, headers, body = client.prepare_token_request(
            token_endpoint,
            authorization_response=request.url,
            redirect_url=redirect_uri,
            code=code,
        )
        token_response = requests.post(
            token_url,
            headers=headers,
            data=body,
            auth=(current_app.config['GOOGLE_CLIENT_ID'], current_app.config['GOOGLE_CLIENT_SECRET']),
        )
        token_response.raise_for_status()
        client.parse_request_body_response(json.dumps(token_response.json()))

        userinfo_endpoint = google_cfg['userinfo_endpoint']
        uri, headers, body = client.add_token(userinfo_endpoint)
        userinfo_response = requests.get(uri, headers=headers, data=body)
        userinfo_response.raise_for_status()
        user_info = userinfo_response.json()

        if user_info.get('email_verified'):
            user_obj, is_new = get_or_create_user(user_info)
            if user_obj:
                login_user(user_obj)
                current_app.logger.info(f"[OAuth] User {user_obj.email} logged in successfully (new={is_new})")
                return redirect(url_for('main.home'))
        return 'User email not available or not verified by Google.', 400

    except HTTPError as e:
        current_app.logger.error(f"[OAuth] HTTP error during token exchange: {e.response.status_code} - {e.response.text}")
        return f"An error occurred during authentication: {e.response.status_code}", 500
    except RequestException as e:
        current_app.logger.error(f"[OAuth] Request error during token/userinfo exchange: {type(e).__name__}: {e}")
        return 'A network error occurred during authentication.', 502
    except Exception as e:
        current_app.logger.error(f"[OAuth] Unexpected error in callback: {type(e).__name__}: {e}")
        return 'An error occurred during the authentication process.', 500


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))
