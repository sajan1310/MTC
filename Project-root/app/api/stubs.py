from . import api_bp
from app.utils.response import APIResponse

@api_bp.route('/stock-trend')
def stock_trend_data():
    """Minimal stub for dashboard chart in tests."""
    return APIResponse.success(data={'series': []}, message="OK")
