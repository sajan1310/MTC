import json
import logging
from typing import Any, Dict
from flask import current_app, request, Blueprint, jsonify
from flask_login import current_user, login_required
from app.utils import role_required
from app.utils.response import APIResponse
from app.services import get_progress
from database import get_conn

# All import endpoints should be registered via api_bp in routes.py
logger = logging.getLogger(__name__)

# Import endpoints are now handled in routes.py under api_bp
