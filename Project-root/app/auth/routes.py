from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

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
from requests.adapters import HTTPAdapter
from requests.exceptions import HTTPError, RequestException
from urllib3.util.retry import Retry

from flask_limiter.util import get_remote_address
from flask_mail import Connection as FlaskMailConnection

from .. import limiter, mail
from ..models import User

# The activity log (AUDIT-001). Sign-in, sign-out and password events are
# recorded here rather than in app/erp/rpc.py because they never travel over
# the RPC bridge -- and they are the rows an account-compromise question is
# actually answered from.
from ..erp.services import activity_service

auth_bp = Blueprint("auth", __name__)


def _record_auth(
    action: str,
    status: str,
    *,
    email: str = "",
    user=None,
    user_id_override: int | None = None,
    detail: str = "",
    cur=None,
) -> None:
    """One activity row for an auth event (AUDIT-001).

    A thin wrapper over activity_service.record() because these call sites
    share an awkward property: identity cannot be taken from `current_user`
    at any of them. At a failed sign-in there is no session; at a successful
    one flask-login has only just created it; at sign-out the row has to be
    built BEFORE logout_user() tears it down. So every caller passes what it
    knows -- a User object once there is one, otherwise just the address that
    was typed, which for a failure is the only identity that exists.
    """
    try:
        activity_service.record(
            category=activity_service.CATEGORY_AUTH,
            action=action,
            status=status,
            detail=detail or None,
            user_id=getattr(user, "id", None) if user is not None else user_id_override,
            user_email=(getattr(user, "email", None) or email or "").strip().lower() or None,
            user_role=getattr(user, "role", None),
            cur=cur,
        )
    except Exception:  # noqa: BLE001
        # record() guards its own body, but not the identity extraction above
        # it. Nobody may be locked out of a working sign-in, or left with a
        # live session after a "failed" sign-out, because the audit log is
        # unwell.
        current_app.logger.warning("Activity logging failed for auth/%s", action)

# Password-reset tokens are signed+timed (itsdangerous), not stored in the
# DB -- no schema migration needed, and an expired/tampered token fails to
# verify on its own. salt scopes this serializer's tokens away from any
# other itsdangerous use elsewhere in the app.
RESET_TOKEN_SALT = "password-reset"
RESET_TOKEN_MAX_AGE = 3600  # 1 hour

# (connect timeout, read timeout) for every outbound call in this module
# (REL-001). `requests` defaults to None -- i.e. wait forever -- and with 4
# sync gunicorn workers, four blocked sign-ins is a full outage. 3.05s to
# connect follows the requests documentation's advice of a value slightly
# above a multiple of 3 (TCP retransmit windows); 10s to read is generous for
# Google and still bounded.
_HTTP_TIMEOUT = (3.05, 10)

# One retry, and ONLY for a connection that was never established (REL-001
# follow-up). The uplink dropping for the three seconds it takes to reach
# oauth2.googleapis.com is enough to fail a sign-in outright, and on a
# factory LAN with intermittent internet that is the common case, not the
# rare one -- a single re-attempt costs at most one more connect timeout and
# carries the blip.
#
# read=0 and status=0 are the safety half, and are not negotiable: a read
# timeout means the request DID reach Google, so re-sending a token exchange
# would present an authorization code Google has already consumed and turn a
# recoverable timeout into a hard invalid_grant. Only `connect` -- where
# nothing was ever sent -- may be retried, which is also why POST can be
# allowed here when urllib3 would normally exclude it as non-idempotent.
_GOOGLE_HTTP = requests.Session()
_GOOGLE_HTTP.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=1,
            connect=1,
            read=0,
            status=0,
            redirect=0,
            backoff_factor=0.3,
            allowed_methods=frozenset({"GET", "POST"}),
        )
    ),
)

# What the login page tells an operator whose Google sign-in died before it
# could finish. Codes rather than free text: the value travels back in a
# query string, and reflecting an arbitrary caller-supplied string into the
# page is how an error banner becomes an injection vector. An unrecognised
# code renders nothing.
_OAUTH_ERROR_MESSAGES = {
    "network": "Could not reach Google to complete sign-in. Check the server's internet connection, then try again.",
    "google": "Google rejected that sign-in attempt. Please try signing in again.",
    "unexpected": "Something went wrong while completing Google sign-in. Please try again.",
}

# Google's OpenID discovery document, cached per process.
# (fetched_at_monotonic, document) or None.
_GOOGLE_CFG_CACHE: tuple[float, dict] | None = None
_GOOGLE_CFG_TTL_SECONDS = 3600

# The role every self-created account starts in, whichever door it came
# through (SEC-002).
#
# This used to be "user" on the password path and "pending_approval" on the
# Google path (app/utils.py's get_or_create_user). Only "pending_approval" is
# blocked by app/erp/rpc.py's gate, and RpcSpec.roles is None for the large
# majority of the ~166 RPC methods -- so an unauthenticated, CSRF-exempt POST
# to /auth/api/signup minted an account with immediate unrestricted access to
# stock, bills, purchase orders, production, dispatch, clients and vendor
# ledgers. Every account-creation path now routes through this one constant so
# the two can no longer drift apart.
NEW_ACCOUNT_ROLE = "pending_approval"


def self_signup_enabled() -> bool:
    """Whether /auth/api/signup accepts new registrations.

    Defaults to enabled, so this change does not silently remove a workflow
    the business may depend on -- the escalation is closed by NEW_ACCOUNT_ROLE
    above, not by this switch. For a single-factory ERP, where every legitimate
    user is known in advance, setting ALLOW_SELF_SIGNUP=false and having admins
    create accounts is the stronger posture: it removes the unauthenticated
    write path entirely rather than making its output harmless.
    """
    value = current_app.config.get("ALLOW_SELF_SIGNUP", True)
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "no", "off", "")
    return bool(value)


def _reset_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"])


def credential_fingerprint(password_hash: str | None) -> str:
    """A short, non-reversible tag for the account's CURRENT credential.

    This is what makes a reset token single-use (SEC-006) without adding a
    token table. The tag is embedded in the token and re-derived at
    verification time; changing the password changes the stored hash, which
    changes the tag, which invalidates every token issued against the old
    one -- including the token that was just used.

    Before this, tokens were signed-and-timed only: valid for the full hour
    regardless of use, so a link captured from a mailbox, a browser history
    or a proxy log could be replayed repeatedly, and remained valid even
    after the user had already reset their password with it.

    The same tag is stored in the session at login, so a password change also
    invalidates sessions elsewhere -- see load_user() in app/__init__.py.
    Werkzeug hashes are salted, so this changes even when someone "resets" to
    the same password.
    """
    import hashlib

    return hashlib.sha256((password_hash or "").encode("utf-8")).hexdigest()[:16]


def _current_fingerprint_for(email: str) -> str | None:
    """The live fingerprint for `email`, or None if there is no active account.

    None also covers the deactivated case (deleted_at IS NOT NULL), so a
    soft-deleted account cannot have its password reset (SEC-007) -- the old
    UPDATE had no deleted_at filter, so a deactivated user could change their
    password even though every login path would still refuse them.
    """
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_conn, cur):
            cur.execute(
                # lower(email) (AUTH-001) -- identity is case-insensitive.
                "SELECT password_hash FROM users WHERE lower(email) = %s AND deleted_at IS NULL",
                (str(email or "").strip().lower(),),
            )
            row = cur.fetchone()
    except Exception as exc:  # noqa: BLE001
        current_app.logger.warning("[ResetPassword] fingerprint lookup failed: %s", exc)
        return None
    if row is None:
        return None
    return credential_fingerprint(row["password_hash"])


def generate_reset_token(email: str) -> str:
    return _reset_serializer().dumps(
        {"email": email, "fp": _current_fingerprint_for(email)},
        salt=RESET_TOKEN_SALT,
    )


def verify_reset_token(token: str) -> str | None:
    """The email the token was issued for, or None.

    None when the token is missing, tampered with, older than
    RESET_TOKEN_MAX_AGE, already used (its fingerprint no longer matches the
    account's current credential), or issued for an account that has since
    been deleted or deactivated.
    """
    try:
        payload = _reset_serializer().loads(
            token, salt=RESET_TOKEN_SALT, max_age=RESET_TOKEN_MAX_AGE
        )
    except (BadSignature, SignatureExpired):
        return None

    # Tokens minted before this change were a bare email string. Refuse them
    # rather than honouring them: they are replayable by construction, they
    # expire within the hour anyway, and "request a new link" is a small cost
    # next to leaving the old behaviour reachable.
    if not isinstance(payload, dict):
        return None

    email = payload.get("email")
    if not email:
        return None

    current = _current_fingerprint_for(email)
    if current is None or current != payload.get("fp"):
        return None
    return email


# Outbound mail runs off the request thread, on a deliberately small pool
# (REL-004).
#
# `mail.send()` is synchronous, and flask-mail builds its connection as
# `smtplib.SMTP(server, port)` with NO timeout argument -- so it inherits
# socket.getdefaulttimeout(), which Python leaves at None. A hung SMTP server
# therefore blocked the gunicorn worker *forever*, not merely for a while.
# Four such requests and every worker is gone: the application stops
# responding entirely, and nothing in its logs points at the mail server.
#
# max_workers=2 is the bound that matters. Unbounded threads would let a
# broken relay accumulate one stuck thread per reset request; this way two
# get stuck, the rest of the queue waits, and the web workers stay free
# either way -- which is the whole point.
_MAIL_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mtc-mail")

# Generous enough for a slow-but-working relay, finite enough that a black
# hole is not indistinguishable from one.
_SMTP_TIMEOUT_SECONDS = 20


class _TimeoutConnection(FlaskMailConnection):
    """flask-mail's Connection, with a socket timeout.

    flask-mail 0.10 exposes no setting for this and hard-codes the two-argument
    smtplib constructor. Subclassing is the smallest change that fixes it
    without reimplementing message construction or vendoring the library --
    and without touching socket.setdefaulttimeout(), which is process-global
    and would silently apply to every other socket the application opens.
    """

    def configure_host(self):
        import smtplib

        if self.mail.use_ssl:
            host = smtplib.SMTP_SSL(
                self.mail.server, self.mail.port, timeout=_SMTP_TIMEOUT_SECONDS
            )
        else:
            host = smtplib.SMTP(
                self.mail.server, self.mail.port, timeout=_SMTP_TIMEOUT_SECONDS
            )
        # `or 0`: upstream writes int(self.mail.debug), which raises when
        # MAIL_DEBUG was never configured. Costs nothing to be safe here.
        host.set_debuglevel(int(self.mail.debug or 0))
        if self.mail.use_tls:
            host.starttls()
        if self.mail.username and self.mail.password:
            host.login(self.mail.username, self.mail.password)
        return host


def _deliver(app, to_email: str, message) -> bool:
    """Runs on the pool. Owns its own app context -- the request's is gone."""
    with app.app_context():
        try:
            with _TimeoutConnection(mail) as connection:
                connection.send(message)
            app.logger.info("[ForgotPassword] Reset email delivered to %s", to_email)
            return True
        except Exception as e:  # noqa: BLE001 -- a broken relay must not kill the pool thread
            app.logger.error(
                "[ForgotPassword] SMTP send failed for %s: %s: %s",
                to_email,
                type(e).__name__,
                e,
            )
            return False


def send_reset_email(to_email: str, reset_url: str) -> bool:
    """Queue a reset email. True means accepted for delivery, not delivered.

    That distinction is deliberate and costs the caller nothing:
    api_forgot_password already replies with the same generic message whether
    or not delivery succeeds, precisely so that submitting an address cannot
    reveal whether it has an account. Delivery failures go to the log, which
    is where the old return value's only real consumer sent them anyway.
    """
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
        app = current_app._get_current_object()
        if app.config.get("MAIL_SEND_SYNCHRONOUSLY"):
            # Lets a test assert on what was sent rather than on thread
            # scheduling.
            return _deliver(app, to_email, msg)
        _MAIL_POOL.submit(_deliver, app, to_email, msg)
        return True
    except Exception as e:  # noqa: BLE001 -- never 500 a reset over a mail problem
        current_app.logger.error(
            "[ForgotPassword] Could not queue reset email for %s: %s: %s",
            to_email,
            type(e).__name__,
            e,
        )
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
    """Google's OpenID discovery document, fetched at most once per process
    per TTL.

    Two fixes here (REL-001).

    **Timeout.** `requests` has NO default timeout -- it waits forever. This
    call had none, and neither did the token exchange or the userinfo fetch
    below. gunicorn runs 4 sync workers, so four users signing in while
    Google's endpoint is slow, or while a captive portal is swallowing packets
    on the factory's uplink, blocked every worker and took the whole ERP
    offline for everyone -- including the people not using Google sign-in at
    all. On a factory LAN with intermittent internet that is not a hypothetical.

    **Caching.** The discovery document changes on the order of years, and a
    single sign-in fetched it twice (once in auth_google, once in the
    callback). Caching it removes two round trips from every login and means a
    brief outage at Google does not immediately break sign-in for a process
    that has already succeeded once.
    """
    global _GOOGLE_CFG_CACHE

    cached = _GOOGLE_CFG_CACHE
    if cached is not None and (time.monotonic() - cached[0]) < _GOOGLE_CFG_TTL_SECONDS:
        return cached[1]

    response = _GOOGLE_HTTP.get(
        current_app.config["GOOGLE_DISCOVERY_URL"],
        timeout=_HTTP_TIMEOUT,
    )
    response.raise_for_status()
    cfg = response.json()
    _GOOGLE_CFG_CACHE = (time.monotonic(), cfg)
    return cfg


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
    # oauth_error is a CODE looked up in _OAUTH_ERROR_MESSAGES, never the
    # message itself -- see that dict. An unknown or absent code renders
    # nothing, which is the ordinary case.
    return render_template(
        "login.html",
        oauth_error=_OAUTH_ERROR_MESSAGES.get(request.args.get("oauth_error", "")),
    )


@auth_bp.route("/signup")
def signup():
    return render_template("signup.html")


@auth_bp.route("/forgot-password")
def forgot_password():
    return render_template("forgot_password.html")


def _login_account_key() -> str:
    """Rate-limit key for the account being logged into (SEC-009).

    Hashed, not the address itself: the limiter's storage is Redis, whose
    keys turn up in `KEYS *`, slow-log output and any dump of that instance.
    A throttle does not need to know who it is throttling, only that two
    attempts are for the same account -- and a hash gives exactly that.

    Falls back to the client IP when there is no usable address in the body,
    so a malformed request is still throttled rather than sharing one
    unbounded bucket.
    """
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    if not email:
        return f"noaddr:{get_remote_address()}"
    return "acct:" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:32]


def _login_account_limit() -> str:
    return current_app.config.get("RATELIMIT_LOGIN_PER_ACCOUNT", "10 per 15 minutes")


@auth_bp.route("/api/login", methods=["POST"])
# Per-IP: protects the server from one noisy client.
@limiter.limit("10 per minute")
# Per-account: protects one account from many clients (SEC-009). The per-IP
# limit above cannot do this -- an attacker rotating addresses gets unlimited
# guesses at a single password, and conversely an office behind one NAT
# shares a single budget between everyone in it.
#
# deduct_when means only a 401 consumes the budget. Successful sign-ins, and
# the 400 for a malformed request, cost nothing -- so this can never lock out
# somebody who is typing their password correctly.
@limiter.limit(
    _login_account_limit,
    key_func=_login_account_key,
    deduct_when=lambda response: response.status_code == 401,
)
def api_login():
    data = request.get_json() or {}
    # .lower(), not just .strip() (AUTH-001). api_signup and
    # users_service.create_user both STORE the address lowercased, so
    # comparing the raw typed form meant anyone who signed up with a capital
    # letter could never log in: their row existed, their password was right,
    # and the lookup simply did not find it. Reproduced before the fix --
    # signup 201, login with the same spelling 401.
    email = (data.get("email") or "").strip().lower()
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
            cur.execute(
                "SELECT * FROM users WHERE lower(email) = %s AND deleted_at IS NULL",
                (email,),
            )
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
                # Pin this session to the credential it was created with, so a
                # later password reset invalidates it (SEC-006). Checked on
                # every request by load_user().
                session["cred_fp"] = credential_fingerprint(row["password_hash"])
                _record_auth(
                    "login",
                    activity_service.STATUS_SUCCESS,
                    user=user_obj,
                    detail="Password sign-in",
                )
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
            _record_auth(
                "login",
                activity_service.STATUS_SUCCESS,
                user=user_obj,
                detail="Demo account sign-in",
            )
            return jsonify({"success": True, "redirect_url": url_for("main.home")})

    # Every way of getting here is a rejected sign-in. Recorded with the
    # address that was typed and WITHOUT saying whether that address exists --
    # the row is for the operator reading the log, not the caller, who still
    # gets the same opaque 401 either way. `user_id` is the real account's id
    # when the address matched one, so a burst against a single account is
    # visible as such rather than as a set of unrelated failures.
    _record_auth(
        "login",
        activity_service.STATUS_FAILURE,
        email=email,
        user_id_override=(row.get("user_id") if row else None),
        detail="Invalid credentials",
    )
    return jsonify({"error": "Invalid credentials"}), 401


@auth_bp.route("/api/signup", methods=["POST"])
@limiter.limit("5 per hour")
def api_signup():
    if not self_signup_enabled():
        return (
            jsonify(
                {
                    "error": (
                        "Self-registration is disabled. Ask an administrator to "
                        "create your account."
                    )
                }
            ),
            403,
        )

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
            # lower(email) (AUTH-001): otherwise a legacy row stored with
            # capitals would not be seen here, and the signup would pass this
            # check only to fail on the unique index as a 500.
            cur.execute("SELECT user_id FROM users WHERE lower(email) = %s", (email,))
            if cur.fetchone():
                return (
                    jsonify({"error": "An account with this email already exists."}),
                    409,
                )

            from werkzeug.security import generate_password_hash

            password_hash = generate_password_hash(password)
            cur.execute(
                "INSERT INTO users (name, email, role, password_hash) VALUES (%s, %s, %s, %s) RETURNING *",
                (name, email, NEW_ACCOUNT_ROLE, password_hash),
            )
            new_user = cur.fetchone()
            user_obj = User(new_user)
            login_user(user_obj)
            session.permanent = False
            current_app.logger.info(
                "[Signup] New account %s created awaiting admin approval", email
            )
            # cur=, not a second connection: this is inside the INSERT's own
            # transaction (see activity_service.record's `cur` note), so the
            # row rolls back with the account if the commit never happens.
            _record_auth(
                "signup",
                activity_service.STATUS_SUCCESS,
                user=user_obj,
                detail=f"Self-registered; awaiting approval (role={NEW_ACCOUNT_ROLE})",
                cur=cur,
            )
            # /erp/pending-approval, not main.home. The account is real and the
            # session is real, but the role grants nothing until an admin acts
            # -- landing on the app shell would just fail every RPC call it
            # makes with a 403 and look broken.
            return (
                jsonify(
                    {
                        "success": True,
                        "pending_approval": True,
                        "message": (
                            "Account created. An administrator needs to approve it "
                            "before you can sign in."
                        ),
                        "redirect_url": url_for("erp.pending_approval"),
                    }
                ),
                201,
            )
    except psycopg2.IntegrityError:
        # users.email is UNIQUE, so two concurrent signups for the same address
        # race past the SELECT above and one loses here. That is a duplicate,
        # not a server fault -- report it the same way the SELECT does.
        return jsonify({"error": "An account with this email already exists."}), 409
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
                    "SELECT user_id FROM users WHERE lower(email) = %s AND deleted_at IS NULL",
                    (email,),
                )
                user_exists = cur.fetchone() is not None
        except Exception as e:
            current_app.logger.warning(f"[ForgotPassword] DB lookup failed: {e}")

        # Recorded whether or not the address resolves to an account. The
        # RESPONSE stays identical either way (that is the anti-enumeration
        # property this route is built around) -- but the log is read by an
        # operator who already has the user table, so withholding it there
        # protects nobody and hides a password-reset flood.
        _record_auth(
            "password_reset_requested",
            activity_service.STATUS_SUCCESS
            if user_exists
            else activity_service.STATUS_FAILURE,
            email=email,
            detail="Reset link issued"
            if user_exists
            else "No resettable account for this address",
        )

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
            # deleted_at IS NULL (SEC-007): a deactivated account must not be
            # able to change its password. Without the filter, deactivation
            # meant different things on different routes -- login refused
            # them, this one did not.
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE lower(email) = %s AND deleted_at IS NULL RETURNING user_id",
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

    # Drop the session doing the reset, and -- because the credential
    # fingerprint stored at login no longer matches -- every other session for
    # this account too (see load_user in app/__init__.py). A reset prompted by
    # a suspected compromise previously left the attacker's session running.
    logout_user()
    session.clear()

    current_app.logger.info(
        "[ResetPassword] Password reset for %s; all sessions invalidated", email
    )
    # After logout_user()/session.clear(), so current_user is gone -- hence
    # the explicit identity from the UPDATE's RETURNING.
    _record_auth(
        "password_reset",
        activity_service.STATUS_SUCCESS,
        email=email,
        user_id_override=updated["user_id"],
        detail="Password changed via reset link; all sessions invalidated",
    )
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


def _oauth_retry(code: str, state: str | None):
    """Send the operator back to the login page with something they can act
    on, and put the CSRF state back where the callback found it.

    The state matters as much as the message. `expected_state` is consumed
    with session.pop BEFORE the token exchange is attempted, so a failure
    DURING that exchange -- the uplink dropping for the three seconds it
    takes to connect to oauth2.googleapis.com -- left the session with no
    oauth_state at all. The operator's natural next move, reloading the
    callback URL, then hit the fail-closed SEC-003 branch and was told
    "Invalid OAuth state": a CSRF error reported for what was a network
    timeout, and an unrecoverable one, since no amount of reloading could
    put back a value only /auth/google can mint. One real failure became
    three misleading ones and a dead end.

    Restoring it does not weaken SEC-003. That check asks whether the
    returned state matches THIS session's own; the attack it exists to stop
    -- inducing a victim to open a callback URL carrying the ATTACKER's code
    and state -- still fails on the comparison, because the victim's session
    holds the victim's own state and never the attacker's. What the restore
    permits is strictly the operator retrying their own interrupted flow.
    """
    if state:
        session["oauth_state"] = state
    return redirect(url_for("auth.login", oauth_error=code))


@auth_bp.route("/google/callback")
def auth_google_callback():
    current_app.logger.info(f"[OAuth] Callback received at {request.url}")

    error = request.args.get("error")
    if error:
        current_app.logger.error(f"[OAuth] Google returned error: {error}")
        return f"Google OAuth error: {error}", 400

    # SEC-003. This check now fails CLOSED, and runs under TESTING too.
    #
    # It used to read `if expected_state and returned_state != expected_state`.
    # The `expected_state and` guard meant that when the browser's session
    # carried no oauth_state at all -- because that browser never started an
    # OAuth flow -- the comparison was skipped entirely and the callback
    # proceeded with no CSRF protection. The absence of state IS the attack,
    # and the guard treated it as the safe case: an attacker starts a Google
    # sign-in with their own account, captures the `code`, and induces the
    # victim to open the callback URL. The victim, having no oauth_state, is
    # silently logged in AS THE ATTACKER, and every bill, dispatch and stock
    # correction they then enter is recorded under the attacker's account.
    #
    # The old `if not TESTING` bypass is gone as well. It skipped the entire
    # branch, so no test could ever exercise the one check protecting this
    # flow -- which is a large part of why the defect survived. Tests now seed
    # session["oauth_state"] properly (tests/test_oauth_state.py).
    returned_state = request.args.get("state") or ""
    expected_state = session.pop("oauth_state", None)
    if not expected_state or not secrets.compare_digest(
        str(returned_state), str(expected_state)
    ):
        current_app.logger.warning(
            "[OAuth] Rejecting callback: state %s",
            "missing from session" if not expected_state else "mismatched",
        )
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
            _record_auth(
                "signup" if is_new else "login",
                activity_service.STATUS_SUCCESS,
                user=user_obj,
                detail="Google sign-in (test mode)",
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
        token_response = _GOOGLE_HTTP.post(
            token_url,
            headers=headers,
            data=body,
            auth=(
                current_app.config["GOOGLE_CLIENT_ID"],
                current_app.config["GOOGLE_CLIENT_SECRET"],
            ),
            timeout=_HTTP_TIMEOUT,  # REL-001
        )
        token_response.raise_for_status()
        client.parse_request_body_response(json.dumps(token_response.json()))

        userinfo_endpoint = google_cfg["userinfo_endpoint"]
        uri, headers, body = client.add_token(userinfo_endpoint)
        userinfo_response = _GOOGLE_HTTP.get(
            uri, headers=headers, data=body, timeout=_HTTP_TIMEOUT  # REL-001
        )
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
                # is_new distinguishes "signed in" from "this account came
                # into existence just now", which for a provider that creates
                # accounts on first sight is the more important of the two.
                _record_auth(
                    "signup" if is_new else "login",
                    activity_service.STATUS_SUCCESS,
                    user=user_obj,
                    detail="Google sign-in",
                )
                return redirect(url_for("main.home"))
        return "User email not available or not verified by Google.", 400

    # Each of these used to answer with a bare string and a 5xx, which left
    # the operator on a blank error page with no way back and nothing to do.
    # The diagnosis stays in the log, where it belongs and where it is
    # complete; what reaches the browser is a route back to the login page
    # and a sentence naming what failed. See _oauth_retry on the state.
    except HTTPError as e:
        current_app.logger.error(
            f"[OAuth] HTTP error during token exchange: {e.response.status_code} - {e.response.text}"
        )
        return _oauth_retry("google", expected_state)
    except RequestException as e:
        current_app.logger.error(
            f"[OAuth] Request error during token/userinfo exchange: {type(e).__name__}: {e}"
        )
        return _oauth_retry("network", expected_state)
    except Exception as e:
        current_app.logger.error(
            f"[OAuth] Unexpected error in callback: {type(e).__name__}: {e}"
        )
        return _oauth_retry("unexpected", expected_state)


@auth_bp.route("/logout", methods=["GET", "POST"])
@login_required
def logout():
    """Sign out. POST is the real route; GET renders a confirmation (SEC-008).

    Logging out is a state change, and it used to be reachable by GET with no
    CSRF protection at all -- so `<img src="https://erp.example/auth/logout">`
    on any page a user visited signed them out. Harmless-looking, but on a
    factory floor it means losing half-entered work with no explanation, and
    repeated it is a denial of service against a specific user.

    GET is kept, but it no longer performs the logout: it renders a small
    confirmation page whose button POSTs with a CSRF token. That way every
    existing `<a href="{{ url_for('auth.logout') }}">` in the templates keeps
    working and stays a single click, while an <img>/<iframe>/prefetch can no
    longer end anyone's session.
    """
    if request.method == "GET":
        return render_template("logout_confirm.html")

    # Before logout_user(): after it, current_user is the anonymous user and
    # the row would name nobody.
    _record_auth("logout", activity_service.STATUS_SUCCESS, user=current_user)

    logout_user()
    session.clear()
    return redirect(url_for("auth.login"))
