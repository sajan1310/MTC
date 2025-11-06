from __future__ import annotations

import os
import uuid

import database
import psycopg2
import psycopg2.extras
from flask import (
    Blueprint,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from flask_login import current_user, login_required
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from .. import validate_password
from ..utils import role_required, validate_upload

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
@login_required
def home():
    return redirect(url_for("main.dashboard"))


@main_bp.route("/health")
def health():
    return jsonify({"status": "ok"}), 200


@main_bp.route("/dashboard")
@login_required
def dashboard():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            cur.execute("SELECT SUM(opening_stock) FROM item_variant")
            total_stock = cur.fetchone()[0] or 0
            cur.execute(
                "SELECT COUNT(*) FROM item_variant WHERE opening_stock <= threshold"
            )
            low_stock_items = cur.fetchone()[0] or 0
            cur.execute("SELECT COUNT(*) FROM suppliers")
            total_suppliers = cur.fetchone()[0] or 0
        metrics = {
            "total_stock": int(total_stock),
            "low_stock_items": low_stock_items,
            "total_suppliers": total_suppliers,
        }
    except Exception as e:
        current_app.logger.error(f"Error fetching dashboard metrics: {e}")
        metrics = {
            "total_stock": "N/A",
            "low_stock_items": "N/A",
            "total_suppliers": "N/A",
        }
    return render_template("dashboard_new.html", metrics=metrics)


@main_bp.route("/inventory")
@login_required
def inventory():
    return render_template("inventory.html")


@main_bp.route("/add_item", methods=["GET", "POST"])
@login_required
def add_item():
    if request.method == "POST":
        item_name = request.form.get("item_name")
        quantity = request.form.get("quantity")
        if not item_name or not quantity:
            flash("Item name and quantity are required.", "error")
            return redirect(url_for("main.add_item"))
        try:
            # Placeholder behaviour; actual DB write handled via API path.
            flash("Item added successfully!", "success")
            return redirect(url_for("main.inventory"))
        except Exception as e:
            current_app.logger.error(f"Error adding item: {e}")
            flash("Failed to add item due to a server error.", "error")
            return redirect(url_for("main.add_item"))
    return render_template("add_item.html")


@main_bp.route("/edit_item/<int:item_id>", methods=["GET"])
@login_required
def edit_item(item_id):
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            # Fetch item details
            cur.execute(
                """
                SELECT
                    im.item_id,
                    im.name,
                    im.description,
                    im.image_path,
                    m.model_id,
                    m.model_name as model_name,
                    v.variation_id,
                    v.variation_name as variation_name
                FROM item_master im
                LEFT JOIN model_master m ON im.model_id = m.model_id
                LEFT JOIN variation_master v ON im.variation_id = v.variation_id
                WHERE im.item_id = %s
            """,
                (item_id,),
            )
            item = cur.fetchone()

            if not item:
                flash("Item not found.", "error")
                return redirect(url_for("main.inventory"))

            # Fetch variants for this item
            cur.execute(
                """
                SELECT
                    iv.variant_id,
                    c.color_id,
                    c.color_name as color_name,
                    s.size_id,
                    s.size_name as size_name,
                    iv.opening_stock,
                    iv.threshold,
                    iv.unit
                FROM item_variant iv
                JOIN color_master c ON iv.color_id = c.color_id
                JOIN size_master s ON iv.size_id = s.size_id
                WHERE iv.item_id = %s
                ORDER BY c.color_name, s.size_name
            """,
                (item_id,),
            )
            variants = cur.fetchall()

        return render_template("edit_item.html", item=item, variants=variants)
    except Exception as e:
        current_app.logger.error(f"Error fetching item {item_id}: {e}")
        flash("Failed to load item details.", "error")
        return redirect(url_for("main.inventory"))


@main_bp.route("/user-management")
@login_required
@role_required("super_admin")
def user_management():
    return render_template("user_management.html")


@main_bp.route("/suppliers")
@login_required
def suppliers():
    return render_template("suppliers.html")


@main_bp.route("/purchase-orders")
@login_required
def purchase_orders():
    return render_template("purchase_orders.html")


@main_bp.route("/stock-ledger")
@login_required
def stock_ledger():
    return render_template("stock_ledger.html")


@main_bp.route("/low-stock-report")
@login_required
def low_stock_report():
    return render_template("low_stock_report.html")


@main_bp.route("/master-data")
@login_required
@role_required("admin")
def master_data():
    return render_template("master_data.html")


@main_bp.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    if request.method == "POST":
        name = request.form.get("name", current_user.name)
        company = request.form.get("company")
        mobile = request.form.get("mobile")
        file = request.files.get("profile_picture")
        profile_path = current_user.profile_picture
        if file and file.filename:
            try:
                validate_upload(
                    file,
                    user_id=current_user.id if hasattr(current_user, "id") else None,
                )
            except Exception as e:
                current_app.logger.error(f"File upload validation failed: {e}")
                flash(str(e), "error")
                return redirect(url_for("main.profile"))
            uploads_dir = os.path.join(current_app.root_path, "..", "private_uploads")
            os.makedirs(uploads_dir, exist_ok=True)
            import stat

            filename = f"{current_user.id}_{uuid.uuid4().hex[:8]}_{secure_filename(file.filename)}"
            file_path = os.path.join(uploads_dir, filename)
            file.save(file_path)
            try:
                os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)
            except Exception as e:
                current_app.logger.warning(f"Failed to set file permissions: {e}")
            profile_path = f"private_uploads/{filename}"
        try:
            with database.get_conn() as (conn, cur):
                cur.execute(
                    "UPDATE users SET name = %s, profile_picture = %s, company = %s, mobile = %s WHERE user_id = %s",
                    (name, profile_path, company, mobile, current_user.id),
                )
                conn.commit()
            flash("Profile updated successfully!", "success")
            return redirect(url_for("main.profile"))
        except Exception as e:
            current_app.logger.error(
                f"Error updating profile for user {current_user.id}: {e}"
            )
            flash("Failed to update profile due to a server error.", "error")
    return render_template("profile.html", user=current_user)


@main_bp.route("/change_password", methods=["POST"])
@login_required
def change_password():
    current_password = request.form.get("current_password")
    new_password = request.form.get("new_password")
    confirm_password = request.form.get("confirm_password")
    if not all([current_password, new_password, confirm_password]):
        flash("All password fields are required.", "error")
        return redirect(url_for("main.profile"))
    if new_password != confirm_password:
        flash("New passwords do not match.", "error")
        return redirect(url_for("main.profile"))
    ok, message = validate_password(new_password)
    if not ok:
        flash(message, "error")
        return redirect(url_for("main.profile"))
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                "SELECT password_hash FROM users WHERE user_id = %s", (current_user.id,)
            )
            user_row = cur.fetchone()
            if not user_row or not check_password_hash(
                user_row["password_hash"], current_password
            ):
                flash("Incorrect current password.", "error")
                return redirect(url_for("main.profile"))
            new_password_hash = generate_password_hash(new_password)
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE user_id = %s",
                (new_password_hash, current_user.id),
            )
            conn.commit()
        flash("Password updated successfully!", "success")
        return redirect(url_for("main.profile"))
    except Exception as e:
        current_app.logger.error(
            f"Error changing password for user {current_user.id}: {e}"
        )
        flash("An error occurred while changing your password.", "error")
        return redirect(url_for("main.profile"))


# Removed direct static serving of uploads for security. Use authenticated, access-controlled endpoints for file access.


@main_bp.route("/static/img/<filename>")
def img_file(filename):
    return send_from_directory(
        os.path.join(current_app.root_path, "static", "img"), filename
    )


# --- Compatibility routes (preserve old paths after blueprint prefix change) ---
@main_bp.route("/login")
def compat_login():
    # Serve the login page at root path for compatibility with tests
    if current_user.is_authenticated:
        return redirect(url_for("main.dashboard"))
    return render_template("login.html")


@main_bp.route("/signup")
def compat_signup():
    # Serve the signup page at root path for compatibility with tests
    return render_template("signup.html")


@main_bp.route("/forgot-password")
def compat_forgot_password():
    # Serve the forgot password page at root path for compatibility with tests
    return render_template("forgot_password.html")


# JSON API auth endpoints that used to live at /api/* without /auth prefix
@main_bp.route("/api/login", methods=["POST"])
def compat_api_login():
    from ..auth.routes import api_login

    return api_login()


@main_bp.route("/api/signup", methods=["POST"])
def compat_api_signup():
    from ..auth.routes import api_signup

    return api_signup()


@main_bp.route("/api/forgot-password", methods=["POST"])
def compat_api_forgot_password():
    from ..auth.routes import api_forgot_password

    return api_forgot_password()


# ===== Universal Process Framework Routes =====


@main_bp.route("/upf")
@main_bp.route("/upf/processes")
@login_required
def upf_unified():
    """Unified Process Framework page with all features in tabs."""
    return render_template("upf_unified.html")


@main_bp.route("/upf/process/<int:process_id>")
@login_required
def upf_process_editor(process_id):
    """Process editor page - edit process with drag-and-drop."""
    return render_template("upf_process_editor.html", process_id=process_id)


@main_bp.route("/upf/production-lot/<int:lot_id>")
@login_required
def upf_production_lot_detail(lot_id):
    """Production lot detail page - view/execute lot."""
    return render_template("upf_production_lot_detail.html", lot_id=lot_id)


@main_bp.route("/upf/production-lot/new")
@login_required
def upf_production_lot_new():
    """Create new production lot page."""
    return render_template("upf_production_lot_new.html")


@main_bp.route("/upf/production-lot/<int:lot_id>/select-variants")
@login_required
def upf_variant_selection(lot_id):
    """Variant selection page for production lot."""
    return render_template("upf_variant_selection.html", lot_id=lot_id)
