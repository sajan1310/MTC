import os
import uuid
from dotenv import load_dotenv
import database
from functools import wraps
import json

# Load environment variables from a .env file
load_dotenv()

from flask import (Flask, request, jsonify, render_template, redirect, url_for,
                   flash, session, send_from_directory)
from flask_cors import CORS
from authlib.integrations.flask_client import OAuth
from flask_login import (LoginManager, UserMixin, login_user, login_required,
                         logout_user, current_user)
from flask_wtf.csrf import CSRFProtect
import psycopg2
import psycopg2.extras
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import logging
from io import StringIO
from psycopg2 import sql
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import re
from flask_talisman import Talisman
import csv
from flask import Response

app = Flask(__name__)

def validate_password(password):
    """
    Enforce strong password policy.
    
    Requirements:
    - Minimum 8 characters
    - At least one uppercase letter
    - At least one lowercase letter
    - At least one number
    - At least one special character
    
    Returns:
        tuple: (is_valid: bool, message: str)
    """
    if len(password) < 8:
        return False, "Password must be at least 8 characters long"
    
    if not re.search(r'[A-Z]', password):
        return False, "Password must contain at least one uppercase letter"
    
    if not re.search(r'[a-z]', password):
        return False, "Password must contain at least one lowercase letter"
    
    if not re.search(r'[0-9]', password):
        return False, "Password must contain at least one number"
    
    if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        return False, "Password must contain at least one special character"
    
    return True, "Password is strong"
# ✅ Load configuration from config.py
from config import get_config
app.config.from_object(get_config())
app.secret_key = app.config['SECRET_KEY']

# File upload security configuration
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB

def allowed_file(filename):
    """Check if file extension is allowed."""
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def validate_upload(file):
    """
    Validate uploaded file for security.
    
    Returns:
        tuple: (is_valid: bool, error_message: str)
    """
    if not file or not file.filename:
        return False, "No file provided"
    
    # Check file extension
    if not allowed_file(file.filename):
        return False, "Invalid file type. Allowed: PNG, JPG, JPEG, GIF, WEBP"
    
    # Check file size
    file.seek(0, 2)  # Seek to end
    size = file.tell()
    file.seek(0)  # Reset to start
    
    if size > MAX_FILE_SIZE:
        return False, f"File too large. Maximum size: {MAX_FILE_SIZE / (1024*1024):.1f}MB"
    
    return True, "Valid"

csrf = CSRFProtect(app)
database.init_app(app)

# ✅ SECURITY: Rate limiting to prevent abuse
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["500 per day", "150 per hour"],
    storage_uri="memory://",
    strategy="fixed-window"
)

# Exempt static files from rate limiting
@limiter.request_filter
def exempt_static():
    return request.path.startswith('/static/')

# ✅ Custom error handler for rate limit exceeded
@app.errorhandler(429)
def ratelimit_handler(e):
    """Render a custom page when a rate limit is hit."""
    return render_template('429.html'), 429

# ✅ SECURITY: Force HTTPS in production
if not app.debug and os.environ.get('FLASK_ENV') == 'production':
    Talisman(app, 
        force_https=True,
        strict_transport_security=True,
        content_security_policy={
            'default-src': "'self'",
            'script-src': ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            'style-src': ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            'font-src': ["'self'", "https://fonts.gstatic.com"],
            'img-src': ["'self'", "data:", "https:"],
        }
    )

logging.basicConfig(level=logging.INFO)
CORS(app, supports_credentials=True, origins=["http://127.0.0.1:5000"])

# --- User and Login Management ---
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

class User(UserMixin):
    def __init__(self, id_, name, email, role='user', profile_picture=None, company=None, mobile=None):
        self.id = id_
        self.name = name
        self.email = email
        self.role = role
        self.profile_picture = profile_picture
        self.company = company
        self.mobile = mobile

@login_manager.user_loader
def load_user(user_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM users WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
    except Exception as e:
        app.logger.error(f"Error in load_user: {e}")
        return None
    if not row:
        return None
    return User(
        id_=str(row['user_id']), name=row['name'], email=row['email'],
        role=row.get('role', 'user'), profile_picture=row.get('profile_picture'),
        company=row.get('company'), mobile=row.get('mobile')
    )
    
# --- OAuth Setup ---
oauth = OAuth(app)
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET')
google = None
if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
    google = oauth.register(
        name='google',
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
        client_kwargs={'scope': 'openid email profile'}
    )
else:
    app.logger.warning('GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET not set. Google OAuth disabled.')


# --- Helper Functions & Decorators ---
def get_or_create_user(user_info):
    email = user_info.get("email")
    name = user_info.get("name")
    picture = user_info.get("picture")
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user_row = cur.fetchone()
            if user_row:
                user = load_user(user_row['user_id'])
                return user, False
            else:
                cur.execute(
                    "INSERT INTO users (name, email, role, profile_picture) VALUES (%s, %s, %s, %s) RETURNING user_id",
                    (name, email, "pending_approval", picture)
                )
                user_id = cur.fetchone()[0]
                conn.commit()
                user = load_user(user_id)
                return user, True
    except Exception as e:
        app.logger.error(f"Error in get_or_create_user: {e}")
        return None, False

def role_required(*allowed_roles):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return jsonify({'error': 'Authentication required'}), 401
            if current_user.role == 'super_admin':
                return f(*args, **kwargs)
            if current_user.role not in allowed_roles:
                return jsonify({'error': 'Insufficient permissions'}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator

def get_or_create_master_id(cur, value, table_name, id_col, name_col):
    """
    Safely retrieves or creates a master record with SQL injection protection.
    
    Args:
        cur: Database cursor
        value: Value to find or insert
        table_name: Name of the master table
        id_col: Name of the ID column
        name_col: Name of the name column
    
    Returns:
        int: ID of the found or created record
    """
    # Ensure value is a stripped string, default to "--" if empty
    value = str(value).strip()
    if not value:
        value = "--"
    
    # ✅ SECURITY FIX: Use psycopg2.sql for safe identifier quoting
    select_query = sql.SQL("SELECT {} FROM {} WHERE {} = %s").format(
        sql.Identifier(id_col),
        sql.Identifier(table_name),
        sql.Identifier(name_col)
    )
    cur.execute(select_query, (value,))
    row = cur.fetchone()
    
    if row:
        return row[0]
    
    # If not found, create new record with safe SQL
    insert_query = sql.SQL("INSERT INTO {} ({}) VALUES (%s) RETURNING {}").format(
        sql.Identifier(table_name),
        sql.Identifier(name_col),
        sql.Identifier(id_col)
    )
    cur.execute(insert_query, (value,))
    new_id = cur.fetchone()[0]
    return new_id

def get_or_create_item_master_id(cur, name, model, variation, description):
    """Finds an existing item_master or creates a new one, returning its ID."""
    model_id = get_or_create_master_id(cur, model, 'model_master', 'model_id', 'model_name')
    variation_id = get_or_create_master_id(cur, variation, 'variation_master', 'variation_id', 'variation_name')
    
    cur.execute(
        "SELECT item_id FROM item_master WHERE name=%s AND model_id=%s AND variation_id=%s AND COALESCE(description,'')=%s",
        (name, model_id, variation_id, description or '')
    )
    item_row = cur.fetchone()
    
    if item_row:
        return item_row[0]
    else:
        cur.execute(
            "INSERT INTO item_master(name, model_id, variation_id, description) VALUES(%s,%s,%s,%s) RETURNING item_id",
            (name, model_id, variation_id, description)
        )
        return cur.fetchone()[0]

# --- Main Page Routes ---
@app.route('/')
@login_required
def home():
    return redirect(url_for('dashboard'))

@app.route('/dashboard')
@login_required
def dashboard():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            # Total Stock
            cur.execute("SELECT SUM(opening_stock) FROM item_variant")
            total_stock = cur.fetchone()[0] or 0

            # Low Stock Items
            cur.execute("SELECT COUNT(*) FROM item_variant WHERE opening_stock <= threshold")
            low_stock_items = cur.fetchone()[0] or 0

            # Total Suppliers
            cur.execute("SELECT COUNT(*) FROM suppliers")
            total_suppliers = cur.fetchone()[0] or 0

        metrics = {
            'total_stock': int(total_stock),
            'low_stock_items': low_stock_items,
            'total_suppliers': total_suppliers
        }
    except Exception as e:
        app.logger.error(f"Error fetching dashboard metrics: {e}")
        metrics = {
            'total_stock': 'N/A',
            'low_stock_items': 'N/A',
            'total_suppliers': 'N/A'
        }
    return render_template('dashboard_new.html', metrics=metrics)

@app.route('/inventory')
@login_required
def inventory():
    return render_template('inventory.html')

@app.route('/user-management')
@login_required
@role_required('super_admin')
def user_management():
    return render_template('user_management.html')

@app.route('/suppliers')
@login_required
def suppliers():
    return render_template('suppliers.html')

@app.route('/purchase-orders')
@login_required
def purchase_orders():
    return render_template('purchase_orders.html')

@app.route('/stock-ledger')
@login_required
def stock_ledger():
    return render_template('stock_ledger.html')

@app.route('/low-stock-report')
@login_required
def low_stock_report():
    return render_template('low_stock_report.html')

@app.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    if request.method == 'POST':
        name = request.form.get('name', current_user.name)
        company = request.form.get('company')
        mobile = request.form.get('mobile')
        file = request.files.get('profile_picture')
        
        profile_path = current_user.profile_picture
        if file and file.filename:
            # ✅ SECURITY FIX: Validate file before saving
            is_valid, error_msg = validate_upload(file)
            if not is_valid:
                flash(error_msg, 'error')
                return redirect(url_for('profile'))

            uploads_dir = os.path.join(app.root_path, 'static', 'uploads')
            os.makedirs(uploads_dir, exist_ok=True)
            safe_name = secure_filename(file.filename)
            
            # Generate unique filename
            filename = f"{current_user.id}_{uuid.uuid4().hex[:8]}_{safe_name}"
            file.save(os.path.join(uploads_dir, filename))
            profile_path = f"uploads/{filename}"

        try:
            with database.get_conn() as (conn, cur):
                cur.execute(
                    "UPDATE users SET name = %s, profile_picture = %s, company = %s, mobile = %s WHERE user_id = %s",
                    (name, profile_path, company, mobile, current_user.id)
                )
                conn.commit()
            flash('Profile updated successfully!', 'success')
            return redirect(url_for('profile'))
        except Exception as e:
            app.logger.error(f"Error updating profile for user {current_user.id}: {e}")
            flash('Failed to update profile due to a server error.', 'error')

    return render_template('profile.html', user=current_user)

@app.route('/change_password', methods=['POST'])
@login_required
def change_password():
    current_password = request.form.get('current_password')
    new_password = request.form.get('new_password')
    confirm_password = request.form.get('confirm_password')

    if not all([current_password, new_password, confirm_password]):
        flash('All password fields are required.', 'error')
        return redirect(url_for('profile'))

    if new_password != confirm_password:
        flash('New passwords do not match.', 'error')
        return redirect(url_for('profile'))

    is_valid, message = validate_password(new_password)
    if not is_valid:
        flash(message, 'error')
        return redirect(url_for('profile'))

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT password_hash FROM users WHERE user_id = %s", (current_user.id,))
            user_row = cur.fetchone()

            if not user_row or not check_password_hash(user_row['password_hash'], current_password):
                flash('Incorrect current password.', 'error')
                return redirect(url_for('profile'))

            new_password_hash = generate_password_hash(new_password)
            cur.execute("UPDATE users SET password_hash = %s WHERE user_id = %s", (new_password_hash, current_user.id))
            conn.commit()

        flash('Password updated successfully!', 'success')
        return redirect(url_for('profile'))
    except Exception as e:
        app.logger.error(f"Error changing password for user {current_user.id}: {e}")
        flash('An error occurred while changing your password.', 'error')
        return redirect(url_for('profile'))

# --- Auth Routes ---
@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("5 per minute")
def login():
    if current_user.is_authenticated:
        return redirect(url_for('home'))
    
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                cur.execute("SELECT * FROM users WHERE email = %s", (email,))
                user_row = cur.fetchone()
            
            if user_row and check_password_hash(user_row.get('password_hash') or '', password):
                user = load_user(user_row['user_id'])
                if user.role == 'pending_approval':
                    flash('Your account is pending approval by an administrator.', 'error')
                    return redirect(url_for('login'))
                login_user(user)
                return redirect(url_for('dashboard'))
            else:
                flash("Invalid email or password.", 'error')
                return redirect(url_for('login'))
        except Exception as e:
            app.logger.error(f"Manual login error: {e}")
            flash("An error occurred during login.", 'error')
            return redirect(url_for('login'))

    return render_template('login.html', google_enabled=bool(google))

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for('home'))
    if request.method == 'POST':
        name = request.form.get('name')
        email = request.form.get('email')
        password = request.form.get('password')
        if not (name and email and password):
            flash("Name, email, and password are required.", 'error')
            return redirect(url_for('signup'))
        
        # ✅ SECURITY: Validate password strength
        is_valid, message = validate_password(password)
        if not is_valid:
            flash(message, 'error')
            return redirect(url_for('signup'))
        
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                cur.execute("SELECT user_id FROM users WHERE email = %s", (email,))
                if cur.fetchone():
                    flash("Email address already registered.", 'error')
                    return redirect(url_for('signup'))
                
                password_hash = generate_password_hash(password)
                cur.execute(
                    "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, %s, %s)",
                    (name, email, password_hash, 'pending_approval')
                )
                conn.commit()
            
            flash('Account created! It is now pending approval by an administrator.', 'success')
            return redirect(url_for('login'))
        except Exception as e:
            app.logger.error(f"Signup error: {e}")
            flash('An error occurred. Please try again.', 'error')
    return render_template('signup.html', google_enabled=bool(google))

@app.route('/login/start')
def login_start():
    if not google:
        flash('Google OAuth is not configured.', 'error')
        return redirect(url_for('login'))
    redirect_uri = url_for('authorize', _external=True)
    return google.authorize_redirect(redirect_uri)

@app.route('/auth/google/callback')
def authorize():
    try:
        token = google.authorize_access_token()
        user_info = google.get('https://openidconnect.googleapis.com/v1/userinfo').json()
    except Exception as e:
        app.logger.error(f"Google OAuth callback error: {e}")
        flash('Google authorization failed.', 'error')
        return redirect(url_for('login'))
    
    user, created = get_or_create_user(user_info)
    if not user:
        flash('Failed to log in with Google.', 'error')
        return redirect(url_for('login'))
    
    login_user(user)
    if created:
        flash('Welcome! Your account is now pending approval.', 'success')
        return redirect(url_for('login'))
    
    return redirect(url_for('dashboard'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(os.path.join(app.root_path, 'static', 'uploads'), filename)

@app.route('/static/img/<filename>')
def img_file(filename):
    return send_from_directory(os.path.join(app.root_path, 'static', 'img'), filename)

# --- API Routes ---
def make_api_crud_routes(app, entity_name, table_name, id_col, name_col):
    plural_name = f"{entity_name}s"
    
    @app.route(f'/api/{plural_name}', methods=['GET'], endpoint=f'get_{plural_name}')
    @login_required
    def get_entities():
        with database.get_conn() as (conn, cur):
            cur.execute(f"SELECT {id_col}, {name_col} FROM {table_name} ORDER BY {name_col}")
            items = cur.fetchall()
        return jsonify([{'id': item[0], 'name': item[1]} for item in items])

    @app.route(f'/api/{plural_name}', methods=['POST'], endpoint=f'add_{entity_name}')
    @login_required
    @role_required('admin')
    def add_entity():
        data = request.json
        name = data.get("name", "").strip()
        if not name: return jsonify({'error': 'Name is required'}), 400
        try:
            with database.get_conn() as (conn, cur):
                cur.execute(f"INSERT INTO {table_name} ({name_col}) VALUES (%s) RETURNING {id_col}", (name,))
                new_id = cur.fetchone()[0]
                conn.commit()
            return jsonify({'id': new_id, 'name': name}), 201
        except psycopg2.IntegrityError:
             return jsonify({'error': f'"{name}" already exists.'}), 409
        except Exception as e:
            app.logger.error(f"API Error adding {entity_name}: {e}")
            return jsonify({'error': 'Database error'}), 500

    @app.route(f'/api/{plural_name}/<int:item_id>', methods=['PUT'], endpoint=f'update_{entity_name}')
    @login_required
    @role_required('admin')
    def update_entity(item_id):
        data = request.json
        name = data.get("name", "").strip()
        if not name: return jsonify({'error': 'Name is required'}), 400
        try:
            with database.get_conn() as (conn, cur):
                cur.execute(f"UPDATE {table_name} SET {name_col} = %s WHERE {id_col} = %s", (name, item_id))
                conn.commit()
            return jsonify({'message': f'{entity_name.capitalize()} updated'}), 200
        except psycopg2.IntegrityError:
             return jsonify({'error': f'The name "{name}" already exists.'}), 409
        except Exception as e:
            app.logger.error(f"API Error updating {entity_name} {item_id}: {e}")
            return jsonify({'error': 'Database error'}), 500

    @app.route(f'/api/{plural_name}/<int:item_id>', methods=['DELETE'], endpoint=f'delete_{entity_name}')
    @login_required
    @role_required('admin')
    def delete_entity(item_id):
        try:
            with database.get_conn() as (conn, cur):
                cur.execute(f"DELETE FROM {table_name} WHERE {id_col} = %s", (item_id,))
                conn.commit()
            return '', 204
        except psycopg2.IntegrityError:
            return jsonify({'error': 'This item is in use and cannot be deleted.'}), 409
        except Exception as e:
            app.logger.error(f"API Error deleting {entity_name} {item_id}: {e}")
            return jsonify({'error': 'Database error'}), 500

make_api_crud_routes(app, 'color', 'color_master', 'color_id', 'color_name')
make_api_crud_routes(app, 'size', 'size_master', 'size_id', 'size_name')
make_api_crud_routes(app, 'model', 'model_master', 'model_id', 'model_name')
make_api_crud_routes(app, 'variation', 'variation_master', 'variation_id', 'variation_name')

@app.route('/api/colors/<int:color_id>/dependencies', methods=['GET'])
@login_required
def get_color_dependencies(color_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT COUNT(*) FROM item_variant WHERE color_id = %s", (color_id,))
            count = cur.fetchone()[0]
        return jsonify({'count': count})
    except Exception as e:
        app.logger.error(f"Error fetching dependencies for color {color_id}: {e}")
        return jsonify({'error': 'Failed to fetch dependency count'}), 500

@app.route('/api/sizes/<int:size_id>/dependencies', methods=['GET'])
@login_required
def get_size_dependencies(size_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT COUNT(*) FROM item_variant WHERE size_id = %s", (size_id,))
            count = cur.fetchone()[0]
        return jsonify({'count': count})
    except Exception as e:
        app.logger.error(f"Error fetching dependencies for size {size_id}: {e}")
        return jsonify({'error': 'Failed to fetch dependency count'}), 500

@app.route('/api/models/<int:model_id>/dependencies', methods=['GET'])
@login_required
def get_model_dependencies(model_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT COUNT(*) FROM item_master WHERE model_id = %s", (model_id,))
            count = cur.fetchone()[0]
        return jsonify({'count': count})
    except Exception as e:
        app.logger.error(f"Error fetching dependencies for model {model_id}: {e}")
        return jsonify({'error': 'Failed to fetch dependency count'}), 500

@app.route('/api/variations/<int:variation_id>/dependencies', methods=['GET'])
@login_required
def get_variation_dependencies(variation_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT COUNT(*) FROM item_master WHERE variation_id = %s", (variation_id,))
            count = cur.fetchone()[0]
        return jsonify({'count': count})
    except Exception as e:
        app.logger.error(f"Error fetching dependencies for variation {variation_id}: {e}")
        return jsonify({'error': 'Failed to fetch dependency count'}), 500

# --- Supplier API Routes ---
@app.route('/api/suppliers', methods=['GET'])
@login_required
def get_suppliers():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM suppliers ORDER BY firm_name")
            suppliers = [dict(row) for row in cur.fetchall()]
        return jsonify(suppliers)
    except Exception as e:
        app.logger.error(f"Error fetching suppliers: {e}")
        return jsonify({'error': 'Failed to fetch suppliers'}), 500

@app.route('/api/suppliers', methods=['POST'])
@login_required
@role_required('admin')
def add_supplier():
    data = request.json
    firm_name = data.get('firm_name', '').strip()
    if not firm_name:
        return jsonify({'error': 'Firm name is required'}), 400
    
    try:
        with database.get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO suppliers (firm_name, address, gstin) VALUES (%s, %s, %s) RETURNING supplier_id",
                (firm_name, data.get('address'), data.get('gstin'))
            )
            supplier_id = cur.fetchone()[0]
            
            contacts = data.get('contacts', [])
            for contact in contacts:
                cur.execute(
                    "INSERT INTO supplier_contacts (supplier_id, contact_name, contact_phone, contact_email) VALUES (%s, %s, %s, %s)",
                    (supplier_id, contact.get('name'), contact.get('phone'), contact.get('email'))
                )
            
            conn.commit()
        return jsonify({'message': 'Supplier added successfully', 'supplier_id': supplier_id}), 201
    except psycopg2.IntegrityError:
        return jsonify({'error': f'Supplier with firm name "{firm_name}" already exists.'}), 409
    except Exception as e:
        app.logger.error(f"Error adding supplier: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/suppliers/<int:supplier_id>', methods=['PUT'])
@login_required
@role_required('admin')
def update_supplier(supplier_id):
    data = request.json
    firm_name = data.get('firm_name', '').strip()
    if not firm_name:
        return jsonify({'error': 'Firm name is required'}), 400

    try:
        with database.get_conn() as (conn, cur):
            cur.execute(
                "UPDATE suppliers SET firm_name = %s, address = %s, gstin = %s WHERE supplier_id = %s",
                (firm_name, data.get('address'), data.get('gstin'), supplier_id)
            )
            
            # Update contacts
            cur.execute("DELETE FROM supplier_contacts WHERE supplier_id = %s", (supplier_id,))
            contacts = data.get('contacts', [])
            for contact in contacts:
                cur.execute(
                    "INSERT INTO supplier_contacts (supplier_id, contact_name, contact_phone, contact_email) VALUES (%s, %s, %s, %s)",
                    (supplier_id, contact.get('name'), contact.get('phone'), contact.get('email'))
                )

            conn.commit()
        return jsonify({'message': 'Supplier updated successfully'}), 200
    except psycopg2.IntegrityError:
        return jsonify({'error': f'Supplier with firm name "{firm_name}" already exists.'}), 409
    except Exception as e:
        app.logger.error(f"Error updating supplier {supplier_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/suppliers/<int:supplier_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_supplier(supplier_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM suppliers WHERE supplier_id = %s", (supplier_id,))
            conn.commit()
        return '', 204
    except psycopg2.IntegrityError:
        return jsonify({'error': 'This supplier is in use and cannot be deleted.'}), 409
    except Exception as e:
        app.logger.error(f"Error deleting supplier {supplier_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/suppliers/<int:supplier_id>/contacts', methods=['GET'])
@login_required
def get_supplier_contacts(supplier_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM supplier_contacts WHERE supplier_id = %s", (supplier_id,))
            contacts = [dict(row) for row in cur.fetchall()]
        return jsonify(contacts)
    except Exception as e:
        app.logger.error(f"Error fetching contacts for supplier {supplier_id}: {e}")
        return jsonify({'error': 'Failed to fetch contacts'}), 500

@app.route('/api/suppliers/<int:supplier_id>/rates', methods=['GET'])
@login_required
def get_supplier_rates(supplier_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT sir.rate_id, sir.rate, im.item_id, im.name as item_name
                FROM supplier_item_rates sir
                JOIN item_master im ON sir.item_id = im.item_id
                WHERE sir.supplier_id = %s
            """, (supplier_id,))
            rates = [dict(row) for row in cur.fetchall()]
        return jsonify(rates)
    except Exception as e:
        app.logger.error(f"Error fetching rates for supplier {supplier_id}: {e}")
        return jsonify({'error': 'Failed to fetch rates'}), 500

@app.route('/api/suppliers/<int:supplier_id>/rates', methods=['POST'])
@login_required
@role_required('admin')
def add_supplier_rate(supplier_id):
    data = request.json
    item_id = data.get('item_id')
    rate = data.get('rate')
    if not item_id or not rate:
        return jsonify({'error': 'Item and rate are required'}), 400
    
    try:
        with database.get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO supplier_item_rates (supplier_id, item_id, rate) VALUES (%s, %s, %s) RETURNING rate_id",
                (supplier_id, item_id, rate)
            )
            rate_id = cur.fetchone()[0]
            conn.commit()
        return jsonify({'message': 'Rate added successfully', 'rate_id': rate_id}), 201
    except psycopg2.IntegrityError:
        return jsonify({'error': 'This item already has a rate for this supplier.'}), 409
    except Exception as e:
        app.logger.error(f"Error adding rate for supplier {supplier_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/suppliers/rates/<int:rate_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_supplier_rate(rate_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM supplier_item_rates WHERE rate_id = %s", (rate_id,))
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting rate {rate_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/suppliers/<int:supplier_id>/ledger', methods=['GET'])
@login_required
def get_supplier_ledger(supplier_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT se.entry_date, im.name as item_name, iv.variant_id, se.quantity_added, se.cost_per_unit
                FROM stock_entries se
                JOIN item_variant iv ON se.variant_id = iv.variant_id
                JOIN item_master im ON iv.item_id = im.item_id
                WHERE se.supplier_id = %s
                ORDER BY se.entry_date DESC
            """, (supplier_id,))
            ledger_entries = [dict(row) for row in cur.fetchall()]
        return jsonify(ledger_entries)
    except Exception as e:
        app.logger.error(f"Error fetching ledger for supplier {supplier_id}: {e}")
        return jsonify({'error': 'Failed to fetch ledger'}), 500

# --- Stock Receipt API ---
@app.route('/api/stock-receipts', methods=['POST'])
@login_required
@role_required('admin')
def add_stock_receipt():
    data = request.json
    bill_number = data.get('bill_number')
    supplier_id = data.get('supplier_id')
    tax_percentage = data.get('tax_percentage')
    discount_percentage = data.get('discount_percentage')
    po_id = data.get('po_id')
    items = data.get('items', [])

    if not supplier_id or not items:
        return jsonify({'error': 'Supplier and at least one item are required'}), 400

    try:
        with database.get_conn() as (conn, cur):
            # Generate receipt number
            cur.execute("SELECT nextval('stock_receipt_number_seq')")
            receipt_number = f"RCPT-{cur.fetchone()[0]}"

            # Calculate totals
            total_amount = sum(float(item['quantity']) * float(item['cost']) for item in items)
            tax_amount = total_amount * (float(tax_percentage or 0) / 100)
            discount_amount = total_amount * (float(discount_percentage or 0) / 100)
            grand_total = total_amount + tax_amount - discount_amount

            # Create stock receipt
            cur.execute(
                """
                INSERT INTO stock_receipts (receipt_number, bill_number, supplier_id, total_amount, tax_percentage, discount_percentage, discount_amount, grand_total, po_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING receipt_id
                """,
                (receipt_number, bill_number, supplier_id, total_amount, tax_percentage, discount_percentage, discount_amount, grand_total, po_id if po_id else None)
            )
            receipt_id = cur.fetchone()[0]

            # Create stock entries for each item
            for item in items:
                variant_id = item.get('variant_id')
                quantity = item.get('quantity')
                cost = item.get('cost')

                if not variant_id or not quantity:
                    continue

                # Add stock entry
                cur.execute(
                    "INSERT INTO stock_entries (variant_id, quantity_added, supplier_id, cost_per_unit, receipt_id) VALUES (%s, %s, %s, %s, %s)",
                    (variant_id, quantity, supplier_id, cost, receipt_id)
                )
                
                # Update item variant stock
                cur.execute(
                    "UPDATE item_variant SET opening_stock = opening_stock + %s WHERE variant_id = %s",
                    (quantity, variant_id)
                )

                # If a PO is linked, update the received quantity
                if po_id:
                    cur.execute(
                        "UPDATE purchase_order_items SET received_quantity = received_quantity + %s WHERE po_id = %s AND variant_id = %s",
                        (quantity, po_id, variant_id)
                    )

                # Update supplier item rate
                if supplier_id and cost:
                    cur.execute(
                        """
                        INSERT INTO supplier_item_rates (supplier_id, item_id, rate)
                        SELECT %s, item_id, %s FROM item_variant WHERE variant_id = %s
                        ON CONFLICT (supplier_id, item_id) DO UPDATE SET rate = EXCLUDED.rate
                        """,
                        (supplier_id, cost, variant_id)
                    )

            # Update PO status
            if po_id:
                cur.execute("""
                    SELECT 
                        SUM(quantity) as total_ordered, 
                        SUM(received_quantity) as total_received 
                    FROM purchase_order_items 
                    WHERE po_id = %s
                """, (po_id,))
                po_status = cur.fetchone()
                if po_status:
                    total_ordered, total_received = po_status
                    if total_received >= total_ordered:
                        new_status = 'Completed'
                    elif total_received > 0:
                        new_status = 'Partially Received'
                    else:
                        new_status = 'Ordered'
                    cur.execute("UPDATE purchase_orders SET status = %s WHERE po_id = %s", (new_status, po_id))

            conn.commit()
        return jsonify({'message': 'Stock received successfully', 'receipt_id': receipt_id}), 201
    except Exception as e:
        app.logger.error(f"Error receiving stock receipt: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/stock-receipts', methods=['GET'])
@login_required
def get_stock_receipts():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT sr.*, s.firm_name
                FROM stock_receipts sr
                JOIN suppliers s ON sr.supplier_id = s.supplier_id
                ORDER BY sr.receipt_date DESC
            """)
            receipts = [dict(row) for row in cur.fetchall()]
        return jsonify(receipts)
    except Exception as e:
        app.logger.error(f"Error fetching stock receipts: {e}")
        return jsonify({'error': 'Failed to fetch stock receipts'}), 500

@app.route('/api/stock-receipts/<int:receipt_id>', methods=['GET'])
@login_required
def get_stock_receipt_details(receipt_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    se.entry_id,
                    im.name as item_name,
                    cm.color_name,
                    sm.size_name,
                    se.quantity_added,
                    se.cost_per_unit
                FROM stock_entries se
                JOIN item_variant iv ON se.variant_id = iv.variant_id
                JOIN item_master im ON iv.item_id = im.item_id
                JOIN color_master cm ON iv.color_id = cm.color_id
                JOIN size_master sm ON iv.size_id = sm.size_id
                WHERE se.receipt_id = %s
            """, (receipt_id,))
            items = [dict(row) for row in cur.fetchall()]
        return jsonify(items)
    except Exception as e:
        app.logger.error(f"Error fetching stock receipt details for {receipt_id}: {e}")
        return jsonify({'error': 'Failed to fetch receipt details'}), 500

@app.route('/api/stock-receipts/<int:receipt_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_stock_receipt(receipt_id):
    try:
        with database.get_conn() as (conn, cur):
            # Reverse the stock entries
            cur.execute("SELECT variant_id, quantity_added FROM stock_entries WHERE receipt_id = %s", (receipt_id,))
            entries = cur.fetchall()
            for variant_id, quantity_added in entries:
                cur.execute("UPDATE item_variant SET opening_stock = opening_stock - %s WHERE variant_id = %s", (quantity_added, variant_id))

            # Delete the stock entries and receipt
            cur.execute("DELETE FROM stock_entries WHERE receipt_id = %s", (receipt_id,))
            cur.execute("DELETE FROM stock_receipts WHERE receipt_id = %s", (receipt_id,))
            
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting stock receipt {receipt_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

# --- Purchase Order API Routes ---
@app.route('/api/purchase-orders', methods=['GET'])
@login_required
def get_purchase_orders():
    status_filter = request.args.get('status')
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            query = """
                SELECT po.*, s.firm_name 
                FROM purchase_orders po
                JOIN suppliers s ON po.supplier_id = s.supplier_id
            """
            params = []
            conditions = []
            if status_filter:
                conditions.append("po.status = %s")
                params.append(status_filter)
            if start_date:
                conditions.append("po.order_date >= %s")
                params.append(start_date)
            if end_date:
                conditions.append("po.order_date <= %s")
                params.append(end_date)
            
            if conditions:
                query += " WHERE " + " AND ".join(conditions)
            
            query += " ORDER BY po.order_date DESC"

            cur.execute(query, tuple(params))
            pos = [dict(row) for row in cur.fetchall()]
        return jsonify(pos)
    except Exception as e:
        app.logger.error(f"Error fetching purchase orders: {e}")
        return jsonify({'error': 'Failed to fetch purchase orders'}), 500

@app.route('/api/purchase-orders', methods=['POST'])
@login_required
@role_required('admin')
def create_purchase_order():
    data = request.json
    supplier_id = data.get('supplier_id')
    items = data.get('items', [])
    notes = data.get('notes')
    status = data.get('status', 'Draft')

    if not supplier_id or not items:
        return jsonify({'error': 'Supplier and items are required'}), 400

    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT nextval('purchase_order_number_seq')")
            po_number = f"PO-{cur.fetchone()[0]:04d}"
            cur.execute(
                "INSERT INTO purchase_orders (supplier_id, status, po_number, notes) VALUES (%s, %s, %s, %s) RETURNING po_id",
                (supplier_id, status, po_number, notes)
            )
            po_id = cur.fetchone()[0]

            total_amount = 0
            for item in items:
                cur.execute(
                    "INSERT INTO purchase_order_items (po_id, variant_id, quantity, rate) VALUES (%s, %s, %s, %s)",
                    (po_id, item['variant_id'], item['quantity'], item['rate'])
                )
                total_amount += float(item['quantity']) * float(item['rate'])
            
            cur.execute("UPDATE purchase_orders SET total_amount = %s WHERE po_id = %s", (total_amount, po_id))

            conn.commit()
        return jsonify({'message': 'Purchase order created', 'po_id': po_id}), 201
    except Exception as e:
        app.logger.error(f"Error creating purchase order: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/purchase-orders/<int:po_id>', methods=['GET'])
@login_required
def get_purchase_order(po_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM purchase_orders WHERE po_id = %s", (po_id,))
            po = dict(cur.fetchone())

            cur.execute("""
                SELECT poi.*, im.name as item_name, iv.variant_id
                FROM purchase_order_items poi
                JOIN item_variant iv ON poi.variant_id = iv.variant_id
                JOIN item_master im ON iv.item_id = im.item_id
                WHERE poi.po_id = %s
            """, (po_id,))
            items = [dict(row) for row in cur.fetchall()]
            po['items'] = items
        return jsonify(po)
    except Exception as e:
        app.logger.error(f"Error fetching purchase order {po_id}: {e}")
        return jsonify({'error': 'Failed to fetch purchase order'}), 500

@app.route('/api/purchase-orders/<int:po_id>', methods=['PUT'])
@login_required
@role_required('admin')
def update_purchase_order(po_id):
    data = request.json
    items = data.get('items', [])
    status = data.get('status')
    notes = data.get('notes')

    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM purchase_order_items WHERE po_id = %s", (po_id,))
            
            total_amount = 0
            for item in items:
                cur.execute(
                    "INSERT INTO purchase_order_items (po_id, variant_id, quantity, rate) VALUES (%s, %s, %s, %s)",
                    (po_id, item['variant_id'], item['quantity'], item['rate'])
                )
                total_amount += float(item['quantity']) * float(item['rate'])
            
            cur.execute("UPDATE purchase_orders SET total_amount = %s, status = %s, notes = %s WHERE po_id = %s", (total_amount, status, notes, po_id))
            
            conn.commit()
        return jsonify({'message': 'Purchase order updated'}), 200
    except Exception as e:
        app.logger.error(f"Error updating purchase order {po_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/purchase-orders/<int:po_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_purchase_order(po_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM purchase_orders WHERE po_id = %s", (po_id,))
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting purchase order {po_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/purchase-orders/by-number/<po_number>', methods=['GET'])
@login_required
def get_purchase_order_by_number(po_number):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM purchase_orders WHERE po_number = %s", (po_number,))
            po = dict(cur.fetchone())

            cur.execute("""
                SELECT poi.*, im.name as item_name, iv.variant_id
                FROM purchase_order_items poi
                JOIN item_variant iv ON poi.variant_id = iv.variant_id
                JOIN item_master im ON iv.item_id = im.item_id
                WHERE poi.po_id = %s
            """, (po['po_id'],))
            items = [dict(row) for row in cur.fetchall()]
            po['items'] = items
        return jsonify(po)
    except Exception as e:
        app.logger.error(f"Error fetching purchase order by number {po_number}: {e}")
        return jsonify({'error': 'Failed to fetch purchase order'}), 500

@app.route('/api/item-names', methods=['GET'])
@login_required
def get_item_names():
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("SELECT DISTINCT name FROM item_master ORDER BY name")
            names = [row[0] for row in cur.fetchall()]
        return jsonify(names)
    except Exception as e:
        app.logger.error(f"Error fetching item names: {e}")
        return jsonify({'error': 'Failed to fetch item names'}), 500

@app.route('/api/models-by-item', methods=['GET'])
@login_required
def get_models_for_item():
    item_name = request.args.get('item_name')
    if not item_name:
        return jsonify([])
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("""
                SELECT DISTINCT mm.model_id, mm.model_name 
                FROM model_master mm
                JOIN item_master im ON mm.model_id = im.model_id
                WHERE im.name = %s 
                ORDER BY mm.model_name
            """, (item_name,))
            models = [{'id': row[0], 'name': row[1]} for row in cur.fetchall() if row[1]]
        return jsonify(models)
    except Exception as e:
        app.logger.error(f"Error fetching models for item {item_name}: {e}")
        return jsonify({'error': 'Failed to fetch models'}), 500

@app.route('/api/variations-by-item-model', methods=['GET'])
@login_required
def get_variations_for_item_model():
    item_name = request.args.get('item_name')
    model_name = request.args.get('model')

    if not item_name:
        return jsonify([])

    try:
        with database.get_conn() as (conn, cur):
            query = """
                SELECT DISTINCT vm.variation_id, vm.variation_name 
                FROM variation_master vm
                JOIN item_master im ON vm.variation_id = im.variation_id
                WHERE im.name = %s
            """
            params = [item_name]

            if model_name:
                query += """
                    AND im.model_id IN (SELECT model_id FROM model_master WHERE model_name = %s)
                """
                params.append(model_name)
            
            query += " ORDER BY vm.variation_name"

            cur.execute(query, tuple(params))
            variations = [{'id': row[0], 'name': row[1]} for row in cur.fetchall() if row[1]]
        return jsonify(variations)
    except Exception as e:
        app.logger.error(f"Error fetching variations for item '{item_name}' and model '{model_name}': {e}")
        return jsonify({'error': 'Failed to fetch variations'}), 500

@app.route('/api/items', methods=['GET'])
@login_required
def get_items():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    search_term = request.args.get('search', '')
    show_low_stock_only = request.args.get('low_stock', 'false').lower() == 'true'
    
    offset = (page - 1) * per_page
    
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            base_query = """
                FROM item_master i
                LEFT JOIN model_master mm ON i.model_id = mm.model_id
                LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
                LEFT JOIN (
                    SELECT
                        item_id,
                        COUNT(*) as variant_count,
                        SUM(opening_stock) as total_stock,
                        SUM(threshold) as total_threshold,
                        BOOL_OR(opening_stock <= threshold) as has_low_stock_variants
                    FROM item_variant
                    GROUP BY item_id
                ) as variant_summary ON i.item_id = variant_summary.item_id
            """
            
            conditions = []
            params = []
            
            if show_low_stock_only:
                conditions.append("COALESCE(variant_summary.has_low_stock_variants, FALSE) = TRUE")

            if search_term:
                conditions.append("(i.name ILIKE %s OR mm.model_name ILIKE %s OR vm.variation_name ILIKE %s)")
                search_pattern = f"%{search_term}%"
                params.extend([search_pattern, search_pattern, search_pattern])

            where_clause = ""
            if conditions:
                where_clause = "WHERE " + " AND ".join(conditions)

            # Query for total count
            count_query = f"SELECT COUNT(i.item_id) {base_query} {where_clause}"
            cur.execute(count_query, tuple(params))
            total_items = cur.fetchone()[0]

            # Query for paginated items
            items_query = f"""
                SELECT
                    i.item_id, i.name, mm.model_name as model, vm.variation_name as variation,
                    i.description, i.image_path,
                    COALESCE(variant_summary.variant_count, 0) as variant_count,
                    COALESCE(variant_summary.total_stock, 0) as total_stock,
                    COALESCE(variant_summary.total_threshold, 0) as total_threshold,
                    COALESCE(variant_summary.has_low_stock_variants, FALSE) as has_low_stock_variants
                {base_query}
                {where_clause}
                ORDER BY i.name
                LIMIT %s OFFSET %s
            """
            
            cur.execute(items_query, tuple(params + [per_page, offset]))
            items = cur.fetchall()
            
            items_data = [{
                'id': item['item_id'], 'name': item['name'], 'model': item['model'],
                'variation': item['variation'], 'description': item['description'],
                'image_path': item['image_path'],
                'threshold': int(item['total_threshold'] or 0),
                'variant_count': item['variant_count'],
                'total_stock': int(item['total_stock'] or 0),
                'has_low_stock_variants': item['has_low_stock_variants']
            } for item in items]

            return jsonify({
                'items': items_data,
                'total_items': total_items,
                'page': page,
                'per_page': per_page,
                'total_pages': (total_items + per_page - 1) // per_page
            })
    except Exception as e:
        app.logger.error(f"Error fetching items: {e}")
        return jsonify({'error': 'Failed to fetch items'}), 500

@app.route('/api/items', methods=['POST'])
@login_required
@limiter.limit("10 per minute")
def add_item():
    data = request.form.to_dict()
    if not data.get('name') or 'variants' not in data:
        return jsonify({'error': 'Name and variants are required'}), 400
    
    image_path = None
    if 'image' in request.files:
        file = request.files['image']
        if file.filename:
            # ✅ SECURITY FIX: Validate file before saving
            is_valid, error_msg = validate_upload(file)
            if not is_valid:
                return jsonify({'error': error_msg}), 400
            
            uploads_dir = os.path.join(app.root_path, 'static', 'uploads')
            os.makedirs(uploads_dir, exist_ok=True)
            safe_name = secure_filename(file.filename)
            
            # Generate unique filename
            filename = f"{uuid.uuid4().hex[:8]}_{safe_name}"
            file.save(os.path.join(uploads_dir, filename))
            image_path = f"uploads/{filename}"

    try:
        with database.get_conn() as (conn, cur):
            # Check for existing item with the same composite key
            model_id = get_or_create_master_id(cur, data.get('model'), 'model_master', 'model_id', 'model_name')
            variation_id = get_or_create_master_id(cur, data.get('variation'), 'variation_master', 'variation_id', 'variation_name')

            cur.execute(
                """
                SELECT item_id FROM item_master 
                WHERE name = %s AND model_id = %s AND variation_id = %s AND COALESCE(description, '') = %s
                """,
                (data['name'], model_id, variation_id, data.get('description', ''))
            )
            if cur.fetchone():
                return jsonify({'error': 'An item with the same name, model, variation, and description already exists.'}), 409

            cur.execute(
                "INSERT INTO item_master (name, model_id, variation_id, description, image_path) VALUES (%s, %s, %s, %s, %s) RETURNING item_id",
                (data['name'], model_id, variation_id, data.get('description'), image_path)
            )
            item_id = cur.fetchone()[0]
            variants = json.loads(data['variants'])
            for v in variants:
                color_id = get_or_create_master_id(cur, v['color'], 'color_master', 'color_id', 'color_name')
                size_id = get_or_create_master_id(cur, v['size'], 'size_master', 'size_id', 'size_name')
                cur.execute(
                    "INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit) VALUES (%s, %s, %s, %s, %s, %s)",
                    (item_id, color_id, size_id, v.get('opening_stock', 0), v.get('threshold', 5), v.get('unit'))
                )
            conn.commit()
        return jsonify({'message': 'Item saved successfully', 'item_id': item_id}), 201
    except psycopg2.IntegrityError as e:
        app.logger.warning(f"Integrity error adding item variant: {e}")
        return jsonify({'error': 'A variant with the same color and size already exists for this item.'}), 409
    except Exception as e:
        app.logger.error(f"Error in add_item API: {e}")
        return jsonify({'error': 'Failed to save item due to a server error.'}), 500

@app.route('/api/items/<int:item_id>', methods=['GET'])
@login_required
def get_item(item_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    i.item_id, i.name, mm.model_name as model, vm.variation_name as variation, 
                    i.description, i.image_path
                FROM item_master i
                LEFT JOIN model_master mm ON i.model_id = mm.model_id
                LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
                WHERE i.item_id = %s
            """, (item_id,))
            item = cur.fetchone()
            if not item: return jsonify({'error': 'Item not found'}), 404
            
            # Convert row object to a dictionary to send as JSON
            item_dict = {
                'id': item['item_id'],
                'name': item['name'],
                'model': item['model'],
                'variation': item['variation'],
                'description': item['description'],
                'image_path': item['image_path']
            }
            return jsonify(item_dict)
    except Exception as e:
        app.logger.error(f"Error fetching item {item_id}: {e}")
        return jsonify({'error': 'Failed to fetch item'}), 500

@app.route('/api/items/by-name', methods=['GET'])
@login_required
def get_item_by_name():
    item_name = request.args.get('name')
    if not item_name:
        return jsonify({'error': 'Item name is required'}), 400
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT i.item_id, i.name, mm.model_name as model, vm.variation_name as variation, i.description
                FROM item_master i
                LEFT JOIN model_master mm ON i.model_id = mm.model_id
                LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
                WHERE i.name = %s
            """, (item_name,))
            item = cur.fetchone()
            if not item:
                return jsonify(None)
            return jsonify(dict(item))
    except Exception as e:
        app.logger.error(f"Error fetching item by name '{item_name}': {e}")
        return jsonify({'error': 'Failed to fetch item by name'}), 500

@app.route('/api/all-variants', methods=['GET'])
@login_required
def get_all_variants():
    """Provides a flat list of all variants for dropdowns."""
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    iv.variant_id,
                    im.name || ' - ' || cm.color_name || ' / ' || sm.size_name AS full_name
                FROM item_variant iv
                JOIN item_master im ON iv.item_id = im.item_id
                JOIN color_master cm ON iv.color_id = cm.color_id
                JOIN size_master sm ON iv.size_id = sm.size_id
                ORDER BY full_name
            """)
            variants = [{'id': row['variant_id'], 'name': row['full_name']} for row in cur.fetchall()]
        return jsonify(variants)
    except Exception as e:
        app.logger.error(f"Error fetching all variants: {e}")
        return jsonify({'error': 'Failed to fetch variants'}), 500

@app.route('/api/variants/search', methods=['GET'])
@login_required
def search_variants():
    """Provides a searchable list of all variants for advanced selection."""
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    iv.variant_id,
                    im.name as item_name,
                    mm.model_name,
                    vm.variation_name,
                    cm.color_name,
                    sm.size_name,
                    im.description
                FROM item_variant iv
                JOIN item_master im ON iv.item_id = im.item_id
                LEFT JOIN model_master mm ON im.model_id = mm.model_id
                LEFT JOIN variation_master vm ON im.variation_id = vm.variation_id
                JOIN color_master cm ON iv.color_id = cm.color_id
                JOIN size_master sm ON iv.size_id = sm.size_id
                ORDER BY item_name, model_name, variation_name, color_name, size_name
            """)
            variants = [dict(row) for row in cur.fetchall()]
        return jsonify(variants)
    except Exception as e:
        app.logger.error(f"Error searching variants: {e}")
        return jsonify({'error': 'Failed to search variants'}), 500

@app.route('/api/compare-rates/<int:variant_id>', methods=['GET'])
@login_required
def compare_rates(variant_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT s.firm_name as supplier_name, sir.rate
                FROM supplier_item_rates sir
                JOIN suppliers s ON sir.supplier_id = s.supplier_id
                WHERE sir.item_id = (SELECT item_id FROM item_variant WHERE variant_id = %s)
                ORDER BY sir.rate ASC
            """, (variant_id,))
            rates = [dict(row) for row in cur.fetchall()]
        return jsonify(rates)
    except Exception as e:
        app.logger.error(f"Error comparing rates for variant {variant_id}: {e}")
        return jsonify({'error': 'Failed to compare rates'}), 500

@app.route('/api/variant-rate', methods=['GET'])
@login_required
def get_variant_rate():
    variant_id = request.args.get('variant_id')
    supplier_id = request.args.get('supplier_id')
    if not variant_id or not supplier_id:
        return jsonify({'error': 'Variant ID and Supplier ID are required'}), 400
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT rate FROM supplier_item_rates
                WHERE item_id = (SELECT item_id FROM item_variant WHERE variant_id = %s)
                AND supplier_id = %s
            """, (variant_id, supplier_id))
            rate = cur.fetchone()
            return jsonify({'rate': rate[0] if rate else 0})
    except Exception as e:
        app.logger.error(f"Error fetching variant rate: {e}")
        return jsonify({'error': 'Failed to fetch rate'}), 500
        
@app.route('/api/items/<int:item_id>', methods=['PUT'])
@login_required
def update_item(item_id):
    data = request.form.to_dict()
    
    image_path = None
    if 'image' in request.files:
        file = request.files['image']
        if file.filename:
            uploads_dir = os.path.join(app.root_path, 'static', 'uploads')
            os.makedirs(uploads_dir, exist_ok=True)
            safe_name = secure_filename(file.filename)
            filename = f"{uuid.uuid4().hex[:8]}_{safe_name}"
            file.save(os.path.join(uploads_dir, filename))
            image_path = f"uploads/{filename}"

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT color_name, color_id FROM color_master")
            color_cache = {name: id for name, id in cur.fetchall()}
            
            cur.execute("SELECT size_name, size_id FROM size_master")
            size_cache = {name: id for name, id in cur.fetchall()}

            def get_master_id_with_cache(cache, value, table_name, id_col, name_col):
                value = str(value).strip()
                if not value: value = "--"
                
                if value in cache:
                    return cache[value]
                
                cur.execute(f"INSERT INTO {table_name} ({name_col}) VALUES (%s) RETURNING {id_col}", (value,))
                new_id = cur.fetchone()[0]
                cache[value] = new_id
                return new_id

            model_id = get_or_create_master_id(cur, data.get('model'), 'model_master', 'model_id', 'model_name')
            variation_id = get_or_create_master_id(cur, data.get('variation'), 'variation_master', 'variation_id', 'variation_name')

            cur.execute(
                "SELECT item_id FROM item_master WHERE name = %s AND model_id = %s AND variation_id = %s AND COALESCE(description, '') = %s AND item_id != %s",
                (data['name'], model_id, variation_id, data.get('description', ''), item_id)
            )
            conflicting_item = cur.fetchone()
            if conflicting_item:
                return jsonify({
                    'error': 'Another item with the same name, model, variation, and description already exists.',
                    'conflict': True,
                    'conflicting_item_id': conflicting_item['item_id'],
                    'original_item_id': item_id
                }), 409

            update_fields = {
                "name": data['name'], "model_id": model_id, "variation_id": variation_id,
                "description": data.get('description')
            }
            if image_path:
                update_fields["image_path"] = image_path

            set_clause = ", ".join([f"{key}=%s" for key in update_fields])
            values = list(update_fields.values()) + [item_id]
            
            cur.execute(f"UPDATE item_master SET {set_clause} WHERE item_id=%s", tuple(values))
            
            changed_variants = json.loads(data['variants'])

            for v in changed_variants.get('added', []):
                color_id = get_master_id_with_cache(color_cache, v['color'], 'color_master', 'color_id', 'color_name')
                size_id = get_master_id_with_cache(size_cache, v['size'], 'size_master', 'size_id', 'size_name')
                cur.execute(
                    "INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit) VALUES (%s, %s, %s, %s, %s, %s)",
                    (item_id, color_id, size_id, v.get('opening_stock', 0), v.get('threshold', 5), v.get('unit'))
                )

            for v in changed_variants.get('updated', []):
                color_id = get_master_id_with_cache(color_cache, v['color'], 'color_master', 'color_id', 'color_name')
                size_id = get_master_id_with_cache(size_cache, v['size'], 'size_master', 'size_id', 'size_name')
                cur.execute(
                    "UPDATE item_variant SET color_id = %s, size_id = %s, opening_stock = %s, threshold = %s, unit = %s WHERE variant_id = %s",
                    (color_id, size_id, v.get('opening_stock', 0), v.get('threshold', 5), v.get('unit'), v['id'])
                )

            if changed_variants.get('deleted'):
                deleted_ids = [int(id) for id in changed_variants['deleted'] if str(id).isdigit()]
                if deleted_ids:
                    cur.execute("DELETE FROM item_variant WHERE variant_id = ANY(%s)", (deleted_ids,))

            # --- New: Fetch the updated summary data for the item ---
            cur.execute("""
                SELECT 
                    i.item_id, i.name, mm.model_name as model, vm.variation_name as variation, 
                    i.description, i.image_path,
                    (SELECT COUNT(*) FROM item_variant v WHERE v.item_id = i.item_id) as variant_count,
                    (SELECT COALESCE(SUM(v.opening_stock), 0) FROM item_variant v WHERE v.item_id = i.item_id) as total_stock,
                    EXISTS (
                        SELECT 1 FROM item_variant v_check 
                        WHERE v_check.item_id = i.item_id AND v_check.opening_stock <= v_check.threshold
                    ) as has_low_stock_variants
                FROM item_master i
                LEFT JOIN model_master mm ON i.model_id = mm.model_id
                LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
                WHERE i.item_id = %s
            """, (item_id,))
            updated_item_data = cur.fetchone()
            # --- End of New ---

            conn.commit()
        
        # Return the updated item data so the frontend can update the UI without a full refresh
        return jsonify({
            'message': 'Item updated successfully',
            'item': {
                'id': updated_item_data['item_id'], 'name': updated_item_data['name'], 'model': updated_item_data['model'],
                'variation': updated_item_data['variation'], 'description': updated_item_data['description'],
                'image_path': updated_item_data['image_path'],
                'variant_count': updated_item_data['variant_count'], 
                'total_stock': int(updated_item_data['total_stock'] or 0),
                'has_low_stock_variants': updated_item_data['has_low_stock_variants']
            }
        }), 200
    except psycopg2.IntegrityError as e:
        app.logger.warning(f"Integrity error updating item variant: {e}")
        return jsonify({'error': 'A variant with the same color and size already exists for this item.'}), 409
    except Exception as e:
        app.logger.error(f"Error updating item {item_id}: {e}")
        return jsonify({'error': 'Failed to update item'}), 500

@app.route('/api/items/<int:item_id>/variants', methods=['GET'])
@login_required
def get_item_variants(item_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    v.variant_id, v.opening_stock, v.threshold, c.color_name, s.size_name,
                    c.color_id, s.size_id, v.unit
                FROM item_variant v
                JOIN color_master c ON v.color_id = c.color_id
                JOIN size_master s ON v.size_id = s.size_id
                WHERE v.item_id = %s
                ORDER BY c.color_name, s.size_name
            """, (item_id,))
            variants = cur.fetchall()
            return jsonify([{
                'id': v['variant_id'], 'color': {'id': v['color_id'], 'name': v['color_name']},
                'size': {'id': v['size_id'], 'name': v['size_name']},
                'opening_stock': v['opening_stock'], 'threshold': v['threshold'], 'unit': v['unit']
            } for v in variants])
    except Exception as e:
        app.logger.error(f"Error fetching item variants: {e}")
        return jsonify({'error': 'Failed to fetch variants'}), 500

@app.route('/api/items/bulk-delete', methods=['POST'])
@login_required
@role_required('admin')
def bulk_delete_items():
    data = request.json
    item_ids = data.get('item_ids', [])

    if not item_ids:
        return jsonify({'error': 'No item IDs provided'}), 400

    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM item_master WHERE item_id = ANY(%s)", (item_ids,))
            conn.commit()
        return jsonify({'message': f'{len(item_ids)} items deleted successfully.'}), 200
    except Exception as e:
        app.logger.error(f"Error bulk deleting items: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/items/<int:item_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_item(item_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM item_master WHERE item_id = %s", (item_id,))
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting item {item_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/variants/<int:variant_id>/stock', methods=['PUT'])
@login_required
@limiter.limit("30 per minute")
def update_variant_stock(variant_id):
    data = request.json
    new_stock = data.get('stock')
    if new_stock is None or not str(new_stock).isdigit():
        return jsonify({'error': 'A valid, non-negative stock number is required.'}), 400
    
    try:
        with database.get_conn() as (conn, cur):
            # ✅ BUG FIX: Return complete updated variant data
            cur.execute(
                """
                UPDATE item_variant 
                SET opening_stock = %s 
                WHERE variant_id = %s 
                RETURNING item_id, opening_stock, threshold
                """,
                (int(new_stock), variant_id)
            )
            
            updated_row = cur.fetchone()
            if not updated_row:
                return jsonify({'error': 'Variant not found'}), 404
            
            item_id, updated_stock, threshold = updated_row
            
            # Calculate if variant is now low stock
            is_low_stock = updated_stock <= threshold

            # Your existing logic to calculate totals is still good
            cur.execute("SELECT SUM(opening_stock) FROM item_variant WHERE item_id = %s", (item_id,))
            total_stock = cur.fetchone()[0]

            cur.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM item_variant 
                    WHERE item_id = %s AND opening_stock <= threshold
                )
            """, (item_id,))
            item_has_low_stock = cur.fetchone()[0]

            conn.commit()
            
            return jsonify({
                'message': 'Stock updated successfully',
                'new_total_stock': int(total_stock or 0),
                'item_has_low_stock': item_has_low_stock,
                'updated_variant': {
                    'stock': updated_stock,
                    'threshold': threshold,
                    'is_low_stock': is_low_stock
                }
            }), 200
            
    except Exception as e:
        app.logger.error(f"Error updating stock for variant {variant_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/variants/<int:variant_id>/threshold', methods=['PUT'])
@login_required
def update_variant_threshold(variant_id):
    data = request.json
    new_threshold = data.get('threshold')
    if new_threshold is None or not str(new_threshold).isdigit():
        return jsonify({'error': 'A valid, non-negative threshold is required.'}), 400

    try:
        with database.get_conn() as (conn, cur):
            cur.execute(
                "UPDATE item_variant SET threshold = %s WHERE variant_id = %s",
                (int(new_threshold), variant_id)
            )
            conn.commit()
        return jsonify({'message': 'Threshold updated successfully'}), 200
    except Exception as e:
        app.logger.error(f"Error updating threshold for variant {variant_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/variants/<int:variant_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_variant(variant_id):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM item_variant WHERE variant_id = %s", (variant_id,))
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting variant {variant_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/items/<int:item_id>/variants', methods=['POST'])
@login_required
@role_required('admin')
def add_variant(item_id):
    data = request.json
    try:
        with database.get_conn() as (conn, cur):
            color_id = get_or_create_master_id(cur, data['color'], 'color_master', 'color_id', 'color_name')
            size_id = get_or_create_master_id(cur, data['size'], 'size_master', 'size_id', 'size_name')
            cur.execute(
                "INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit) VALUES (%s, %s, %s, %s, %s, %s) RETURNING variant_id",
                (item_id, color_id, size_id, data.get('opening_stock', 0), data.get('threshold', 5), data.get('unit'))
            )
            variant_id = cur.fetchone()[0]
            conn.commit()
            return jsonify({'message': 'Variant added successfully', 'variant_id': variant_id}), 201
    except psycopg2.IntegrityError as e:
        app.logger.warning(f"Integrity error adding variant: {e}")
        return jsonify({'error': 'A variant with the same color and size already exists for this item.'}), 409
    except Exception as e:
        app.logger.error(f"Error in add_variant API: {e}")
        return jsonify({'error': 'Failed to save variant due to a server error.'}), 500

@app.route('/api/variants/<int:variant_id>', methods=['PUT'])
@login_required
@role_required('admin')
def update_variant(variant_id):
    data = request.json
    try:
        with database.get_conn() as (conn, cur):
            color_id = get_or_create_master_id(cur, data['color'], 'color_master', 'color_id', 'color_name')
            size_id = get_or_create_master_id(cur, data['size'], 'size_master', 'size_id', 'size_name')
            cur.execute(
                "UPDATE item_variant SET color_id = %s, size_id = %s, opening_stock = %s, threshold = %s, unit = %s WHERE variant_id = %s",
                (color_id, size_id, data.get('opening_stock', 0), data.get('threshold', 5), data.get('unit'), variant_id)
            )
            conn.commit()
            return jsonify({'message': 'Variant updated successfully'}), 200
    except psycopg2.IntegrityError as e:
        app.logger.warning(f"Integrity error updating variant: {e}")
        return jsonify({'error': 'A variant with the same color and size already exists for this item.'}), 409
    except Exception as e:
        app.logger.error(f"Error updating variant {variant_id}: {e}")
        return jsonify({'error': 'Failed to update variant'}), 500

@app.route('/api/users', methods=['GET'])
@login_required
@role_required('super_admin')
def get_users():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT user_id, name, email, role FROM users WHERE role != 'super_admin' ORDER BY name")
            users = [dict(row) for row in cur.fetchall()]
        return jsonify(users)
    except Exception as e:
        app.logger.error(f"Error fetching users: {e}")
        return jsonify({'error': 'Failed to fetch users'}), 500

@app.route('/api/users/<int:user_id>/role', methods=['PUT'])
@login_required
@role_required('super_admin')
def update_user_role(user_id):
    new_role = request.json.get('role')
    allowed_roles = ['admin', 'user', 'pending_approval']
    if not new_role or new_role not in allowed_roles:
        return jsonify({'error': 'Invalid role specified.'}), 400
    
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("UPDATE users SET role = %s WHERE user_id = %s", (new_role, user_id))
            conn.commit()
        return jsonify({'message': 'User role updated successfully.'})
    except Exception as e:
        app.logger.error(f"Error updating role for user {user_id}: {e}")
        return jsonify({'error': 'Failed to update user role.'}), 500

@app.route('/api/low-stock-report', methods=['GET'])
@login_required
def get_low_stock_report():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    im.name as item_name,
                    mm.model_name,
                    vm.variation_name,
                    cm.color_name,
                    sm.size_name,
                    iv.opening_stock,
                    iv.threshold
                FROM item_variant iv
                JOIN item_master im ON iv.item_id = im.item_id
                LEFT JOIN model_master mm ON im.model_id = mm.model_id
                LEFT JOIN variation_master vm ON im.variation_id = vm.variation_id
                JOIN color_master cm ON iv.color_id = cm.color_id
                JOIN size_master sm ON iv.size_id = sm.size_id
                WHERE iv.opening_stock <= iv.threshold
                ORDER BY im.name, cm.color_name, sm.size_name
            """)
            report_data = [dict(row) for row in cur.fetchall()]
        return jsonify(report_data)
    except Exception as e:
        app.logger.error(f"Error generating low stock report: {e}")
        return jsonify({'error': 'Failed to generate low stock report'}), 500

def _process_chunk(chunk, headers):
    """Helper to process a chunk of rows for validation."""
    validated_rows = []
    for i, row in enumerate(chunk):
        # Create a dictionary for the row using the headers
        row_dict = dict(zip(headers, row))
        
        errors = []
        # Rule 1: 'Item' column must not be empty
        if not str(row_dict.get('Item', '')).strip():
            errors.append("Item name is required.")
        
        # Rule 2: 'Stock' must be a valid number if it exists
        stock_val = str(row_dict.get('Stock', '0')).strip()
        if stock_val:
            try:
                float(stock_val)
            except ValueError:
                errors.append("Stock must be a valid number.")

        validated_rows.append({
            '_id': i,  # This will be a local ID within the chunk, might need adjustment
            '_errors': errors,
            **row_dict
        })
    return validated_rows

@app.route('/api/import/preview-json', methods=['POST'])
@csrf.exempt  # ✅ We validate CSRF in JavaScript fetch headers
@login_required
@role_required('admin')
def import_preview_json():
    rows = request.get_json()
    if not rows:
        return jsonify({'error': 'No data received'}), 400

    try:
        validated_rows = []
        headers = list(rows[0].keys()) if rows else []

        for i, row_dict in enumerate(rows):
            errors = []
            if not str(row_dict.get('Item', '')).strip():
                errors.append("Item name is required.")
            
            stock_val = str(row_dict.get('Stock', '0')).strip()
            if stock_val:
                try:
                    float(stock_val)
                except ValueError:
                    errors.append("Stock must be a valid number.")
            
            validated_rows.append({'_id': i, '_errors': errors, **row_dict})

        return jsonify({'headers': headers, 'rows': validated_rows})

    except Exception as e:
        app.logger.error(f"JSON Preview error: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@app.route('/api/import/commit', methods=['POST'])
@csrf.exempt
@login_required
@role_required('admin')
@limiter.limit("5 per hour")
def import_commit():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON payload'}), 400

    mappings = data.get('mappings', {})
    import_data = data.get('data', [])

    if not mappings or not import_data:
        return jsonify({'error': 'Mappings and data are required'}), 400

    try:
        # Instead of creating a large DataFrame, we process the data row by row.
        processed = 0
        imported = 0
        
        with database.get_conn() as (conn, cur):
            for row_data in import_data:
                # Apply mappings to the current row
                mapped_row = {mappings.get(k, k): v for k, v in row_data.items()}

                # Basic cleaning and validation for each row
                item_name = str(mapped_row.get('Item', '')).strip()
                if not item_name:
                    continue  # Skip rows without an item name

                processed += 1
                
                model = str(mapped_row.get('Model', '')).strip()
                variation = str(mapped_row.get('Variation', '')).strip()
                description = str(mapped_row.get('Description', '')).strip()
                color = str(mapped_row.get('Color', '')).strip()
                size = str(mapped_row.get('Size', '')).strip()
                try:
                    stock = int(float(mapped_row.get('Stock', 0)))
                except (ValueError, TypeError):
                    stock = 0
                unit = str(mapped_row.get('Unit', 'Pcs')).strip()

                # Find or create the item_master using the new helper function
                item_id = get_or_create_item_master_id(cur, item_name, model, variation, description)

                # Find or create color and size, then insert/update the variant
                try:
                    cur.execute("SAVEPOINT variant_savepoint")
                    color_id = get_or_create_master_id(cur, color, 'color_master', 'color_id', 'color_name')
                    size_id = get_or_create_master_id(cur, size, 'size_master', 'size_id', 'size_name')
                    
                    cur.execute(
                        """
                        INSERT INTO item_variant(item_id,color_id,size_id,opening_stock,unit)
                        VALUES(%s,%s,%s,%s,%s)
                        ON CONFLICT(item_id,color_id,size_id)
                        DO UPDATE SET opening_stock = item_variant.opening_stock + EXCLUDED.opening_stock
                        """,
                        (item_id, color_id, size_id, stock, unit)
                    )
                    imported += 1
                    cur.execute("RELEASE SAVEPOINT variant_savepoint")
                except Exception:
                    cur.execute("ROLLBACK TO SAVEPOINT variant_savepoint")
                    app.logger.warning("Skipping invalid variant row during commit", exc_info=True)
            
            conn.commit()

        message = f"Import successful. Processed {processed} rows and imported {imported} variants."
        return jsonify({'message': message}), 200

    except Exception as e:
        app.logger.error(f"Commit error: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory/export/csv', methods=['GET'])
@login_required
def export_inventory_csv():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT
                    i.name as item_name,
                    mm.model_name,
                    vm.variation_name,
                    cm.color_name,
                    sm.size_name,
                    iv.opening_stock,
                    iv.threshold,
                    iv.unit
                FROM item_variant iv
                JOIN item_master i ON iv.item_id = i.item_id
                LEFT JOIN model_master mm ON i.model_id = mm.model_id
                LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
                JOIN color_master cm ON iv.color_id = cm.color_id
                JOIN size_master sm ON iv.size_id = sm.size_id
                ORDER BY item_name, model_name, variation_name, color_name, size_name
            """)
            inventory_data = cur.fetchall()

            def generate():
                data = StringIO()
                writer = csv.writer(data)
                
                # Write the header
                writer.writerow(['Item Name', 'Model', 'Variation', 'Color', 'Size', 'Stock', 'Threshold', 'Unit'])
                yield data.getvalue()
                data.seek(0)
                data.truncate(0)

                # Write the data rows
                for row in inventory_data:
                    writer.writerow([
                        row['item_name'],
                        row['model_name'],
                        row['variation_name'],
                        row['color_name'],
                        row['size_name'],
                        row['opening_stock'],
                        row['threshold'],
                        row['unit']
                    ])
                    yield data.getvalue()
                    data.seek(0)
                    data.truncate(0)

            response = Response(generate(), mimetype='text/csv')
            response.headers.set("Content-Disposition", "attachment", filename="inventory.csv")
            return response

    except Exception as e:
        app.logger.error(f"Error exporting inventory to CSV: {e}")
        return jsonify({'error': 'Failed to export inventory'}), 500
        
if __name__ == '__main__':
    with app.app_context():
        if not database.db_pool:
            app.logger.error("Application cannot start without a database connection.")
        else:
            app.run(debug=True, port=5000)
