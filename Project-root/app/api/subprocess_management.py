"""
Subprocess Management API for Universal Process Framework.

Provides REST API endpoints for subprocess template CRUD operations.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
import psycopg2.errors

from app import limiter
from app.services.subprocess_service import SubprocessService

subprocess_api_bp = Blueprint('subprocess_api', __name__)


@subprocess_api_bp.before_request
def log_request_info():
    """Log incoming request details for debugging."""
    current_app.logger.debug(f"[SUBPROCESS API] {request.method} {request.path}")
    current_app.logger.debug(f"[SUBPROCESS API] Headers: {dict(request.headers)}")
    if request.method in ['POST', 'PUT', 'PATCH']:
        current_app.logger.debug(f"[SUBPROCESS API] Content-Type: {request.content_type}")
        current_app.logger.debug(f"[SUBPROCESS API] Content-Length: {request.content_length}")


# ===== SUBPROCESS CRUD =====

@subprocess_api_bp.route('/subprocess', methods=['POST'])
@subprocess_api_bp.route('/subprocesses', methods=['POST'])
@login_required
@limiter.limit("30 per hour")
def create_subprocess():
    """Create a new subprocess template."""
    try:
        # Log request details for debugging
        current_app.logger.info(f"[CREATE SUBPROCESS] Received request from user {current_user.id}")
        
        # Validate Content-Type
        if not request.is_json:
            current_app.logger.warning(f"[CREATE SUBPROCESS] Invalid Content-Type: {request.content_type}")
            return jsonify({
                'error': 'Invalid Content-Type',
                'details': f'Expected application/json but received {request.content_type}'
            }), 400
        
        # Parse JSON with error handling
        data = request.get_json(silent=True)
        
        if data is None:
            current_app.logger.error("[CREATE SUBPROCESS] Failed to parse JSON request body")
            return jsonify({
                'error': 'Invalid JSON',
                'details': 'Request body must be valid JSON. Check for syntax errors, trailing commas, or improper quotes.'
            }), 400
        
        current_app.logger.debug(f"[CREATE SUBPROCESS] Parsed data: {data}")
        
        # Validate required fields
        if not data.get('name'):
            current_app.logger.warning("[CREATE SUBPROCESS] Missing required field: name")
            return jsonify({
                'error': 'Validation error',
                'details': 'Subprocess name is required'
            }), 400
        
        # Validate name is not empty or just whitespace
        if not data['name'].strip():
            current_app.logger.warning("[CREATE SUBPROCESS] Empty subprocess name")
            return jsonify({
                'error': 'Validation error',
                'details': 'Subprocess name cannot be empty'
            }), 400
        
        # Validate category if provided
        category = data.get('category')
        if category and not category.strip():
            category = None
        
        subprocess = SubprocessService.create_subprocess(
            name=data['name'].strip(),
            description=data.get('description'),
            category=category,
            estimated_time_minutes=int(data.get('estimated_time_minutes', 0)),
            labor_cost=float(data.get('labor_cost', 0.00))
        )
        
        current_app.logger.info(
            f"[CREATE SUBPROCESS] Subprocess created successfully: {subprocess['id']} by user {current_user.id}"
        )
        return jsonify(subprocess), 201
        
    except psycopg2.errors.UniqueViolation as e:
        current_app.logger.warning(f"[CREATE SUBPROCESS] Duplicate subprocess name: {data.get('name')}")
        return jsonify({
            'error': 'Duplicate subprocess name',
            'details': f"A subprocess with the name '{data.get('name')}' already exists. Please choose a different name."
        }), 409
    except KeyError as e:
        current_app.logger.error(f"[CREATE SUBPROCESS] Missing key: {e}")
        return jsonify({
            'error': 'Validation error',
            'details': f'Missing required field: {str(e)}'
        }), 400
    except ValueError as e:
        current_app.logger.error(f"[CREATE SUBPROCESS] Invalid value: {e}")
        return jsonify({
            'error': 'Validation error',
            'details': str(e)
        }), 400
    except Exception as e:
        current_app.logger.error(f"[CREATE SUBPROCESS] Unexpected error: {e}", exc_info=True)
        return jsonify({
            'error': 'Internal server error',
            'details': str(e) if current_app.debug else 'An unexpected error occurred'
        }), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>', methods=['GET'])
@subprocess_api_bp.route('/subprocesses/<int:subprocess_id>', methods=['GET'])
@login_required
def get_subprocess(subprocess_id):
    """Get subprocess with full details."""
    try:
        subprocess = SubprocessService.get_subprocess(subprocess_id)
        
        if not subprocess:
            return jsonify({'error': 'Subprocess not found'}), 404
        
        return jsonify(subprocess), 200
        
    except Exception as e:
        current_app.logger.error(f"Error retrieving subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocesses', methods=['GET'])
@login_required
def list_subprocesses():
    """List subprocesses with pagination."""
    try:
        page = int(request.args.get('page', 1))
        per_page = min(int(request.args.get('per_page', 25)), 100)
        subprocess_type = request.args.get('type')
        
        result = SubprocessService.list_subprocesses(
            subprocess_type=subprocess_type,
            page=page,
            per_page=per_page
        )
        
        return jsonify(result), 200
        
    except Exception as e:
        current_app.logger.error(f"Error listing subprocesses: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>', methods=['PUT'])
@subprocess_api_bp.route('/subprocesses/<int:subprocess_id>', methods=['PUT'])
@login_required
def update_subprocess(subprocess_id):
    """Update subprocess details."""
    try:
        # Validate Content-Type
        if not request.is_json:
            return jsonify({
                'error': 'Invalid Content-Type',
                'details': f'Expected application/json but received {request.content_type}'
            }), 400
        
        data = request.get_json(silent=True)
        
        if data is None:
            return jsonify({
                'error': 'Invalid JSON',
                'details': 'Request body must be valid JSON'
            }), 400
        
        updated = SubprocessService.update_subprocess(
            subprocess_id,
            name=data.get('name'),
            description=data.get('description'),
            category=data.get('category'),
            estimated_time_minutes=int(data.get('estimated_time_minutes')) if data.get('estimated_time_minutes') is not None else None,
            labor_cost=float(data.get('labor_cost')) if data.get('labor_cost') is not None else None
        )
        
        if not updated:
            return jsonify({'error': 'Subprocess not found'}), 404
        
        current_app.logger.info(f"Subprocess updated: {subprocess_id}")
        return jsonify(updated), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>', methods=['DELETE'])
@subprocess_api_bp.route('/subprocesses/<int:subprocess_id>', methods=['DELETE'])
@login_required
def delete_subprocess(subprocess_id):
    """Soft delete subprocess."""
    try:
        success = SubprocessService.delete_subprocess(subprocess_id)
        
        if not success:
            return jsonify({'error': 'Subprocess not found'}), 404
        
        current_app.logger.info(f"Subprocess deleted: {subprocess_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error deleting subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>/duplicate', methods=['POST'])
@login_required
def duplicate_subprocess(subprocess_id):
    """Duplicate subprocess with all variants and costs."""
    try:
        data = request.json
        new_name = data.get('new_name')
        
        if not new_name:
            return jsonify({'error': 'new_name is required'}), 400
        
        duplicated = SubprocessService.duplicate_subprocess(subprocess_id, new_name)
        
        if not duplicated:
            return jsonify({'error': 'Subprocess not found'}), 404
        
        current_app.logger.info(
            f"Subprocess duplicated: {subprocess_id} -> {duplicated['id']}"
        )
        return jsonify(duplicated), 201
        
    except Exception as e:
        current_app.logger.error(f"Error duplicating subprocess: {e}")
        return jsonify({'error': str(e)}), 500


# ===== SUBPROCESS SEARCH =====

@subprocess_api_bp.route('/subprocess/search', methods=['GET'])
@login_required
def search_subprocesses():
    """Search subprocesses by name/description."""
    try:
        query = request.args.get('q', '')
        subprocess_type = request.args.get('type')
        limit = min(int(request.args.get('limit', 50)), 100)
        
        if len(query) < 2:
            return jsonify({'error': 'Search query must be at least 2 characters'}), 400
        
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        type_filter = ""
        params = [f"%{query}%", f"%{query}%"]
        
        if subprocess_type:
            type_filter = "AND type = %s"
            params.append(subprocess_type)
        
        params.append(limit)
        
        cur.execute(f"""
            SELECT 
                id, name, description, type, duration_minutes,
                created_at, updated_at
            FROM subprocesses
            WHERE deleted_at IS NULL
                AND (name ILIKE %s OR description ILIKE %s)
                {type_filter}
            ORDER BY name
            LIMIT %s
        """, params)
        
        results = cur.fetchall()
        cur.close()
        
        return jsonify([dict(row) for row in results]), 200
        
    except Exception as e:
        current_app.logger.error(f"Error searching subprocesses: {e}")
        return jsonify({'error': str(e)}), 500


# Error handlers
@subprocess_api_bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Resource not found'}), 404


@subprocess_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500
