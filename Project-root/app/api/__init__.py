from flask import Blueprint

# Create the blueprint first
api_bp = Blueprint("api", __name__, url_prefix="/api")

# Import routes AFTER blueprint creation to avoid circular imports
# This registers all API endpoints (items, suppliers, purchase_orders, etc.)
from . import routes  # noqa: E402

__all__ = ["api_bp", "routes"]
