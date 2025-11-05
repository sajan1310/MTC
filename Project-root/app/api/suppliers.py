from flask import request
from . import api_bp
from app.utils.response import APIResponse

@api_bp.route('/suppliers', methods=['GET'])
def get_suppliers():
    # ...fetch suppliers logic...
    return APIResponse.success(data=[], message="OK")
