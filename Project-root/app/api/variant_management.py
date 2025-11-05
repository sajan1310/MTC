"""
Variant Management API for Universal Process Framework.

Provides REST API endpoints for variant usage, substitute groups (OR feature),
cost items, and multi-supplier pricing.
"""
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from functools import wraps

from app import limiter
from app.utils.response import APIResponse
from app.services.subprocess_service import SubprocessService
from app.services.variant_service import VariantService
from app.services.audit_service import audit

variant_api_bp = Blueprint('variant_api', __name__)


def role_required(*roles):
    """Decorator to require specific user role."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return APIResponse.error('unauthenticated', 'Authentication required', 401)
            if current_user.role not in roles and current_user.role != 'admin':
                return APIResponse.error('forbidden', 'Insufficient permissions', 403)
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
            return APIResponse.error('validation_error', 'subprocess_id is required', 400)
        if not data.get('item_id'):
            return APIResponse.error('validation_error', 'item_id is required', 400)
        if not data.get('quantity'):
            return APIResponse.error('validation_error', 'quantity is required', 400)
        
        variant_usage = VariantService.add_variant_usage(
            subprocess_id=data['subprocess_id'],
            item_id=data['item_id'],
            quantity=data['quantity'],
            unit=data.get('unit', 'pcs'),
            notes=data.get('notes')
        )
        
        # Audit log
        audit.log_create('variant_usage', variant_usage.get('id'), f"Item {data['item_id']}", data=data)
        
        current_app.logger.info(
            f"Variant usage added: item {data['item_id']} to subprocess {data['subprocess_id']}"
        )
        return APIResponse.created(variant_usage, 'Variant usage added')
    except Exception as e:
        current_app.logger.error(f"Error adding variant usage: {e}")
        return APIResponse.error('internal_error', str(e), 500)


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
            return APIResponse.not_found('Variant usage', usage_id)
        
        # Audit log
        audit.log_update('variant_usage', usage_id, f"Usage {usage_id}", new_data=data)
        
        current_app.logger.info(f"Variant usage updated: {usage_id}")
        return APIResponse.success(updated, 'Variant usage updated')
    except Exception as e:
        current_app.logger.error(f"Error updating variant usage: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/variant_usage/<int:usage_id>', methods=['DELETE'])
@login_required
def remove_variant_usage(usage_id):
    """Remove variant from subprocess."""
    try:
        success = VariantService.remove_variant_usage(usage_id)
        
        if not success:
            return APIResponse.not_found('Variant usage', usage_id)
        
        # Audit log
        audit.log_delete('variant_usage', usage_id, f"Usage {usage_id}")
        
        current_app.logger.info(f"Variant usage removed: {usage_id}")
        return APIResponse.success(None, 'Variant usage removed')
    except Exception as e:
        current_app.logger.error(f"Error removing variant usage: {e}")
        return APIResponse.error('internal_error', str(e), 500)


# ===== SUBSTITUTE GROUPS (OR FEATURE) =====

@variant_api_bp.route('/substitute_group', methods=['POST'])
@login_required
def create_substitute_group():
    """Create substitute group (OR feature) for subprocess."""
    try:
        data = request.json
        
        if not data.get('subprocess_id'):
            return APIResponse.error('validation_error', 'subprocess_id is required', 400)
        if not data.get('variant_ids') or len(data['variant_ids']) < 2:
            return APIResponse.error('validation_error', 'At least 2 variant_ids required for OR group', 400)
        
        group = SubprocessService.create_substitute_group(
            subprocess_id=data['subprocess_id'],
            variant_ids=data['variant_ids'],
            group_name=data.get('group_name'),
            selection_logic=data.get('selection_logic', 'manual')
        )
        
        # Audit log
        audit.log_create('substitute_group', group.get('id'), data.get('group_name', 'OR Group'), data=data)
        
        current_app.logger.info(
            f"Substitute group created for subprocess {data['subprocess_id']}"
        )
        return APIResponse.created(group, 'Substitute group created')
    except Exception as e:
        current_app.logger.error(f"Error creating substitute group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/substitute_group/<int:group_id>', methods=['GET'])
@login_required
def get_substitute_group(group_id):
    """Get substitute group with all variants."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Get group info
        cur.execute(
            "SELECT * FROM substitute_groups WHERE id = %s AND deleted_at IS NULL",
            (group_id,)
        )
        group = cur.fetchone()
        
        if not group:
            return APIResponse.not_found('Substitute group', group_id)
        
        # Get all variants in this group
        cur.execute("""
            SELECT 
                vu.*,
                iv.name as variant_name,
                iv.opening_stock,
                iv.unit_price
            FROM variant_usage vu
            JOIN item_variant iv ON iv.variant_id = vu.variant_id
            WHERE vu.substitute_group_id = %s
              AND vu.is_alternative = TRUE
            ORDER BY vu.alternative_order
        """, (group_id,))
        
        variants = cur.fetchall()
        cur.close()
        
        result = dict(group)
        result['variants'] = [dict(v) for v in variants]
        return APIResponse.success(result)
    except Exception as e:
        current_app.logger.error(f"Error getting substitute group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/process_subprocess/<int:ps_id>/substitute_groups', methods=['GET'])
@login_required
def get_subprocess_substitute_groups(ps_id):
    """Get all substitute groups for a process_subprocess."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Get all groups for this subprocess
        cur.execute("""
            SELECT * FROM substitute_groups 
            WHERE process_subprocess_id = %s AND deleted_at IS NULL
            ORDER BY created_at
        """, (ps_id,))
        
        groups = cur.fetchall()
        result = []
        
        for group in groups:
            # Get variants for each group
            cur.execute("""
                SELECT 
                    vu.*,
                    iv.name as variant_name,
                    iv.opening_stock,
                    iv.unit_price
                FROM variant_usage vu
                JOIN item_variant iv ON iv.variant_id = vu.variant_id
                WHERE vu.substitute_group_id = %s
                  AND vu.is_alternative = TRUE
                ORDER BY vu.alternative_order
            """, (group['id'],))
            
            variants = cur.fetchall()
            group_dict = dict(group)
            group_dict['variants'] = [dict(v) for v in variants]
            result.append(group_dict)
        cur.close()
        return APIResponse.success(result)
    except Exception as e:
        current_app.logger.error(f"Error getting substitute groups: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/substitute_group/<int:group_id>', methods=['PUT'])
@login_required
def update_substitute_group(group_id):
    """Update substitute group name or selection method."""
    try:
        data = request.json
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        updates = []
        params = []
        
        if 'group_name' in data:
            updates.append("group_name = %s")
            params.append(data['group_name'])
        
        if 'group_description' in data:
            updates.append("group_description = %s")
            params.append(data['group_description'])
        
        if 'selection_method' in data:
            updates.append("selection_method = %s")
            params.append(data['selection_method'])
        
        if not updates:
            return APIResponse.error('validation_error', 'No fields to update', 400)
        
        updates.append("updated_at = NOW()")
        params.append(group_id)
        
        cur.execute(
            f"UPDATE substitute_groups SET {', '.join(updates)} WHERE id = %s AND deleted_at IS NULL RETURNING *",
            params
        )
        
        updated = cur.fetchone()
        conn.commit()
        cur.close()
        
        if not updated:
            return APIResponse.not_found('Substitute group', group_id)
        
        current_app.logger.info(f"Substitute group updated: {group_id}")
        return APIResponse.success(dict(updated), 'Substitute group updated')
    except Exception as e:
        current_app.logger.error(f"Error updating substitute group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/substitute_group/<int:group_id>', methods=['DELETE'])
@login_required
def delete_substitute_group(group_id):
    """Delete substitute group."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Soft delete the group
        cur.execute(
            "UPDATE substitute_groups SET deleted_at = NOW() WHERE id = %s AND deleted_at IS NULL",
            (group_id,)
        )
        
        # Reset variants that were in this group
        cur.execute("""
            UPDATE variant_usage 
            SET substitute_group_id = NULL, 
                is_alternative = FALSE, 
                alternative_order = NULL
            WHERE substitute_group_id = %s
        """, (group_id,))
        
        conn.commit()
        cur.close()
        
        # Audit log
        audit.log_delete('substitute_group', group_id, f"OR Group {group_id}")
        
        current_app.logger.info(f"Substitute group deleted: {group_id}")
        return APIResponse.success(None, 'Substitute group deleted')
    except Exception as e:
        current_app.logger.error(f"Error deleting substitute group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/substitute_group/<int:group_id>/add_variant', methods=['POST'])
@login_required
def add_variant_to_group(group_id):
    """Add a variant to an existing substitute group."""
    try:
        data = request.json
        
        if not data.get('usage_id'):
            return APIResponse.error('validation_error', 'usage_id is required', 400)
        
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verify group exists
        cur.execute("SELECT * FROM substitute_groups WHERE id = %s AND deleted_at IS NULL", (group_id,))
        if not cur.fetchone():
            return APIResponse.not_found('Substitute group', group_id)
        
        # Get max alternative_order for this group
        cur.execute("""
            SELECT COALESCE(MAX(alternative_order), 0) as max_order
            FROM variant_usage
            WHERE substitute_group_id = %s
        """, (group_id,))
        max_order = cur.fetchone()['max_order']
        
        # Update variant usage
        cur.execute("""
            UPDATE variant_usage
            SET substitute_group_id = %s,
                is_alternative = TRUE,
                alternative_order = %s,
                updated_at = NOW()
            WHERE id = %s
            RETURNING *
        """, (group_id, max_order + 1, data['usage_id']))
        
        updated = cur.fetchone()
        conn.commit()
        cur.close()
        
        if not updated:
            return APIResponse.not_found('Variant usage', data.get('usage_id'))
        
        current_app.logger.info(f"Variant added to substitute group {group_id}")
        return APIResponse.success(dict(updated), 'Variant added to substitute group')
    except Exception as e:
        current_app.logger.error(f"Error adding variant to group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/variant_usage/<int:usage_id>/remove_from_group', methods=['POST'])
@login_required
def remove_variant_from_group(usage_id):
    """Remove a variant from its substitute group without deleting it."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        cur.execute("""
            UPDATE variant_usage
            SET substitute_group_id = NULL,
                is_alternative = FALSE,
                alternative_order = NULL,
                updated_at = NOW()
            WHERE id = %s
            RETURNING *
        """, (usage_id,))
        
        updated = cur.fetchone()
        conn.commit()
        cur.close()
        
        if not updated:
            return APIResponse.not_found('Variant usage', usage_id)
        
        current_app.logger.info(f"Variant removed from substitute group: {usage_id}")
        return APIResponse.success(dict(updated), 'Variant removed from substitute group')
    except Exception as e:
        current_app.logger.error(f"Error removing variant from group: {e}")
        return APIResponse.error('internal_error', str(e), 500)


# ===== COST ITEMS =====

@variant_api_bp.route('/cost_item', methods=['POST'])
@login_required
def add_cost_item():
    """Add cost item (labor, overhead) to a process subprocess association."""
    try:
        data = request.get_json(silent=True) or {}

        ps_id = data.get('process_subprocess_id') or data.get('subprocess_id')
        cost_type = data.get('cost_type', 'generic')
        rate = data.get('rate')
        quantity = data.get('quantity', 1)

        if not ps_id:
            return APIResponse.error('validation_error', 'subprocess_id is required', 400)
        if rate is None:
            return APIResponse.error('validation_error', 'rate is required', 400)

        cost_item = SubprocessService.add_cost_item(
            process_subprocess_id=int(ps_id),
            cost_type=cost_type,
            quantity=float(quantity),
            rate_per_unit=float(rate),
            description=data.get('description'),
        )

        current_app.logger.info(
            f"Cost item added: {cost_type} to process_subprocess {ps_id}"
        )
        return APIResponse.created(cost_item, 'Cost item added')
    except ValueError as e:
        return APIResponse.error('validation_error', f'Invalid number: {str(e)}', 400)
    except Exception as e:
        current_app.logger.error(f"Error adding cost item: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/cost_item/<int:cost_id>', methods=['PUT'])
@login_required
def update_cost_item(cost_id):
    """Update cost item rate/quantity/description and recalc total."""
    try:
        data = request.get_json(silent=True) or {}

        from database import get_conn
        from psycopg2.extras import RealDictCursor

        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Build dynamic update
        updates = []
        params = []

        if 'rate' in data:
            updates.append("rate_per_unit = %s")
            params.append(float(data['rate']))
        if 'quantity' in data:
            updates.append("quantity = %s")
            params.append(float(data['quantity']))
        if 'description' in data:
            updates.append("description = %s")
            params.append(data['description'])

        if not updates:
            cur.close()
            return APIResponse.error('validation_error', 'No fields to update', 400)

        # Always recalc total_cost based on (possibly) new fields
        updates.append("total_cost = rate_per_unit * quantity")
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
            return APIResponse.not_found('CostItem', cost_id)

        current_app.logger.info(f"Cost item updated: {cost_id}")
        return APIResponse.success(dict(updated), 'Cost item updated')
    except ValueError as e:
        return APIResponse.error('validation_error', f'Invalid number: {str(e)}', 400)
    except Exception as e:
        current_app.logger.error(f"Error updating cost item: {e}")
        return APIResponse.error('internal_error', str(e), 500)


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
        return APIResponse.success(None, 'Cost item removed')
    except Exception as e:
        current_app.logger.error(f"Error removing cost item: {e}")
        return APIResponse.error('internal_error', str(e), 500)


# ===== MULTI-SUPPLIER PRICING =====

@variant_api_bp.route('/variant/<int:item_id>/supplier_pricing', methods=['POST'])
@login_required
@role_required('admin', 'inventory_manager')
def add_supplier_pricing(item_id):
    """Add supplier pricing for a variant."""
    try:
        data = request.json
        
        if not data.get('supplier_id'):
            return APIResponse.error('validation_error', 'supplier_id is required', 400)
        if not data.get('unit_price'):
            return APIResponse.error('validation_error', 'unit_price is required', 400)
        
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
        return APIResponse.created(pricing, 'Supplier pricing added')
    except Exception as e:
        current_app.logger.error(f"Error adding supplier pricing: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/variant/<int:item_id>/supplier_pricing', methods=['GET'])
@login_required
def get_variant_suppliers(item_id):
    """Get all supplier pricing for a variant."""
    try:
        suppliers = VariantService.get_variant_suppliers(item_id)
        return APIResponse.success(suppliers)
    except Exception as e:
        current_app.logger.error(f"Error getting variant suppliers: {e}")
        return APIResponse.error('internal_error', str(e), 500)


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
            return APIResponse.not_found('Supplier pricing', pricing_id)
        
        current_app.logger.info(f"Supplier pricing updated: {pricing_id}")
        return APIResponse.success(updated, 'Supplier pricing updated')
    except Exception as e:
        current_app.logger.error(f"Error updating supplier pricing: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/supplier_pricing/<int:pricing_id>', methods=['DELETE'])
@login_required
@role_required('admin', 'inventory_manager')
def remove_supplier_pricing(pricing_id):
    """Remove supplier pricing."""
    try:
        success = VariantService.remove_supplier_pricing(pricing_id)
        
        if not success:
            return APIResponse.not_found('Supplier pricing', pricing_id)
        
        current_app.logger.info(f"Supplier pricing removed: {pricing_id}")
        return APIResponse.success(None, 'Supplier pricing removed')
    except Exception as e:
        current_app.logger.error(f"Error removing supplier pricing: {e}")
        return APIResponse.error('internal_error', str(e), 500)


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
        return APIResponse.success(results)
    except Exception as e:
        current_app.logger.error(f"Error searching variants: {e}")
        return APIResponse.error('internal_error', str(e), 500)


@variant_api_bp.route('/variant/<int:item_id>/availability', methods=['GET'])
@login_required
def check_variant_availability(item_id):
    """Check variant stock availability."""
    try:
        required_qty = float(request.args.get('quantity', 1))
        availability = VariantService.check_variant_availability(item_id, required_qty)
        return APIResponse.success(availability)
    except Exception as e:
        current_app.logger.error(f"Error checking availability: {e}")
        return APIResponse.error('internal_error', str(e), 500)


# Error handlers
@variant_api_bp.errorhandler(404)
def not_found(error):
    return APIResponse.error('not_found', 'Resource not found', 404)


@variant_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return APIResponse.error('internal_error', 'Internal server error', 500)
