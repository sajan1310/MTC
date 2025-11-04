"""
Variant Management API for Universal Process Framework.

Provides REST API endpoints for variant usage, substitute groups (OR feature),
cost items, and multi-supplier pricing.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from functools import wraps

from app import limiter
from app.services.subprocess_service import SubprocessService
from app.services.variant_service import VariantService

variant_api_bp = Blueprint('variant_api', __name__)


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


# ===== VARIANT USAGE =====

@variant_api_bp.route('/variant_usage', methods=['POST'])
@login_required
def add_variant_usage():
    """Add variant to subprocess."""
    try:
        data = request.json
        
        if not data.get('subprocess_id'):
            return jsonify({'error': 'subprocess_id is required'}), 400
        if not data.get('item_id'):
            return jsonify({'error': 'item_id is required'}), 400
        if not data.get('quantity'):
            return jsonify({'error': 'quantity is required'}), 400
        
        variant_usage = VariantService.add_variant_usage(
            subprocess_id=data['subprocess_id'],
            item_id=data['item_id'],
            quantity=data['quantity'],
            unit=data.get('unit', 'pcs'),
            notes=data.get('notes')
        )
        
        current_app.logger.info(
            f"Variant usage added: item {data['item_id']} to subprocess {data['subprocess_id']}"
        )
        return jsonify(variant_usage), 201
        
    except Exception as e:
        current_app.logger.error(f"Error adding variant usage: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/variant_usage/<int:usage_id>', methods=['PUT'])
@login_required
def update_variant_usage(usage_id):
    """Update variant usage quantity/unit."""
    try:
        data = request.json
        
        updated = VariantService.update_variant_usage(
            usage_id,
            quantity=data.get('quantity'),
            unit=data.get('unit'),
            notes=data.get('notes')
        )
        
        if not updated:
            return jsonify({'error': 'Variant usage not found'}), 404
        
        current_app.logger.info(f"Variant usage updated: {usage_id}")
        return jsonify(updated), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating variant usage: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/variant_usage/<int:usage_id>', methods=['DELETE'])
@login_required
def remove_variant_usage(usage_id):
    """Remove variant from subprocess."""
    try:
        success = VariantService.remove_variant_usage(usage_id)
        
        if not success:
            return jsonify({'error': 'Variant usage not found'}), 404
        
        current_app.logger.info(f"Variant usage removed: {usage_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error removing variant usage: {e}")
        return jsonify({'error': str(e)}), 500


# ===== SUBSTITUTE GROUPS (OR FEATURE) =====

@variant_api_bp.route('/substitute_group', methods=['POST'])
@login_required
def create_substitute_group():
    """Create substitute group (OR feature) for subprocess."""
    try:
        data = request.json
        
        if not data.get('subprocess_id'):
            return jsonify({'error': 'subprocess_id is required'}), 400
        if not data.get('variant_ids') or len(data['variant_ids']) < 2:
            return jsonify({'error': 'At least 2 variant_ids required for OR group'}), 400
        
        group = SubprocessService.create_substitute_group(
            subprocess_id=data['subprocess_id'],
            variant_ids=data['variant_ids'],
            group_name=data.get('group_name'),
            selection_logic=data.get('selection_logic', 'manual')
        )
        
        current_app.logger.info(
            f"Substitute group created for subprocess {data['subprocess_id']}"
        )
        return jsonify(group), 201
        
    except Exception as e:
        current_app.logger.error(f"Error creating substitute group: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/substitute_group/<int:group_id>', methods=['DELETE'])
@login_required
def delete_substitute_group(group_id):
    """Delete substitute group."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute(
            "UPDATE substitute_groups SET deleted_at = NOW() WHERE id = %s AND deleted_at IS NULL",
            (group_id,)
        )
        
        conn.commit()
        cur.close()
        
        current_app.logger.info(f"Substitute group deleted: {group_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error deleting substitute group: {e}")
        return jsonify({'error': str(e)}), 500


# ===== COST ITEMS =====

@variant_api_bp.route('/cost_item', methods=['POST'])
@login_required
def add_cost_item():
    """Add cost item (labor, overhead) to subprocess."""
    try:
        data = request.json
        
        if not data.get('subprocess_id'):
            return jsonify({'error': 'subprocess_id is required'}), 400
        if not data.get('cost_type'):
            return jsonify({'error': 'cost_type is required'}), 400
        if not data.get('amount'):
            return jsonify({'error': 'amount is required'}), 400
        
        cost_item = SubprocessService.add_cost_item(
            subprocess_id=data['subprocess_id'],
            cost_type=data['cost_type'],
            amount=data['amount'],
            description=data.get('description'),
            unit=data.get('unit', 'per_unit')
        )
        
        current_app.logger.info(
            f"Cost item added: {data['cost_type']} to subprocess {data['subprocess_id']}"
        )
        return jsonify(cost_item), 201
        
    except Exception as e:
        current_app.logger.error(f"Error adding cost item: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/cost_item/<int:cost_id>', methods=['PUT'])
@login_required
def update_cost_item(cost_id):
    """Update cost item amount/description."""
    try:
        data = request.json
        
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Build dynamic update
        updates = []
        params = []
        
        if 'amount' in data:
            updates.append("amount = %s")
            params.append(data['amount'])
        if 'description' in data:
            updates.append("description = %s")
            params.append(data['description'])
        if 'unit' in data:
            updates.append("unit = %s")
            params.append(data['unit'])
        
        if not updates:
            return jsonify({'error': 'No fields to update'}), 400
        
        updates.append("updated_at = NOW()")
        params.append(cost_id)
        
        cur.execute(
            f"UPDATE cost_items SET {', '.join(updates)} WHERE id = %s AND deleted_at IS NULL RETURNING *",
            params
        )
        
        updated = cur.fetchone()
        conn.commit()
        cur.close()
        
        if not updated:
            return jsonify({'error': 'Cost item not found'}), 404
        
        current_app.logger.info(f"Cost item updated: {cost_id}")
        return jsonify(dict(updated)), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating cost item: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/cost_item/<int:cost_id>', methods=['DELETE'])
@login_required
def remove_cost_item(cost_id):
    """Remove cost item from subprocess."""
    try:
        from database import get_conn
        
        conn = get_conn()
        cur = conn.cursor()
        
        cur.execute(
            "UPDATE cost_items SET deleted_at = NOW() WHERE id = %s",
            (cost_id,)
        )
        
        conn.commit()
        cur.close()
        
        current_app.logger.info(f"Cost item removed: {cost_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error removing cost item: {e}")
        return jsonify({'error': str(e)}), 500


# ===== MULTI-SUPPLIER PRICING =====

@variant_api_bp.route('/variant/<int:item_id>/supplier_pricing', methods=['POST'])
@login_required
@role_required('admin', 'inventory_manager')
def add_supplier_pricing(item_id):
    """Add supplier pricing for a variant."""
    try:
        data = request.json
        
        if not data.get('supplier_id'):
            return jsonify({'error': 'supplier_id is required'}), 400
        if not data.get('unit_price'):
            return jsonify({'error': 'unit_price is required'}), 400
        
        pricing = VariantService.add_supplier_pricing(
            item_id=item_id,
            supplier_id=data['supplier_id'],
            unit_price=data['unit_price'],
            moq=data.get('moq', 1),
            lead_time_days=data.get('lead_time_days'),
            effective_date=data.get('effective_date')
        )
        
        current_app.logger.info(
            f"Supplier pricing added: item {item_id}, supplier {data['supplier_id']}"
        )
        return jsonify(pricing), 201
        
    except Exception as e:
        current_app.logger.error(f"Error adding supplier pricing: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/variant/<int:item_id>/supplier_pricing', methods=['GET'])
@login_required
def get_variant_suppliers(item_id):
    """Get all supplier pricing for a variant."""
    try:
        suppliers = VariantService.get_variant_suppliers(item_id)
        return jsonify(suppliers), 200
        
    except Exception as e:
        current_app.logger.error(f"Error getting variant suppliers: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/supplier_pricing/<int:pricing_id>', methods=['PUT'])
@login_required
@role_required('admin', 'inventory_manager')
def update_supplier_pricing(pricing_id):
    """Update supplier pricing."""
    try:
        data = request.json
        
        updated = VariantService.update_supplier_pricing(
            pricing_id,
            unit_price=data.get('unit_price'),
            moq=data.get('moq'),
            lead_time_days=data.get('lead_time_days'),
            is_active=data.get('is_active')
        )
        
        if not updated:
            return jsonify({'error': 'Supplier pricing not found'}), 404
        
        current_app.logger.info(f"Supplier pricing updated: {pricing_id}")
        return jsonify(updated), 200
        
    except Exception as e:
        current_app.logger.error(f"Error updating supplier pricing: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/supplier_pricing/<int:pricing_id>', methods=['DELETE'])
@login_required
@role_required('admin', 'inventory_manager')
def remove_supplier_pricing(pricing_id):
    """Remove supplier pricing."""
    try:
        success = VariantService.remove_supplier_pricing(pricing_id)
        
        if not success:
            return jsonify({'error': 'Supplier pricing not found'}), 404
        
        current_app.logger.info(f"Supplier pricing removed: {pricing_id}")
        return '', 204
        
    except Exception as e:
        current_app.logger.error(f"Error removing supplier pricing: {e}")
        return jsonify({'error': str(e)}), 500


# ===== VARIANT SEARCH & DISCOVERY =====

@variant_api_bp.route('/variants/search', methods=['GET'])
@login_required
def search_variants():
    """Search variants for autocomplete (drag-and-drop panel)."""
    try:
        query = request.args.get('q', '')
        limit = min(int(request.args.get('limit', 50)), 100)
        
        # Parse filters
        filters = {}
        if request.args.get('category_id'):
            filters['category_id'] = int(request.args.get('category_id'))
        if request.args.get('in_stock_only') == 'true':
            filters['in_stock_only'] = True
        if request.args.get('min_stock'):
            filters['min_stock'] = int(request.args.get('min_stock'))
        if request.args.get('max_cost'):
            filters['max_cost'] = float(request.args.get('max_cost'))
        
        results = VariantService.search_variants(query, filters, limit)
        return jsonify(results), 200
        
    except Exception as e:
        current_app.logger.error(f"Error searching variants: {e}")
        return jsonify({'error': str(e)}), 500


@variant_api_bp.route('/variant/<int:item_id>/availability', methods=['GET'])
@login_required
def check_variant_availability(item_id):
    """Check variant stock availability."""
    try:
        required_qty = float(request.args.get('quantity', 1))
        availability = VariantService.check_variant_availability(item_id, required_qty)
        return jsonify(availability), 200
        
    except Exception as e:
        current_app.logger.error(f"Error checking availability: {e}")
        return jsonify({'error': str(e)}), 500


# Error handlers
@variant_api_bp.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Resource not found'}), 404


@variant_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500
