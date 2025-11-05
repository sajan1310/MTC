# utils package - centralized utility exports
import os

# Import utilities from the sibling utils.py module (not this package)
import sys

from .file_validation import validate_upload

# Get the parent app directory
app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
utils_py_path = os.path.join(app_dir, "utils.py")

# Load the utils.py module directly
import importlib.util

spec = importlib.util.spec_from_file_location("app_utils_module", utils_py_path)
utils_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utils_module)

# Export functions from utils.py
get_or_create_user = utils_module.get_or_create_user
role_required = utils_module.role_required
get_or_create_master_id = utils_module.get_or_create_master_id
get_or_create_item_master_id = utils_module.get_or_create_item_master_id

__all__ = [
    "validate_upload",
    "get_or_create_user",
    "role_required",
    "get_or_create_master_id",
    "get_or_create_item_master_id",
]
