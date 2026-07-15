"""ERP page routes: the desktop and mobile HTML shells."""

from __future__ import annotations

from flask import redirect, render_template, request, url_for
from flask_login import login_required

from . import erp_bp


@erp_bp.route("/erp")
@login_required
def index():
    """Desktop ERP shell, or redirect to the mobile shell via ?ui=mobile."""
    if request.args.get("ui") == "mobile":
        return redirect(url_for("erp.mobile"))
    return render_template("erp/index.html")


@erp_bp.route("/erp/mobile")
@login_required
def mobile():
    """Mobile ERP shell."""
    return render_template("erp/mobile.html")
