"""
Authenticated file serving endpoint with access control.
Securely serves uploaded files only to authorized users.
"""

import os

import database
import psycopg2.extras
from flask import Blueprint, abort, current_app, send_file
from flask_login import current_user, login_required

files_bp = Blueprint("files", __name__)


@files_bp.route("/api/files/<path:filename>")
@login_required
def serve_file(filename):
    """
    Serve uploaded file with authentication and access control.

    Security requirements:
    - User must be authenticated
    - File must exist
    - User must have permission to access the file
    - Files are served from private_uploads directory only
    """
    # Sanitize filename to prevent directory traversal
    filename = os.path.basename(filename)

    # Construct file path
    uploads_dir = os.path.join(current_app.root_path, "..", "private_uploads")
    file_path = os.path.join(uploads_dir, filename)

    # Verify file exists
    if not os.path.exists(file_path):
        current_app.logger.warning(
            f"[FILE_ACCESS_DENIED] File not found | "
            f"user_id={current_user.id} | filename={filename}"
        )
        abort(404)

    # Check if file is within allowed directory (prevent directory traversal)
    real_path = os.path.realpath(file_path)
    real_uploads = os.path.realpath(uploads_dir)
    if not real_path.startswith(real_uploads):
        current_app.logger.error(
            f"[FILE_ACCESS_DENIED] Directory traversal attempt | "
            f"user_id={current_user.id} | filename={filename}"
        )
        abort(403)

    # Access control: Check if user has permission to access this file
    # For profile pictures: user can access their own
    # For item images: any authenticated user can access
    # Add more granular controls as needed

    try:
        # Check if this is a profile picture
        if filename.startswith(f"{current_user.id}_"):
            # User accessing their own profile picture - allowed
            pass
        else:
            # Check if file is an item image (any authenticated user can view)
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
                conn,
                cur,
            ):
                cur.execute(
                    "SELECT COUNT(*) FROM item_master WHERE image_path = %s",
                    (f"private_uploads/{filename}",),
                )
                if cur.fetchone()[0] == 0:
                    # File not found in item_master and not user's profile pic
                    current_app.logger.warning(
                        f"[FILE_ACCESS_DENIED] Unauthorized access attempt | "
                        f"user_id={current_user.id} | filename={filename}"
                    )
                    abort(403)

        # Log successful file access
        current_app.logger.info(
            f"[FILE_ACCESS_GRANTED] | "
            f"user_id={current_user.id} | filename={filename}"
        )

        # Serve file with proper content type detection
        return send_file(
            file_path,
            mimetype="application/octet-stream",  # Force download for security
            as_attachment=False,
            download_name=filename,
        )

    except Exception as e:
        current_app.logger.error(
            f"[FILE_ACCESS_ERROR] | "
            f"user_id={current_user.id} | filename={filename} | error={str(e)}"
        )
        abort(500)


@files_bp.route("/api/files/profile/<int:user_id>/<path:filename>")
@login_required
def serve_profile_picture(user_id, filename):
    """
    Serve user profile picture with access control.
    Users can only access their own profile pictures unless they are admin.
    """
    # Check permission: user can view their own profile, or admin can view any
    user_role = current_user.role if (current_user.is_authenticated and hasattr(current_user, 'role')) else None
    if current_user.id != user_id and user_role not in ["admin", "super_admin"]:
        current_app.logger.warning(
            f"[FILE_ACCESS_DENIED] Unauthorized profile access | "
            f"user_id={current_user.id} | target_user={user_id} | filename={filename}"
        )
        abort(403)

    # Sanitize and serve file
    filename = os.path.basename(filename)
    uploads_dir = os.path.join(current_app.root_path, "..", "private_uploads")
    file_path = os.path.join(uploads_dir, filename)

    if not os.path.exists(file_path):
        abort(404)

    # Verify file belongs to the requested user
    expected_prefix = f"{user_id}_"
    if not filename.startswith(expected_prefix):
        current_app.logger.error(
            f"[FILE_ACCESS_DENIED] File doesn't match user | "
            f"user_id={current_user.id} | target_user={user_id} | filename={filename}"
        )
        abort(403)

    current_app.logger.info(
        f"[PROFILE_ACCESS_GRANTED] | "
        f"user_id={current_user.id} | target_user={user_id} | filename={filename}"
    )

    return send_file(file_path, mimetype="application/octet-stream")
