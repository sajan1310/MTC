from flask import jsonify, request
from . import api_bp
from app.auth.decorators import role_required

@api_bp.route('/purchase-orders', methods=['GET'])
@role_required('user')
def get_purchase_orders():
    # ...fetch purchase orders logic...
    return jsonify({'success': True, 'data': [], 'error': None})
