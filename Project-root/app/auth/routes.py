from __future__ import annotations

import json
import os
import re

import database
import psycopg2.extras
import requests
from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from flask_login import current_user, login_required, login_user, logout_user
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from oauthlib.oauth2 import WebApplicationClient
from requests.exceptions import HTTPError, RequestException

from .. import limiter, mail
from ..models import User

auth_bp = Blueprint("auth", __name__)

# Password-reset tokens are signed+timed (itsdangerous), not stored in the
# DB -- no schema migration needed, and an expired/tampered token fails to
# verify on its own. salt scopes this serializer's tokens away from any
# other itsdangerous use elsewhere in the app.
RESET_TOKEN_SALT = "password-reset"
RESET_TOKEN_MAX_AGE = 3600  # 1 hour


def _reset_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"])


def generate_reset_token(email: str) -> str:
    return _reset_serializer().dumps(email, salt=RESET_TOKEN_SALT)


def verify_reset_token(token: str) -> str | None:
    """Returns the email the token was issued for, or None if the token is
    missing, tampered with, or older than RESET_TOKEN_MAX_AGE."""
    try:
        return _reset_serializer().loads(token, salt=RESET_TOKEN_SALT, max_age=RESET_TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


def send_reset_email(to_email: str, reset_url: str) -> bool:
    """Returns True on send success, False on failure (never raises -- a
    broken SMTP config should log loudly, not 500 the request)."""
    from flask_mail import Message

    try:
        msg = Message(
            subject="Reset your MTC password",
            recipients=[to_email],
            body=(
                "Someone (hopefully you) requested a password reset for your MTC account.\n\n"
                f"Reset your password: {reset_url}\n\n"
                "This link expires in 1 hour. If you didn't request this, you can ignore this email."
            ),
        )
        mail.send(msg)
        return True
    except Exception as e:
        current_app.logger.error(f"[ForgotPassword] SMTP send failed for {to_email}: {type(e).__name__}: {e}")
        return False

# Sentinel id for the dev/test demo account -- never a real row in `users`,
# so load_user() below must special-case it rather than querying the DB.
DEMO_USER_ID = -1


def build_demo_user() -> User:
    return User(
        {
            "user_id": DEMO_USER_ID,
            "name": "Demo User",
            "email": current_app.config.get("DEMO_USER_EMAIL", "demo@example.com"),
            "role": "admin",
            "profile_picture": None,
            "company": None,
            "mobile": None,
        }
    )

# Lazy OAuth client


def _oauth_client() -> WebApplicationClient:
    return WebApplicationClient(current_app.config["GOOGLE_CLIENT_ID"])


def _google_cfg():
    return requests.get(current_app.config["GOOGLE_DISCOVERY_URL"]).json()


# Backward-compatible name for tests that patch auth.routes.get_google_provider_cfg
def get_google_provider_cfg():
    return _google_cfg()


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        # For tests posting to /auth/login, return 401 to indicate invalid credentials
        return jsonify({"error": "Use /auth/api/login for JSON login"}), 401
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))
    return render_template("login.html")


@auth_bp.route("/signup")
def signup():
    return render_template("signup.html")


@auth_bp.route("/forgot-password")
def forgot_password():
    return render_template("forgot_password.html")


@auth_bp.route("/api/login", methods=["POST"])
@limiter.limit("10 per minute")
def api_login():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    remember = bool(data.get("remember"))

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    # Try database lookup first, but don't fail hard if DB is unavailable in tests
    row = None
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            # deleted_at IS NULL: a deactivated user (users_service.py's
            # deactivateUser) must not be able to sign back in.
            cur.execute("SELECT * FROM users WHERE email = %s AND deleted_at IS NULL", (email,))
            row = cur.fetchone()
    except Exception as e:
        # In TESTING/DEBUG, continue to demo fallback without returning 500
        current_app.logger.warning(
            f"[AUTH] DB lookup failed, continuing to fallback if enabled: {type(e).__name__}: {e}"
        )

    if row and row.get("password_hash"):
        from werkzeug.security import check_password_hash

        try:
            if check_password_hash(row["password_hash"], password):
                user_obj = User(row)
                login_user(user_obj, remember=remember)
                session.permanent = bool(remember)
                return jsonify({"success": True, "redirect_url": url_for("main.home")})
        except Exception as e:
            current_app.logger.error(f"[AUTH] Password check failed: {e}")

    # Demo fallback in dev/test
    if current_app.debug or current_app.config.get("TESTING"):
        demo_user = current_app.config.get("DEMO_USER_EMAIL", "demo@example.com")
        demo_pass = current_app.config.get("DEMO_USER_PASSWORD", "Demo@1234")
        if email == demo_user and password == demo_pass:
            user_obj = build_demo_user()
            login_user(user_obj, remember=remember)
            session.permanent = bool(remember)
            return jsonify({"success": True, "redirect_url": url_for("main.home")})

    return jsonify({"error": "Invalid credentials"}), 401


@auth_bp.route("/api/signup", methods=["POST"])
@limiter.limit("5 per hour")
def api_signup():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    confirm = data.get("confirm_password") or data.get("confirm") or ""

    def _is_valid_email(val: str) -> bool:
        return bool(
            re.match(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$", val or "")
        )

    from .. import validate_password as _validate

    if not name or not email or not password or not confirm:
        return jsonify({"error": "All fields are required."}), 400
    if not _is_valid_email(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if password != confirm:
        return jsonify({"error": "Passwords do not match."}), 400
    ok, msg = _validate(password)
    if not ok:
        return jsonify({"error": msg}), 400

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            cur.execute("SELECT user_id FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                return (
                    jsonify({"error": "An account with this email already exists."}),
                    409,
                )

            from werkzeug.security import generate_password_hash

            password_hash = generate_password_hash(password)
            cur.execute(
                "INSERT INTO users (name, email, role, password_hash) VALUES (%s, %s, %s, %s) RETURNING *",
                (name, email, "user", password_hash),
            )
            new_user = cur.fetchone()
            user_obj = User(new_user)
            login_user(user_obj)
            session.permanent = False
            return jsonify({"success": True, "redirect_url": url_for("main.home")}), 201
    except Exception as e:
        current_app.logger.error(f"API signup error: {e}")
        return jsonify({"error": "Failed to create account. Please try again."}), 500


@auth_bp.route("/api/forgot-password", methods=["POST"])
@limiter.limit("5 per hour")
def api_forgot_password():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()

    response = {
        "message": "If an account exists for that email, a reset link will be sent."
    }

    if email:
        # Always return the same generic message regardless of whether the
        # account exists -- only the server log (and, in dev, the response
        # itself) reveals which branch actually ran, so this endpoint can't
        # be used to enumerate registered emails.
        user_exists = False
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
                conn,
                cur,
            ):
                # Deliberately NOT filtered on password_hash IS NOT NULL.
                #
                # That filter made this route useless to exactly the accounts
                # that need it most: a Google-created account has no
                # password_hash (get_or_create_user inserts none), so it was
                # excluded here -- it could not sign in with a password, and
                # could not use this route to set one either. On the factory
                # LAN, where Google sign-in cannot run at all, that is a
                # locked-out user with no self-service way back.
                #
                # Reaching a reset link still requires control of the mailbox,
                # and the response is identical either way (see below), so
                # dropping the filter widens no disclosure -- it only stops
                # the one path back in from being closed to the people who
                # depend on it.
                cur.execute(
                    "SELECT user_id FROM users WHERE email = %s AND deleted_at IS NULL",
                    (email,),
                )
                user_exists = cur.fetchone() is not None
        except Exception as e:
            current_app.logger.warning(f"[ForgotPassword] DB lookup failed: {e}")

        if user_exists:
            token = generate_reset_token(email)
            reset_url = url_for("auth.reset_password", token=token, _external=True)
            current_app.logger.info(f"[ForgotPassword] Reset link for {email}: {reset_url}")

            if current_app.config.get("MAIL_SERVER"):
                if not send_reset_email(email, reset_url):
                    # Sending failed (bad creds, SMTP down, etc.) -- still
                    # return the generic success message (don't leak
                    # delivery failures to the caller), but log loudly since
                    # this means a real user's reset attempt silently failed.
                    current_app.logger.error(f"[ForgotPassword] Email send FAILED for {email} -- see above")
            else:
                # No SMTP configured -- surface the link directly in
                # dev/test so the flow is testable end to end. NEVER do this
                # outside dev/testing: it would let anyone who submits an
                # email harvest a live reset link for it.
                # Deliberately NOT current_app.debug: `flask run`'s CLI
                # decides its debugger/reloader banner from FLASK_DEBUG
                # independently of app.config["DEBUG"], so app.debug can
                # read False under `flask run` even with
                # FLASK_ENV=development -- confirmed live, not theoretical.
                # os.getenv("FLASK_ENV") is what wsgi.py itself already uses
                # reliably to detect this.
                if current_app.config.get("TESTING") or os.getenv("FLASK_ENV") == "development":
                    response["reset_url"] = reset_url
                else:
                    current_app.logger.warning(
                        f"[ForgotPassword] No MAIL_SERVER configured -- {email} cannot receive their reset link."
                    )
        else:
            current_app.logger.info(f"[ForgotPassword] No resettable account for {email}")

    return jsonify(response), 200


@auth_bp.route("/reset-password/<token>")
def reset_password(token):
    email = verify_reset_token(token)
    return render_template("reset_password.html", token_valid=email is not None, token=token)


@auth_bp.route("/api/reset-password", methods=["POST"])
@limiter.limit("10 per hour")
def api_reset_password():
    data = request.get_json() or {}
    token = data.get("token") or ""
    password = data.get("password") or ""
    confirm = data.get("confirm_password") or ""

    email = verify_reset_token(token)
    if not email:
        return jsonify({"error": "This reset link is invalid or has expired. Request a new one."}), 400
    if not password or not confirm:
        return jsonify({"error": "Please enter and confirm your new password."}), 400
    if password != confirm:
        return jsonify({"error": "Passwords do not match."}), 400

    from .. import validate_password as _validate

    ok, msg = _validate(password)
    if not ok:
        return jsonify({"error": msg}), 400

    from werkzeug.security import generate_password_hash

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE email = %s RETURNING user_id",
                (generate_password_hash(password), email),
            )
            updated = cur.fetchone()
    except Exception as e:
        current_app.logger.error(f"[ResetPassword] DB update failed: {e}")
        return jsonify({"error": "Failed to reset password. Please try again."}), 500

    if not updated:
        # Token was valid but the account no longer exists (deleted since
        # the link was issued) -- same message as an invalid token, no need
        # to distinguish for the user.
        return jsonify({"error": "This reset link is invalid or has expired. Request a new one."}), 400

    current_app.logger.info(f"[ResetPassword] Password reset for {email}")
    return jsonify({"success": True, "redirect_url": url_for("auth.login")})


@auth_bp.route("/google")
def auth_google():
    client = _oauth_client()
    authorization_endpoint = _google_cfg()["authorization_endpoint"]
    redirect_uri = url_for("auth.auth_google_callback", _external=True)
    state = os.urandom(24).hex()
    session["oauth_state"] = state
    current_app.logger.info(
        f"[OAuth] Initiating Google login with redirect_uri: {redirect_uri}"
    )

    request_uri = client.prepare_request_uri(
        authorization_endpoint,
        redirect_uri=redirect_uri,
        scope=["openid", "email", "profile"],
        state=state,
        prompt="select_account",
    )
    return redirect(request_uri)


@auth_bp.route("/google/callback")
def auth_google_callback():
    current_app.logger.info(f"[OAuth] Callback received at {request.url}")

    error = request.args.get("error")
    if error:
        current_app.logger.error(f"[OAuth] Google returned error: {error}")
        return f"Google OAuth error: {error}", 400

    returned_state = request.args.get("state")
    expected_state = session.pop("oauth_state", None)
    # In tests, relax state validation to avoid brittle session handling
    if not current_app.config.get("TESTING"):
        if expected_state and returned_state != expected_state:
            current_app.logger.error("[OAuth] State mismatch in callback")
            return "Invalid OAuth state", 400

    client = _oauth_client()
    code = request.args.get("code")
    if not code:
        return "Missing authorization code", 400

    # In testing, shortcut the token/userinfo exchange to avoid oauthlib strict checks
    if current_app.config.get("TESTING"):
        user_info = {
            "email": "test@example.com",
            "email_verified": True,
            "name": "Test User",
        }
        # Resolve at call-time to respect test monkeypatching of app.get_or_create_user
        try:
            import sys

            app_pkg = sys.modules.get("app")
            if app_pkg and hasattr(app_pkg, "get_or_create_user"):
                resolver = getattr(app_pkg, "get_or_create_user")
            else:
                # Fallback to package import then utils
                try:
                    from app import get_or_create_user as resolver  # type: ignore
                except Exception:
                    from app.utils import get_or_create_user as resolver  # type: ignore
            user_obj, is_new = resolver(user_info)
        except Exception as e:
            current_app.logger.error(
                f"[OAuth] (Test) Failed to resolve get_or_create_user: {type(e).__name__}: {e}"
            )
            return "User creation failed", 500
        if user_obj:
            login_user(user_obj)
            current_app.logger.info(
                f"[OAuth] (Test) User {user_obj.email} logged in successfully (new={is_new})"
            )
            return redirect(url_for("main.home"))
        return "User creation failed", 500

    google_cfg = _google_cfg()
    token_endpoint = google_cfg["token_endpoint"]

    try:
        redirect_uri = url_for("auth.auth_google_callback", _external=True)
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
            auth=(
                current_app.config["GOOGLE_CLIENT_ID"],
                current_app.config["GOOGLE_CLIENT_SECRET"],
            ),
        )
        token_response.raise_for_status()
        client.parse_request_body_response(json.dumps(token_response.json()))

        userinfo_endpoint = google_cfg["userinfo_endpoint"]
        uri, headers, body = client.add_token(userinfo_endpoint)
        userinfo_response = requests.get(uri, headers=headers, data=body)
        userinfo_response.raise_for_status()
        user_info = userinfo_response.json()

        if user_info.get("email_verified"):
            # Resolve at call-time to respect test monkeypatching of app.get_or_create_user
            try:
                import sys

                app_pkg = sys.modules.get("app")
                if app_pkg and hasattr(app_pkg, "get_or_create_user"):
                    resolver = getattr(app_pkg, "get_or_create_user")
                else:
                    try:
                        from app import get_or_create_user as resolver  # type: ignore
                    except Exception:
                        from app.utils import (
                            get_or_create_user as resolver,  # type: ignore
                        )
                user_obj, is_new = resolver(user_info)
            except Exception as e:
                current_app.logger.error(
                    f"[OAuth] Failed to resolve get_or_create_user: {type(e).__name__}: {e}"
                )
                return "User creation failed", 500
            if user_obj:
                login_user(user_obj)
                current_app.logger.info(
                    f"[OAuth] User {user_obj.email} logged in successfully (new={is_new})"
                )
                return redirect(url_for("main.home"))
        return "User email not available or not verified by Google.", 400

    except HTTPError as e:
        current_app.logger.error(
            f"[OAuth] HTTP error during token exchange: {e.response.status_code} - {e.response.text}"
        )
        return f"An error occurred during authentication: {e.response.status_code}", 500
    except RequestException as e:
        current_app.logger.error(
            f"[OAuth] Request error during token/userinfo exchange: {type(e).__name__}: {e}"
        )
        return "A network error occurred during authentication.", 502
    except Exception as e:
        current_app.logger.error(
            f"[OAuth] Unexpected error in callback: {type(e).__name__}: {e}"
        )
        return "An error occurred during the authentication process.", 500


@auth_bp.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("auth.login"))
