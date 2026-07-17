"""ERP page routes: the desktop and mobile HTML shells."""

from __future__ import annotations

import os

from flask import current_app, redirect, render_template, request, send_from_directory, url_for
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


@erp_bp.route("/erp/sw.js")
def service_worker():
    """Service worker script, served at /erp/sw.js (not /static/erp/sw.js)
    so its default scope covers /erp/* -- a service worker's max scope is
    the directory of its own script URL unless the server sends a
    Service-Worker-Allowed header, and this route sidesteps needing that.

    Deliberately not @login_required: service workers and their install-
    time fetches carry no sensitive data, and gating this route would risk
    the browser's periodic background revalidation of the script hitting a
    login redirect instead of the JS file.
    """
    static_dir = os.path.join(current_app.static_folder, "erp")
    resp = send_from_directory(static_dir, "sw.js", mimetype="application/javascript")
    # Service workers should never be aggressively HTTP-cached -- the SW's
    # own versioned-cache-name update mechanism is what should govern when
    # clients pick up a new script, not a stale browser HTTP cache entry.
    resp.headers["Cache-Control"] = "no-cache"
    # Without this header, a SW served from /erp/sw.js can only register
    # scopes starting with "/erp/" (its own script directory) -- which
    # would exclude the bare "/erp" URL (no trailing slash) that /erp's
    # own route actually uses, defeating the offline-navigation fallback
    # on the one page it matters most for. This header explicitly raises
    # the max allowed scope so registration can use scope "/erp" exactly.
    resp.headers["Service-Worker-Allowed"] = "/erp"
    return resp


@erp_bp.route("/erp/offline.html")
def offline():
    """Minimal offline fallback page the service worker serves from cache
    when a navigation request fails with no network. Not @login_required
    for the same reason as /erp/sw.js -- and because this page must still
    render for a session that expired while the device was offline.
    """
    return render_template("erp/offline.html")
