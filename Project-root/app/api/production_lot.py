"""
Production Lot API for Universal Process Framework.

Provides REST API endpoints for production lot lifecycle: creation, variant selection,
validation, execution, and variance analysis.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from functools import wraps

from app import limiter
from app.services.production_service import ProductionService

production_api_bp = Blueprint('production_api', __name__)


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


# ===== PRODUCTION LOT CRUD =====

@production_api_bp.route('/production_lot', methods=['POST'])
@login_required
@limiter.limit("50 per hour")
def create_production_lot():
    """Create a new production lot."""
    try:
        data = request.json
        
        if not data.get('process_id'):
            return jsonify({'error': 'process_id is required'}), 400
        if not data.get('quantity'):
            return jsonify({'error': 'quantity is required'}), 400
        
        lot = ProductionService.create_production_lot(
            process_id=data['process_id'],
            quantity=data['quantity'],
            user_id=current_user.id,
            notes=data.get('notes')
        )
        
        current_app.logger.info(
            f"Production lot created: {lot['lot_number']} by user {current_user.id}"
        )
        return jsonify(lot), 201
        
    except Exception as e:
        current_app.logger.error(f"Error creating production lot: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>', methods=['GET'])
@login_required
def get_production_lot(lot_id):
    """Get production lot with full details."""
    try:
        lot = ProductionService.get_production_lot(lot_id)
        
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        # Check access
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        return jsonify(lot), 200
        
    except Exception as e:
        current_app.logger.error(f"Error retrieving production lot: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/variant_options', methods=['GET'])
@login_required
def get_variant_options(lot_id):
    """Get variant selection options for production lot."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        with get_conn() as (conn, cur):
            cur = conn.cursor(cursor_factory=RealDictCursor)
            
            # Get process structure with subprocesses and variants
            cur.execute("""
                SELECT 
                    ps.id as process_subprocess_id,
                    ps.sequence_order,
                    s.id as subprocess_id,
                    s.name as subprocess_name,
                    ps.custom_name
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.process_id = %s 
                  AND ps.deleted_at IS NULL
                  AND s.deleted_at IS NULL
                ORDER BY ps.sequence_order
            """, (lot['process_id'],))
            
            subprocesses = cur.fetchall()
            
            result = []
            for sp in subprocesses:
                # Get all variants for this subprocess
                cur.execute("""
                    SELECT 
                        vu.id as usage_id,
                        vu.item_id,
                        vu.quantity,
                        vu.unit,
                        vu.substitute_group_id,
                        vu.is_alternative,
                        vu.alternative_order,
                        iv.item_number,
                        iv.description,
                        iv.opening_stock,
                        iv.unit_price
                    FROM variant_usage vu
                    JOIN item_variant iv ON iv.item_id = vu.item_id
                    WHERE vu.process_subprocess_id = %s
                      AND vu.deleted_at IS NULL
                    ORDER BY vu.substitute_group_id NULLS FIRST, vu.alternative_order NULLS LAST
                """, (sp['process_subprocess_id'],))
                
                variants = cur.fetchall()
                
                # Get OR groups for this subprocess
                cur.execute("""
                    SELECT DISTINCT
                        og.id as group_id,
                        og.name as group_name,
                        og.description
                    FROM or_groups og
                    WHERE og.process_subprocess_id = %s
                    ORDER BY og.id
                """, (sp['process_subprocess_id'],))
                
                or_groups = cur.fetchall()
                
                # Organize variants by OR group
                grouped_variants = {}
                standalone_variants = []
                
                for v in variants:
                    variant_data = dict(v)
                    if v['substitute_group_id']:
                        if v['substitute_group_id'] not in grouped_variants:
                            grouped_variants[v['substitute_group_id']] = []
                        grouped_variants[v['substitute_group_id']].append(variant_data)
                    else:
                        standalone_variants.append(variant_data)
                
                result.append({
                    'process_subprocess_id': sp['process_subprocess_id'],
                    'subprocess_id': sp['subprocess_id'],
                    'subprocess_name': sp['custom_name'] or sp['subprocess_name'],
                    'sequence_order': sp['sequence_order'],
                    'or_groups': [dict(g) for g in or_groups],
                    'grouped_variants': grouped_variants,
                    'standalone_variants': standalone_variants
                })
            
            return jsonify({
                'lot_id': lot_id,
                'lot_number': lot['lot_number'],
                'process_name': lot['process_name'],
                'quantity': lot['quantity'],
                'subprocesses': result
            }), 200
            
    except Exception as e:
        current_app.logger.error(f"Error getting variant options: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lots', methods=['GET'])
@login_required
def list_production_lots():
    """List production lots with pagination."""
    try:
        page = int(request.args.get('page', 1))
        per_page = min(int(request.args.get('per_page', 25)), 100)
        status = request.args.get('status')
        process_id = request.args.get('process_id')
        
        result = ProductionService.list_production_lots(
            user_id=current_user.id if current_user.role != 'admin' else None,
            status=status,
            process_id=int(process_id) if process_id else None,
            page=page,
            per_page=per_page
        )
        
        return jsonify(result), 200
        
    except Exception as e:
        current_app.logger.error(f"Error listing production lots: {e}")
        return jsonify({'error': str(e)}), 500


# ===== VARIANT SELECTION (OR FEATURE) =====

@production_api_bp.route('/production_lot/<int:lot_id>/select_variant', methods=['POST'])
@login_required
def select_variant_for_group(lot_id):
    """Select variant from substitute group (OR feature)."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        if lot['status'] != 'planning':
            return jsonify({'error': 'Lot must be in planning status'}), 400
        
        data = request.json
        
        if not data.get('substitute_group_id'):
            return jsonify({'error': 'substitute_group_id is required'}), 400
        if not data.get('selected_variant_id'):
            return jsonify({'error': 'selected_variant_id is required'}), 400
        
        selection = ProductionService.select_variant_for_group(
            lot_id=lot_id,
            substitute_group_id=data['substitute_group_id'],
            selected_variant_id=data['selected_variant_id'],
            reason=data.get('reason')
        )
        
        current_app.logger.info(
            f"Variant selected for lot {lot_id}, group {data['substitute_group_id']}"
        )
        return jsonify(selection), 201
        
    except Exception as e:
        current_app.logger.error(f"Error selecting variant: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/selections', methods=['GET'])
@login_required
def get_lot_selections(lot_id):
    """Get all variant selections for a lot."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        return jsonify(lot.get('selections', [])), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting selections: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/batch_select_variants', methods=['POST'])
@login_required
def batch_select_variants(lot_id):
    """Save multiple variant selections at once."""
    try:
        from database import get_conn
        from app.services.audit_service import audit
        
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        if lot['status'] not in ['planning', 'ready']:
            return jsonify({'error': 'Lot must be in planning or ready status'}), 400
        
        data = request.json
        selections = data.get('selections', [])
        
        if not selections:
            return jsonify({'error': 'No selections provided'}), 400
        
        with get_conn() as (conn, cur):
            # Delete existing selections for this lot
            cur.execute(
                "DELETE FROM production_lot_variant_selections WHERE lot_id = %s",
                (lot_id,)
            )
            
            # Insert new selections
            for sel in selections:
                cur.execute("""
                    INSERT INTO production_lot_variant_selections 
                    (lot_id, or_group_id, variant_usage_id, quantity_override, reason, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """, (
                    lot_id,
                    sel.get('or_group_id'),
                    sel['variant_usage_id'],
                    sel.get('quantity_override'),
                    sel.get('reason'),
                    current_user.id
                ))
            
            conn.commit()
        
        # Audit log
        audit.log_action(
            'UPDATE', 
            'production_lot', 
            lot_id, 
            lot['lot_number'],
            changes={'selections': selections},
            metadata={'selection_count': len(selections)}
        )
        
        current_app.logger.info(f"Saved {len(selections)} variant selections for lot {lot_id}")
        return jsonify({'success': True, 'selections_saved': len(selections)}), 200
        
    except Exception as e:
        current_app.logger.error(f"Error saving variant selections: {e}")
        return jsonify({'error': str(e)}), 500


# ===== LOT VALIDATION & EXECUTION =====

@production_api_bp.route('/production_lot/<int:lot_id>/validate', methods=['POST'])
@login_required
def validate_lot_readiness(lot_id):
    """Validate lot readiness (all OR groups selected, stock available)."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        validation_result = ProductionService.validate_lot_readiness(lot_id)
        
        return jsonify(validation_result), 200
        
    except Exception as e:
        current_app.logger.error(f"Error validating lot: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/execute', methods=['POST'])
@login_required
@role_required('admin', 'inventory_manager', 'production_manager')
def execute_production_lot(lot_id):
    """Execute production lot (deduct inventory, track actual costs)."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        if lot['status'] != 'planning':
            return jsonify({'error': 'Lot must be in planning status'}), 400
        
        # Validate before execution
        validation = ProductionService.validate_lot_readiness(lot_id)
        if not validation['is_ready']:
            return jsonify({
                'error': 'Lot is not ready for execution',
                'validation': validation
            }), 400
        
        # Execute
        executed_lot = ProductionService.execute_production_lot(lot_id)
        
        current_app.logger.info(
            f"Production lot executed: {executed_lot['lot_number']} by user {current_user.id}"
        )
        return jsonify(executed_lot), 200
        
    except Exception as e:
        current_app.logger.error(f"Error executing production lot: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/cancel', methods=['POST'])
@login_required
def cancel_production_lot(lot_id):
    """Cancel production lot."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        data = request.json
        reason = data.get('reason', 'User cancelled')
        
        cancelled_lot = ProductionService.cancel_production_lot(lot_id, reason)
        
        current_app.logger.info(
            f"Production lot cancelled: {cancelled_lot['lot_number']} by user {current_user.id}"
        )
        return jsonify(cancelled_lot), 200
        
    except Exception as e:
        current_app.logger.error(f"Error cancelling production lot: {e}")
        return jsonify({'error': str(e)}), 500


# ===== ACTUAL COSTING & VARIANCE ANALYSIS =====

@production_api_bp.route('/production_lot/<int:lot_id>/actual_costing', methods=['GET'])
@login_required
def get_lot_actual_costing(lot_id):
    """Get actual costing breakdown for lot."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        actual_costs = ProductionService.calculate_lot_actual_cost(lot_id)
        
        return jsonify(actual_costs), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting actual costing: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lot/<int:lot_id>/variance_analysis', methods=['GET'])
@login_required
def get_variance_analysis(lot_id):
    """Get variance analysis (worst-case vs actual)."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return jsonify({'error': 'Production lot not found'}), 404
        
        if lot['user_id'] != current_user.id and current_user.role != 'admin':
            return jsonify({'error': 'Access denied'}), 403
        
        if lot['status'] != 'completed':
            return jsonify({'error': 'Lot must be completed for variance analysis'}), 400
        
        variance = ProductionService.get_variance_analysis(lot_id)
        
        return jsonify(variance), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting variance analysis: {e}")
        return jsonify({'error': str(e)}), 500


# ===== REPORTING =====

@production_api_bp.route('/production_lots/summary', methods=['GET'])
@login_required
def get_production_summary():
    """Get production summary statistics."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Get summary by status
        user_filter = "" if current_user.role == 'admin' else f"AND user_id = {current_user.id}"
        
        cur.execute(f"""
            SELECT 
                status,
                COUNT(*) as count,
                SUM(quantity) as total_quantity,
                AVG(estimated_total_cost) as avg_estimated_cost
            FROM production_lots
            WHERE deleted_at IS NULL {user_filter}
            GROUP BY status
        """)
        
        summary = cur.fetchall()
        cur.close()
        
        return jsonify([dict(row) for row in summary]), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting production summary: {e}")
        return jsonify({'error': str(e)}), 500


@production_api_bp.route('/production_lots/recent', methods=['GET'])
@login_required
def get_recent_lots():
    """Get recently executed production lots."""
    try:
        limit = min(int(request.args.get('limit', 10)), 50)
        
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        user_filter = "" if current_user.role == 'admin' else f"AND pl.user_id = {current_user.id}"
        
        cur.execute(f"""
            SELECT 
                pl.*,
                p.name as process_name
            FROM production_lots pl
            JOIN processes p ON pl.process_id = p.id
            WHERE pl.deleted_at IS NULL 
                AND pl.status = 'completed' 
                {user_filter}
            ORDER BY pl.executed_at DESC
            LIMIT %s
        """, (limit,))
        
        lots = cur.fetchall()
        cur.close()
        
        return jsonify([dict(row) for row in lots]), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting recent lots: {e}")
        return jsonify({'error': str(e)}), 500


# Error handlers
@production_api_bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Resource not found'}), 404


@production_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500
