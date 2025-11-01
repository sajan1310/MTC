"""
WSGI Entry Point for Production Deployment
This file is used by gunicorn, waitress, or other WSGI servers.

Usage:
    gunicorn wsgi:app
    waitress-serve --port=5000 wsgi:app
"""
import os
import sys

# Add the project root to Python path
sys.path.insert(0, os.path.dirname(__file__))

from app import create_app
app = create_app(os.getenv('FLASK_ENV', 'production'))

# Configure for production
if os.environ.get('FLASK_ENV') == 'production':
    app.config['DEBUG'] = False
    app.logger.info("Application started in PRODUCTION mode")
else:
    app.logger.info("Application started in DEVELOPMENT mode")

if __name__ == "__main__":
    # For development testing only
    # Production should use: gunicorn wsgi:app
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
