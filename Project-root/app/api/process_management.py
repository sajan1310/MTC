"""
Process Management API for Universal Process Framework.

Provides REST API endpoints for process CRUD operations, subprocess management,
and process structure manipulation.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from functools import wraps

from app import limiter
from app.services.process_service import ProcessService
from app.services.subprocess_service import SubprocessService
from app.services.costing_service import CostingService

process_api_bp = Blueprint('process_api', __name__)


def role_required(*roles):
    """Decorator to require specific user role."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return jsonify({'error': 'Authentication required'}), 401
            if current_user.role not in roles and current_user.role != 'admin':
                return jsonify({'error': 'Insufficient permissions'}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator


# ===== PROCESS CRUD OPERATIONS =====

@process_api_bp.route('/process', methods=['POST'])
@login_required
@limiter.limit("20 per hour")
def create_process():
    """Create a new process."""
    try:
        data = request.json
        
        if not data.get('name'):
            return jsonify({'error': 'Process name is required'}), 400
        
        process = ProcessService.create_process(
            name=data['name'],
            user_id=current_user.id,
            description=data.get('description'),
            process_class=data.get('class', 'assembly')
        )
        
        current_app.logger.info(f"Process created: {process['id']} by user {current_user.id}")
        return jsonify(process), 201
        
    except Exception as e:
        current_app.logger.error(f"Error creating process: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>', methods=['GET'])
@login_required
def get_process(process_id):
    """Get process with full structure."""
    try:
        process = ProcessService.get_process_full_structure(process_id)
        
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        # Check user access
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        return jsonify(process), 200
        
    except Exception as e:
        current_app.logger.error(f"Error retrieving process {process_id}: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/processes/<int:process_id>/structure', methods=['GET'])
@login_required
def get_process_structure(process_id):
    """Get process structure (alias to get_process for frontend compatibility)."""
    return get_process(process_id)


@process_api_bp.route('/processes', methods=['GET'])
@login_required
def list_processes():
    """List processes with pagination and filtering."""
    try:
        page = int(request.args.get('page', 1))
        per_page = min(int(request.args.get('per_page', 25)), 100)  # Max 100
        status = request.args.get('status')
        
        result = ProcessService.list_processes(
            user_id=current_user.id if current_user.role != 'admin' else None,
            status=status,
            page=page,
            per_page=per_page
        )
        
        return jsonify(result), 200
        
    except Exception as e:
        current_app.logger.error(f"Error listing processes: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>', methods=['PUT'])
@login_required
def update_process(process_id):
    """Update process details."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        data = request.json
        updated = ProcessService.update_process(
            process_id,
            name=data.get('name'),
            description=data.get('description'),
            process_class=data.get('class'),
            status=data.get('status')
        )
        
        if not updated:
            return jsonify({'error': 'Update failed'}), 400
        
        current_app.logger.info(f"Process updated: {process_id} by user {current_user.id}")
        return jsonify(updated), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating process {process_id}: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>', methods=['DELETE'])
@login_required
def delete_process(process_id):
    """Soft delete a process."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        success = ProcessService.delete_process(process_id, hard_delete=False)
        
        if not success:
            return jsonify({'error': 'Delete failed'}), 400
        
        current_app.logger.info(f"Process deleted: {process_id} by user {current_user.id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error deleting process {process_id}: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>/restore', methods=['POST'])
@login_required
def restore_process(process_id):
    """Restore a soft-deleted process."""
    try:
        success = ProcessService.restore_process(process_id)
        
        if not success:
            return jsonify({'error': 'Process not found or already active'}), 404
        
        current_app.logger.info(f"Process restored: {process_id} by user {current_user.id}")
        return jsonify({'message': 'Process restored successfully'}), 200
        
    except Exception as e:
        current_app.logger.error(f"Error restoring process {process_id}: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/search', methods=['GET'])
@login_required
def search_processes():
    """Search processes by name or description."""
    try:
        query = request.args.get('q', '')
        
        if len(query) < 2:
            return jsonify({'error': 'Search query must be at least 2 characters'}), 400
        
        results = ProcessService.search_processes(query, current_user.id)
        return jsonify(results), 200
        
    except Exception as e:
        current_app.logger.error(f"Error searching processes: {e}")
        return jsonify({'error': str(e)}), 500


# ===== SUBPROCESS MANAGEMENT =====

@process_api_bp.route('/process/<int:process_id>/add_subprocess', methods=['POST'])
@login_required
def add_subprocess_to_process(process_id):
    """Add a subprocess to a process."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        data = request.json
        
        if not data.get('subprocess_id'):
            return jsonify({'error': 'subprocess_id is required'}), 400
        
        if not data.get('sequence_order'):
            return jsonify({'error': 'sequence_order is required'}), 400
        
        association = ProcessService.add_subprocess_to_process(
            process_id=process_id,
            subprocess_id=data['subprocess_id'],
            sequence_order=data['sequence_order'],
            custom_name=data.get('custom_name'),
            notes=data.get('notes')
        )
        
        current_app.logger.info(
            f"Subprocess {data['subprocess_id']} added to process {process_id}"
        )
        return jsonify(association), 201
        
    except Exception as e:
        current_app.logger.error(f"Error adding subprocess to process: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process_subprocess/<int:ps_id>', methods=['DELETE'])
@login_required
def remove_subprocess_from_process(ps_id):
    """Remove a subprocess from a process."""
    try:
        success = ProcessService.remove_subprocess_from_process(ps_id)
        
        if not success:
            return jsonify({'error': 'Association not found'}), 404
        
        current_app.logger.info(f"Subprocess removed from process: {ps_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error removing subprocess: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>/reorder_subprocesses', methods=['POST'])
@login_required
def reorder_subprocesses(process_id):
    """Reorder subprocesses (drag-and-drop support)."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        data = request.json
        sequence_map = data.get('sequence_map', {})
        
        if not sequence_map:
            return jsonify({'error': 'sequence_map is required'}), 400
        
        # Convert string keys to int
        sequence_map = {int(k): v for k, v in sequence_map.items()}
        
        success = ProcessService.reorder_subprocesses(process_id, sequence_map)
        
        if not success:
            return jsonify({'error': 'Reorder failed'}), 400
        
        return jsonify({'message': 'Subprocesses reordered successfully'}), 200
        
    except Exception as e:
        current_app.logger.error(f"Error reordering subprocesses: {e}")
        return jsonify({'error': str(e)}), 500


# ===== COSTING OPERATIONS =====

@process_api_bp.route('/process/<int:process_id>/worst_case_costing', methods=['GET'])
@login_required
def get_worst_case_costing(process_id):
    """Get complete worst-case cost breakdown for a process."""
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        cost_breakdown = CostingService.calculate_process_total_cost(process_id)
        return jsonify(cost_breakdown), 200
        
    except Exception as e:
        current_app.logger.error(f"Error calculating worst-case costing: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>/profitability', methods=['GET'])
@login_required
def get_profitability(process_id):
    """Get profitability metrics for a process."""
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        profitability = CostingService.update_profitability(process_id)
        return jsonify(profitability), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting profitability: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>/set_sales_price', methods=['POST'])
@login_required
def set_sales_price(process_id):
    """Set estimated sales price and recalculate profitability."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        data = request.json
        sales_price = data.get('sales_price')
        
        if sales_price is None:
            return jsonify({'error': 'sales_price is required'}), 400
        
        try:
            sales_price = float(sales_price)
        except ValueError:
            return jsonify({'error': 'sales_price must be a number'}), 400
        
        profitability = CostingService.update_profitability(process_id, sales_price)
        
        current_app.logger.info(
            f"Sales price set for process {process_id}: {sales_price}"
        )
        return jsonify(profitability), 200
        
    except Exception as e:
        current_app.logger.error(f"Error setting sales price: {e}")
        return jsonify({'error': str(e)}), 500


@process_api_bp.route('/process/<int:process_id>/recalculate_worst_case', methods=['POST'])
@login_required
def recalculate_worst_case(process_id):
    """Recalculate worst-case costing and profitability."""
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return jsonify({'error': 'Process not found'}), 404
        
        if process['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        # Recalculate costs
        cost_breakdown = CostingService.calculate_process_total_cost(process_id)
        
        # Update profitability
        profitability = CostingService.update_profitability(process_id)
        
        return jsonify({
            'cost_breakdown': cost_breakdown,
            'profitability': profitability
        }), 200
        
    except Exception as e:
        current_app.logger.error(f"Error recalculating costs: {e}")
        return jsonify({'error': str(e)}), 500


# Error handlers
@process_api_bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Resource not found'}), 404


@process_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500
