import os
import uuid
from contextlib import contextmanager
from dotenv import load_dotenv
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
from psycopg2 import pool
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import logging
import pandas as pd

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'a-strong-default-secret-key-for-dev')
csrf = CSRFProtect(app)

logging.basicConfig(level=logging.INFO)
CORS(app, supports_credentials=True, origins=["http://127.0.0.1:5000"])

# --- Database Setup ---
try:
    db_pool = pool.SimpleConnectionPool(
        1, 10,
        host=os.environ.get('DB_HOST', '127.0.0.1'),
        database=os.environ.get('DB_NAME', 'MTC'),
        user=os.environ.get('DB_USER', 'postgres'),
        password=os.environ.get('DB_PASS')
    )
except psycopg2.OperationalError as e:
    app.logger.critical(f"FATAL: Could not connect to the database: {e}")
    db_pool = None

@contextmanager
def get_conn(cursor_factory=None, autocommit=False):
    if not db_pool: raise ConnectionError("Database pool is not available.")
    conn = None
    try:
        conn = db_pool.getconn()
        conn.autocommit = autocommit
        cur = conn.cursor(cursor_factory=cursor_factory)
        yield conn, cur
    except Exception as e:
        app.logger.error(f"Database transaction error: {e}")
        if conn: conn.rollback()
        raise
    finally:
        if conn: db_pool.putconn(conn)

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
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
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
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
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
    if isinstance(value, int) or str(value).isdigit():
        return int(value)
    
    cur.execute(f"SELECT {id_col} FROM {table_name} WHERE {name_col} = %s", (value,))
    row = cur.fetchone()
    if row:
        return row[0]
    
    cur.execute(f"INSERT INTO {table_name} ({name_col}) VALUES (%s) RETURNING {id_col}", (value,))
    new_id = cur.fetchone()[0]
    return new_id

# --- Main Page Routes ---
@app.route('/')
@login_required
def home():
    return redirect(url_for('inventory'))

@app.route('/inventory')
@login_required
def inventory():
    return render_template('inventory.html')

@app.route('/add_item')
@login_required
def add_item_page():
    return render_template('add_item.html')


@app.route('/user-management')
@login_required
@role_required('super_admin')
def user_management():
    return render_template('user_management.html')

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
            uploads_dir = os.path.join(app.root_path, 'static', 'uploads')
            os.makedirs(uploads_dir, exist_ok=True)
            safe_name = secure_filename(file.filename)
            filename = f"{current_user.id}_{uuid.uuid4().hex[:8]}_{safe_name}"
            file.save(os.path.join(uploads_dir, filename))
            profile_path = f"uploads/{filename}"

        try:
            with get_conn() as (conn, cur):
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

# --- Auth Routes ---
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('home'))
    
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        try:
            with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                cur.execute("SELECT * FROM users WHERE email = %s", (email,))
                user_row = cur.fetchone()
            
            if user_row and check_password_hash(user_row.get('password_hash') or '', password):
                user = load_user(user_row['user_id'])
                if user.role == 'pending_approval':
                    flash('Your account is pending approval by an administrator.', 'error')
                    return redirect(url_for('login'))
                login_user(user)
                return redirect(url_for('home'))
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
        try:
            with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
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
    
    return redirect(url_for('home'))

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(os.path.join(app.root_path, 'static', 'uploads'), filename)

# --- API Routes ---
def make_api_crud_routes(app, entity_name, table_name, id_col, name_col):
    plural_name = f"{entity_name}s"
    
    @app.route(f'/api/{plural_name}', methods=['GET'], endpoint=f'get_{plural_name}')
    @login_required
    def get_entities():
        with get_conn() as (conn, cur):
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
            with get_conn() as (conn, cur):
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
            with get_conn() as (conn, cur):
                cur.execute(f"UPDATE {table_name} SET {name_col} = %s WHERE {id_col} = %s", (name, item_id))
                conn.commit()
            return jsonify({'message': f'{entity_name.capitalize()} updated'}), 200
        except Exception as e:
            app.logger.error(f"API Error updating {entity_name} {item_id}: {e}")
            return jsonify({'error': 'Database error'}), 500

    @app.route(f'/api/{plural_name}/<int:item_id>', methods=['DELETE'], endpoint=f'delete_{entity_name}')
    @login_required
    @role_required('admin')
    def delete_entity(item_id):
        try:
            with get_conn() as (conn, cur):
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

@app.route('/api/item-names', methods=['GET'])
@login_required
def get_item_names():
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT DISTINCT name FROM item_master ORDER BY name")
            names = [row[0] for row in cur.fetchall()]
        return jsonify(names)
    except Exception as e:
        app.logger.error(f"Error fetching item names: {e}")
        return jsonify({'error': 'Failed to fetch item names'}), 500

@app.route('/api/models', methods=['GET'])
@login_required
def get_models():
    item_name = request.args.get('item_name')
    if not item_name:
        return jsonify([])
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT DISTINCT model FROM item_master WHERE name = %s ORDER BY model", (item_name,))
            models = [row[0] for row in cur.fetchall() if row[0]]
        return jsonify(models)
    except Exception as e:
        app.logger.error(f"Error fetching models for item {item_name}: {e}")
        return jsonify({'error': 'Failed to fetch models'}), 500

@app.route('/api/variations', methods=['GET'])
@login_required
def get_variations():
    item_name = request.args.get('item_name')
    model = request.args.get('model')
    if not item_name or not model:
        return jsonify([])
    try:
        with get_conn() as (conn, cur):
            cur.execute("SELECT DISTINCT variation FROM item_master WHERE name = %s AND model = %s ORDER BY variation", (item_name, model))
            variations = [row[0] for row in cur.fetchall() if row[0]]
        return jsonify(variations)
    except Exception as e:
        app.logger.error(f"Error fetching variations for item {item_name} and model {model}: {e}")
        return jsonify({'error': 'Failed to fetch variations'}), 500

@app.route('/api/items', methods=['GET'])
@login_required
def get_items():
    try:
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT 
                    i.item_id, i.name, i.model, i.variation, i.description, i.image_path,
                    (SELECT COUNT(*) FROM item_variant v WHERE v.item_id = i.item_id) as variant_count,
                    (SELECT COALESCE(SUM(v.opening_stock), 0) FROM item_variant v WHERE v.item_id = i.item_id) as total_stock,
                    (SELECT COALESCE(SUM(v.threshold), 0) FROM item_variant v WHERE v.item_id = i.item_id) as total_threshold,
                    EXISTS (
                        SELECT 1 FROM item_variant v_check 
                        WHERE v_check.item_id = i.item_id AND v_check.opening_stock <= v_check.threshold
                    ) as has_low_stock_variants
                FROM item_master i
                ORDER BY i.name
            """)
            items = cur.fetchall()
            return jsonify([{
                'id': item['item_id'], 'name': item['name'], 'model': item['model'],
                'variation': item['variation'], 'description': item['description'],
                'image_path': item['image_path'],
                'threshold': int(item['total_threshold'] or 0),
                'variant_count': item['variant_count'], 
                'total_stock': int(item['total_stock'] or 0),
                'has_low_stock_variants': item['has_low_stock_variants']
            } for item in items])
    except Exception as e:
        app.logger.error(f"Error fetching items: {e}")
        return jsonify({'error': 'Failed to fetch items'}), 500

@app.route('/api/items', methods=['POST'])
@login_required
def add_item():
    data = request.form.to_dict()
    if not data.get('name') or 'variants' not in data:
        return jsonify({'error': 'Name and variants are required'}), 400
    
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
        with get_conn() as (conn, cur):
            cur.execute(
                "INSERT INTO item_master (name, model, variation, description, image_path) VALUES (%s, %s, %s, %s, %s) RETURNING item_id",
                (data['name'], data.get('model'), data.get('variation'), data.get('description'), image_path)
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
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM item_master WHERE item_id = %s", (item_id,))
            item = cur.fetchone()
            if not item: return jsonify({'error': 'Item not found'}), 404
            return jsonify(dict(item))
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
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT * FROM item_master WHERE name = %s", (item_name,))
            item = cur.fetchone()
            if not item:
                return jsonify(None)
            return jsonify(dict(item))
    except Exception as e:
        app.logger.error(f"Error fetching item by name '{item_name}': {e}")
        return jsonify({'error': 'Failed to fetch item by name'}), 500
        
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
        with get_conn() as (conn, cur):
            if image_path:
                cur.execute(
                    "UPDATE item_master SET name=%s, model=%s, variation=%s, description=%s, image_path=%s WHERE item_id=%s",
                    (data['name'], data.get('model'), data.get('variation'), data.get('description'), image_path, item_id)
                )
            else:
                cur.execute(
                    "UPDATE item_master SET name=%s, model=%s, variation=%s, description=%s WHERE item_id=%s",
                    (data['name'], data.get('model'), data.get('variation'), data.get('description'), item_id)
                )
            
            client_variants = json.loads(data['variants'])
            client_variant_ids = {v['id'] for v in client_variants if 'id' in v and v['id']}

            if client_variant_ids:
                cur.execute("DELETE FROM item_variant WHERE item_id = %s AND variant_id NOT IN %s", (item_id, tuple(client_variant_ids)))
            else:
                 cur.execute("DELETE FROM item_variant WHERE item_id = %s", (item_id,))

            for v in client_variants:
                color_id = get_or_create_master_id(cur, v['color'], 'color_master', 'color_id', 'color_name')
                size_id = get_or_create_master_id(cur, v['size'], 'size_master', 'size_id', 'size_name')
                if 'id' in v and v['id']:
                    cur.execute(
                        "UPDATE item_variant SET color_id=%s, size_id=%s, opening_stock=%s, threshold=%s, unit=%s WHERE variant_id=%s",
                        (color_id, size_id, v.get('opening_stock', 0), v.get('threshold', 5), v.get('unit'), v['id'])
                    )
                else:
                    cur.execute(
                        "INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit) VALUES (%s, %s, %s, %s, %s, %s)",
                        (item_id, color_id, size_id, v.get('opening_stock', 0), v.get('threshold', 5), v.get('unit'))
                    )
            conn.commit()
        return jsonify({'message': 'Item updated successfully'}), 200
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
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
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

@app.route('/api/items/<int:item_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_item(item_id):
    try:
        with get_conn() as (conn, cur):
            cur.execute("DELETE FROM item_master WHERE item_id = %s", (item_id,))
            conn.commit()
        return '', 204
    except Exception as e:
        app.logger.error(f"Error deleting item {item_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/variants/<int:variant_id>/stock', methods=['PUT'])
@login_required
def update_variant_stock(variant_id):
    data = request.json
    new_stock = data.get('stock')
    if new_stock is None or not str(new_stock).isdigit():
        return jsonify({'error': 'A valid, non-negative stock number is required.'}), 400
    
    try:
        with get_conn() as (conn, cur):
            # --- CHANGE 1: Get more data back from the initial update ---
            # We ask the database to return the new stock and threshold along with the item_id.
            cur.execute(
                """
                UPDATE item_variant 
                SET opening_stock = %s 
                WHERE variant_id = %s 
                RETURNING item_id, opening_stock, threshold
                """,
                (int(new_stock), variant_id)
            )
            
            # --- CHANGE 2: Unpack the new values from the result ---
            updated_row = cur.fetchone()
            if not updated_row:
                return jsonify({'error': 'Variant not found'}), 404
            
            item_id, updated_stock, threshold = updated_row

            # --- CHANGE 3: Create the new dictionary for the frontend ---
            updated_variant_data = {
                "stock": updated_stock,
                "is_low_stock": updated_stock <= threshold
            }

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
            
            # --- CHANGE 4: Add the new dictionary to the final JSON response ---
            return jsonify({
                'message': 'Stock updated successfully', 
                'new_total_stock': int(total_stock or 0),
                'has_low_stock_variants': item_has_low_stock, # Renamed this key to match the frontend JS
                'updated_variant': updated_variant_data      # This is the new part
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
        with get_conn() as (conn, cur):
            cur.execute(
                "UPDATE item_variant SET threshold = %s WHERE variant_id = %s",
                (int(new_threshold), variant_id)
            )
            conn.commit()
        return jsonify({'message': 'Threshold updated successfully'}), 200
    except Exception as e:
        app.logger.error(f"Error updating threshold for variant {variant_id}: {e}")
        return jsonify({'error': 'Database error'}), 500

@app.route('/api/users', methods=['GET'])
@login_required
@role_required('super_admin')
def get_users():
    try:
        with get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
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
        with get_conn() as (conn, cur):
            cur.execute("UPDATE users SET role = %s WHERE user_id = %s", (new_role, user_id))
            conn.commit()
        return jsonify({'message': 'User role updated successfully.'})
    except Exception as e:
        app.logger.error(f"Error updating role for user {user_id}: {e}")
        return jsonify({'error': 'Failed to update user role.'}), 500

@app.route('/api/import/preview', methods=['POST'])
@login_required
@role_required('admin')
def import_preview():
    if 'file' not in request.files:
        return jsonify({'error':'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error':'No selected file'}), 400
    try:
        df = (pd.read_csv(file) if file.filename.endswith('.csv')
              else pd.read_excel(file) if file.filename.lower().endswith(('.xls','xlsx'))
              else None)
        if df is None:
            return jsonify({'error':'Unsupported file format'}), 400

        df.fillna('', inplace=True)
        headers = df.columns.tolist()
        preview_data = df.head(20).to_dict(orient='records')

        with get_conn() as (conn, cur):
            cur.execute("SELECT size_name FROM size_master")
            db_sizes = {r[0].lower() for r in cur.fetchall()}

        size_cols = [h for h in headers if h.lower() in db_sizes]
        detected_fmt = 'wide' if len(size_cols)>2 else 'long'
        app.logger.info(f"Detected {detected_fmt} with sizes {size_cols}")

        return jsonify({
            'headers': headers,
            'preview_data': preview_data,
            'format': detected_fmt,
            'size_columns': size_cols
        })
    except Exception as e:
        app.logger.error(f"Preview error: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@app.route('/api/import/commit', methods=['POST'])
@login_required
@role_required('admin')
def import_commit():
    data = request.get_json(force=True)
    mappings = data.get('mappings', {})
    import_data = data.get('data', [])
    if not mappings or not import_data:
        return jsonify({'error': 'Mappings and data required'}), 400

    try:
        df = pd.DataFrame(import_data)

        # Detect wide format by checking if multiple source columns map to 'Stock'
        stock_source_cols = [src for src, dst in mappings.items() if dst == 'Stock']
        
        if len(stock_source_cols) > 1:  # Wide format detected
            # Identify columns that are NOT stock or ignored, these are the identifiers
            id_vars_source_cols = [src for src, dst in mappings.items() if dst and dst not in ('Stock', 'Ignore')]
            
            # Melt the DataFrame to turn size columns into rows
            df = df.melt(
                id_vars=id_vars_source_cols,
                value_vars=stock_source_cols,
                var_name='Size',  # The new 'Size' column will get its values from the old column headers
                value_name='Stock' # The new 'Stock' column will get its values from the old cell values
            )
            
            # Create a map to rename the identifier columns to their final names
            final_rename_map = {src: dst for src, dst in mappings.items() if src in id_vars_source_cols}
            df.rename(columns=final_rename_map, inplace=True)

        else:  # Long format
            df.rename(columns=mappings, inplace=True)

        # Ensure all required columns exist, filling missing ones with blanks
        for col in ['Item', 'Model', 'Variation', 'Description', 'Color', 'Size', 'Stock', 'Unit']:
            if col not in df.columns:
                df[col] = ''

        # Clean data: drop rows without essential info and convert stock to a number
        df.dropna(subset=['Item', 'Color', 'Size', 'Stock'], inplace=True)
        df['Stock'] = pd.to_numeric(df['Stock'], errors='coerce').fillna(0).astype(int)

        processed = len(df)
        if processed == 0:
            return jsonify({'message': 'No valid rows after cleaning'}), 200

        imported = 0
        with get_conn() as (conn, cur):
            # Group by the main item to handle variants efficiently
            grouping = [c for c in ['Item', 'Model', 'Variation'] if c in df.columns]
            for key, group in df.groupby(grouping):
                keys = key if isinstance(key, tuple) else (key,)
                vals = dict(zip(grouping, keys))

                # Find existing item_master or create a new one
                cur.execute(
                    "SELECT item_id FROM item_master WHERE name=%s AND COALESCE(model,'')=%s AND COALESCE(variation,'')=%s",
                    (vals['Item'], vals.get('Model', ''), vals.get('Variation', ''))
                )
                row = cur.fetchone()
                if row:
                    item_id = row[0]
                else:
                    cur.execute(
                        "INSERT INTO item_master(name,model,variation,description) VALUES(%s,%s,%s,%s) RETURNING item_id",
                        (vals['Item'], vals.get('Model'), vals.get('Variation'), group['Description'].iloc[0])
                    )
                    item_id = cur.fetchone()[0]

                # Loop through variants in the group to insert or update them
                for _, r in group.iterrows():
                    try:
                        color_id = get_or_create_master_id(cur, r['Color'], 'color_master', 'color_id', 'color_name')
                        size_id = get_or_create_master_id(cur, r['Size'], 'size_master', 'size_id', 'size_name')
                        
                        # This query adds stock if the variant exists, or creates it if it's new
                        cur.execute(
                            """
                            INSERT INTO item_variant(item_id,color_id,size_id,opening_stock,unit)
                            VALUES(%s,%s,%s,%s,%s)
                            ON CONFLICT(item_id,color_id,size_id)
                            DO UPDATE SET opening_stock = item_variant.opening_stock + EXCLUDED.opening_stock
                            """,
                            (item_id, color_id, size_id, r['Stock'], r.get('Unit', 'Pcs'))
                        )
                        imported += 1
                    except Exception:
                        app.logger.warning("Skipping invalid variant row", exc_info=True)
            conn.commit()

        message = f"Import successful. Processed {processed} rows and imported {imported} variants."
        return jsonify({'message': message}), 200

    except Exception as e:
        app.logger.error(f"Commit error: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

        
if __name__ == '__main__':
    if not db_pool:
        app.logger.error("Application cannot start without a database connection.")
    else:
        app.run(debug=True, port=5000)
