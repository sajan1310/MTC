import os

from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from flask import Flask, redirect, render_template, session, url_for
from flask_login import (
    LoginManager,
    UserMixin,
    login_required,
    login_user,
    logout_user,
)

# Load environment variables
load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(24)

# --- User and Login Management ---
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"


class User(UserMixin):
    """Simple User model for demonstration."""

    def __init__(self, id_, name, email, profile_pic):
        self.id = id_
        self.name = name
        self.email = email
        self.profile_pic = profile_pic

    @staticmethod
    def get(user_id):
        # In a real app, you would fetch from a database
        # For this example, we'll use the session
        user_data = session.get("user_data")
        if user_data and user_data.get("id") == user_id:
            return User(
                id_=user_data["id"],
                name=user_data["name"],
                email=user_data["email"],
                profile_pic=user_data["profile_pic"],
            )
        return None


@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)


# --- OAuth Setup ---
oauth = OAuth(app)
google = oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


# --- Routes ---
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/login")
def login():
    """Initiates the Google OAuth login flow."""
    # The redirect_uri must match the one configured in Google Cloud Console
    redirect_uri = url_for("auth_callback", _external=True)
    return google.authorize_redirect(redirect_uri)


@app.route("/auth/callback")
def auth_callback():
    """Handles the callback from Google."""
    try:
        token = google.authorize_access_token()
        user_info = google.userinfo()

        # In a real app, you would find or create the user in your database
        # For this example, we store user info in the session
        user_id = user_info["sub"]
        user_data = {
            "id": user_id,
            "name": user_info["name"],
            "email": user_info["email"],
            "profile_pic": user_info["picture"],
        }
        session["user_data"] = user_data

        user = User.get(user_id)
        login_user(user)

        return redirect(url_for("profile"))
    except Exception as e:
        print(f"Error during Google OAuth callback: {e}")
        return redirect(url_for("index"))


@app.route("/profile")
@login_required
def profile():
    """Displays the logged-in user's profile."""
    return render_template("profile.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    session.pop("user_data", None)  # Clear user data from session
    return redirect(url_for("index"))


if __name__ == "__main__":
    app.run(debug=True, port=5000)
