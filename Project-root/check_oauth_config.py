"""
OAuth Configuration Diagnostic Tool
Run this before starting the app to verify OAuth setup.

Usage:
    python check_oauth_config.py
"""
import os
from dotenv import load_dotenv
from flask import Flask, url_for

load_dotenv()

def check_oauth_config():
    """Verify OAuth configuration and print diagnostic info."""
    print("=" * 60)
    print("GOOGLE OAUTH CONFIGURATION CHECK")
    print("=" * 60)
    
    # Check environment variables
    client_id = os.environ.get('GOOGLE_CLIENT_ID')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    base_url = os.environ.get('BASE_URL', 'http://127.0.0.1:5000')
    
    print(f"\n1. Environment Variables:")
    print(f"   GOOGLE_CLIENT_ID: {'✓ Set' if client_id else '✗ MISSING'}")
    print(f"   GOOGLE_CLIENT_SECRET: {'✓ Set' if client_secret else '✗ MISSING'}")
    print(f"   BASE_URL: {base_url}")
    
    if not client_id or not client_secret:
        print("\n   ERROR: OAuth credentials not set!")
        print("   Fix: Copy .env.example to .env and fill in your credentials")
        return False
    
    # Create test Flask app to check URL building
    app = Flask(__name__)
    app.config['SERVER_NAME'] = base_url.replace('http://', '').replace('https://', '')
    if base_url.startswith('https://'):
        app.config['PREFERRED_URL_SCHEME'] = 'https'
    
    # Register test blueprint to simulate auth routes
    from flask import Blueprint
    auth_bp = Blueprint('auth', __name__)
    
    @auth_bp.route('/auth/google/callback')
    def auth_google_callback():
        return "test"
    
    app.register_blueprint(auth_bp)
    
    print(f"\n2. Flask URL Building Test:")
    with app.app_context():
        try:
            callback_url = url_for('auth.auth_google_callback', _external=True)
            print(f"   Generated callback URL: {callback_url}")
            print(f"\n3. Google Cloud Console Setup:")
            print(f"   Go to: https://console.cloud.google.com/apis/credentials")
            print(f"   Your OAuth 2.0 Client ID must have this EXACT redirect URI:")
            print(f"   ")
            print(f"   {callback_url}")
            print(f"   ")
            print(f"   ⚠️  Copy the URL above and add it to 'Authorized redirect URIs'")
            print(f"   ⚠️  The URL must match EXACTLY (including protocol, port, and path)")
            return True
        except Exception as e:
            print(f"   ERROR: Could not build URL: {e}")
            return False
    
    print("=" * 60)

if __name__ == "__main__":
    success = check_oauth_config()
    if not success:
        exit(1)
