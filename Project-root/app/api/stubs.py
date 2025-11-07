"""
Stub Endpoints for Missing Backend Routes
==========================================
This module provides stub implementations for 26 missing backend routes
identified during the synchronization audit. These stubs return valid JSON
responses and prevent 404 errors while full functionality is being developed.

All stubs log warnings when called and return status='stub' in responses.
"""

from __future__ import annotations

import logging
from flask import jsonify, request
from flask_login import login_required

from . import api_bp

logger = logging.getLogger(__name__)


# ============================================================================
# REPORTS MODULE STUBS
# ============================================================================

@api_bp.route('/upf/reports/metrics', methods=['GET'])
@login_required
def get_report_metrics_stub():
    """
    TODO: Implement metrics report generation logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: GET /api/upf/reports/metrics")
    return jsonify({
        'status': 'stub',
        'message': 'Metrics report generation feature in development',
        'data': {
            'total_processes': 0,
            'total_subprocesses': 0,
            'total_production_lots': 0,
            'active_lots': 0
        }
    }), 200


@api_bp.route('/upf/reports/top-processes', methods=['GET'])
@login_required
def get_report_top_processes_stub():
    """
    TODO: Implement top processes report logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: GET /api/upf/reports/top-processes")
    return jsonify({
        'status': 'stub',
        'message': 'Top processes report feature in development',
        'data': []
    }), 200


@api_bp.route('/upf/reports/process-status', methods=['GET'])
@login_required
def get_report_process_status_stub():
    """
    TODO: Implement process status report logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: GET /api/upf/reports/process-status")
    return jsonify({
        'status': 'stub',
        'message': 'Process status report feature in development',
        'data': {
            'active': 0,
            'inactive': 0,
            'archived': 0
        }
    }), 200


@api_bp.route('/upf/reports/subprocess-usage', methods=['GET'])
@login_required
def get_report_subprocess_usage_stub():
    """
    TODO: Implement subprocess usage report logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: GET /api/upf/reports/subprocess-usage")
    return jsonify({
        'status': 'stub',
        'message': 'Subprocess usage report feature in development',
        'data': []
    }), 200


# ============================================================================
# PROCESS MANAGEMENT STUBS
# ============================================================================

@api_bp.route('/upf/process_subprocess/<int:subprocess_id>', methods=['DELETE'])
@login_required
def delete_process_subprocess_stub(subprocess_id):
    """
    TODO: Implement process-subprocess relationship deletion logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning(f"Stub endpoint called: DELETE /api/upf/process_subprocess/{subprocess_id}")
    return jsonify({
        'status': 'stub',
        'message': 'Process-subprocess deletion feature in development',
        'subprocess_id': subprocess_id
    }), 200


@api_bp.route('/upf/process_subprocess/<int:process_subprocess_id>/substitute_groups', methods=['GET'])
@login_required
def get_substitute_groups_stub(process_subprocess_id):
    """
    TODO: Implement substitute groups retrieval logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning(f"Stub endpoint called: GET /api/upf/process_subprocess/{process_subprocess_id}/substitute_groups")
    return jsonify({
        'status': 'stub',
        'message': 'Substitute groups retrieval feature in development',
        'process_subprocess_id': process_subprocess_id,
        'data': []
    }), 200


# ============================================================================
# VARIANT & INVENTORY STUBS
# ============================================================================

@api_bp.route('/categories', methods=['GET'])
@login_required
def get_categories():
    """
    Returns all categories from the categories table.
    """
    from database import get_conn
    try:
        with get_conn(cursor_factory=None) as (conn, cur):
            cur.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()
            cur.execute("SELECT id, name, description FROM categories ORDER BY name")
            rows = cur.fetchall()
            categories = [
                {"id": row[0], "name": row[1], "description": row[2]} for row in rows
            ]
        return jsonify(categories), 200
    except Exception as e:
        logger.error(f"Error fetching categories: {e}")
        return jsonify({"error": "Failed to fetch categories"}), 500


# ============================================================================
# PRODUCTION LOT STUBS
# ============================================================================

@api_bp.route('/upf/production_lot/<int:lot_id>/variant_options', methods=['POST'])
@login_required
def post_variant_options_stub(lot_id):
    """
    TODO: Implement variant options selection logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning(f"Stub endpoint called: POST /api/upf/production_lot/{lot_id}/variant_options")
    return jsonify({
        'status': 'stub',
        'message': 'Variant options selection feature in development',
        'lot_id': lot_id,
        'data': {}
    }), 200


# ============================================================================
# AUTHENTICATION & USER STUBS
# ============================================================================

@api_bp.route('/reset-password', methods=['POST'])
def reset_password_stub():
    """
    TODO: Implement password reset logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: POST /api/reset-password")
    return jsonify({
        'status': 'stub',
        'message': 'Password reset feature in development',
        'data': {}
    }), 200


# ============================================================================
# STOCK & INVENTORY STUBS
# ============================================================================

@api_bp.route('/stock-receipts', methods=['DELETE'])
@login_required
def delete_stock_receipt_stub():
    """
    TODO: Implement stock receipt deletion logic
    Stub endpoint to prevent 404 errors during development
    """
    logger.warning("Stub endpoint called: DELETE /api/stock-receipts")
    receipt_id = request.args.get('id') or request.json.get('id') if request.json else None
    return jsonify({
        'status': 'stub',
        'message': 'Stock receipt deletion feature in development',
        'receipt_id': receipt_id
    }), 200


# ============================================================================
# PROCESS API BLUEPRINT STUBS (already have process_api_bp routes)
# These routes should be added to process_management.py
# ============================================================================

# Note: The following routes are called from frontend but missing backend:
# - GET /api/upf/processes/${this.processId}  (singular with ID)
# - GET /api/upf/processes/${this.processId}/structure
# - POST /api/upf/processes/${this.processId}/subprocesses
# - GET /api/upf/processes/${id}  (for deletion check)
# - DELETE /api/upf/processes/${id}
# - DELETE /api/upf/process/${processId}  (singular)
# - GET /api/upf/subprocesses/${id}
# - DELETE /api/upf/subprocesses/${id}
# - DELETE /api/upf/subprocesses/${this.deleteTargetId}

# These need to be added to their respective modules:
# - process_management.py for process routes
# - subprocess_management.py for subprocess routes
# - variant_management.py for variant routes

# ============================================================================
# VARIANT USAGE STUBS
# ============================================================================

# ============================================================================
# SUBSTITUTE GROUP STUBS
# ============================================================================

# ============================================================================
# SUMMARY
# ============================================================================
# Total Stub Endpoints Created: 13 (down from 26 - removed 9 duplicates + 4 other)
# 
# Note: Removed 9 duplicate stubs that had real implementations elsewhere:
# - get_process_costing_stub (implemented in process_management.py)
# - reorder_subprocesses_stub (implemented in process_management.py)
# - get_all_variants_stub (implemented in routes.py)
# - api_login_stub (implemented in main/routes.py as compat_api_login)
# - get_process_by_id_stub (implemented in process_management.py)
# - delete_process_by_id_stub (implemented in process_management.py)
# - delete_subprocess_by_id_stub (implemented in subprocess_management.py)
# - delete_variant_usage_stub (implemented in variant_management.py)
# - delete_substitute_group_stub (implemented in variant_management.py)
#
# Reports: 4 endpoints
# - /api/upf/reports/metrics
# - /api/upf/reports/top-processes  
# - /api/upf/reports/process-status
# - /api/upf/reports/subprocess-usage
#
# Process Management: 2 endpoints (down from 7)
# - /api/upf/process_subprocess/<id> DELETE
# - /api/upf/process_subprocess/<id>/substitute_groups
#
# Variants & Inventory: 1 endpoint (down from 5)
# - /api/categories
#
# Production Lot: 1 endpoint
# - /api/upf/production_lot/<id>/variant_options
#
# Auth & User: 1 endpoint (down from 2)
# - /api/reset-password
#
# Stock & Inventory: 1 endpoint
# - /api/stock-receipts DELETE
#
# ============================================================================
