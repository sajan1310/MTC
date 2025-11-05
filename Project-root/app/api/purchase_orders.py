from flask import request
from . import api_bp
from app.utils.response import APIResponse

@api_bp.route('/purchase-orders', methods=['GET'])
def get_purchase_orders():
    # ...fetch purchase orders logic...
    return APIResponse.success(data=[], message="OK")
