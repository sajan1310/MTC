from flask import Blueprint

api_bp = Blueprint("api", __name__, url_prefix="/api")

# [BUG FIX] Import routes.py LAST so full implementations override any stubs
# The items.py, suppliers.py, purchase_orders.py, and stubs.py had stub implementations
# that were returning empty data and overriding the real endpoints in routes.py
from . import imports, items, purchase_orders, stubs, suppliers, routes
