from flask import jsonify, request
from . import api_bp
from app.auth.decorators import role_required

@api_bp.route('/items', methods=['GET'])
@role_required('user')
def get_items():
    # ...fetch items logic...
    return jsonify({'success': True, 'data': [], 'error': None})
