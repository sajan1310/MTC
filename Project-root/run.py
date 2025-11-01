import os
from app import create_app

if __name__ == '__main__':
    config_env = os.getenv('FLASK_ENV', 'production')
    app = create_app(config_env)
    debug = config_env == 'development'
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', 5000)), debug=debug)
