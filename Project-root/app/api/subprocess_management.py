"""
Subprocess Management API for Universal Process Framework.

Provides REST API endpoints for subprocess template CRUD operations.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user

from app import limiter
from app.services.subprocess_service import SubprocessService

subprocess_api_bp = Blueprint('subprocess_api', __name__)


# ===== SUBPROCESS CRUD =====

@subprocess_api_bp.route('/subprocess', methods=['POST'])
@login_required
@limiter.limit("30 per hour")
def create_subprocess():
    """Create a new subprocess template."""
    try:
        data = request.json
        
        if not data.get('name'):
            return jsonify({'error': 'Subprocess name is required'}), 400
        
        subprocess = SubprocessService.create_subprocess(
            name=data['name'],
            description=data.get('description'),
            subprocess_type=data.get('type', 'assembly'),
            duration_minutes=data.get('duration_minutes'),
            user_id=current_user.id
        )
        
        current_app.logger.info(
            f"Subprocess created: {subprocess['id']} by user {current_user.id}"
        )
        return jsonify(subprocess), 201
        
    except Exception as e:
        current_app.logger.error(f"Error creating subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>', methods=['GET'])
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
@login_required
def update_subprocess(subprocess_id):
    """Update subprocess details."""
    try:
        data = request.json
        
        updated = SubprocessService.update_subprocess(
            subprocess_id,
            name=data.get('name'),
            description=data.get('description'),
            subprocess_type=data.get('type'),
            duration_minutes=data.get('duration_minutes')
        )
        
        if not updated:
            return jsonify({'error': 'Subprocess not found'}), 404
        
        current_app.logger.info(f"Subprocess updated: {subprocess_id}")
        return jsonify(updated), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@subprocess_api_bp.route('/subprocess/<int:subprocess_id>', methods=['DELETE'])
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
