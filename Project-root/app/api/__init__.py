from flask import Blueprint

# Create the blueprint first
api_bp = Blueprint("api", __name__, url_prefix="/api")

# Import routes AFTER blueprint creation to avoid circular imports
from . import imports, items, purchase_orders, stubs, suppliers, routes  # noqa: E402

__all__ = ["api_bp", "imports", "items", "purchase_orders", "stubs", "suppliers", "routes"]
