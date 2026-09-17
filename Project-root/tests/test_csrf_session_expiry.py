"""An expired session must read as "signed out", not as a CSRF rejection.

flask-wtf raises CSRFError for several unrelated conditions and gives them
all 400. One of them is not a CSRF failure at all: "The CSRF session token is
missing" means the request carried no session, so there is nothing to forge
against and nothing the user did wrong.

Reported from the factory floor. A phone left on /erp/mobile past the 24h
PERMANENT_SESSION_LIFETIME showed "CSRF Token missing" and loaded nothing.
The service worker kept serving the cached shell, so the app never navigated
anywhere that would have revealed the session was gone, and api.js only
recognises 401 as "signed out" -- the 400 fell through to its generic HTTP
branch, which reports that the call failed but not that signing in would fix
it. A dead screen with no action on it.
"""

from __future__ import annotations

import pytest
from flask_wtf.csrf import CSRFError

NO_SESSION = "The CSRF session token is missing."
TOKEN_MISMATCH = "The CSRF tokens do not match."


@pytest.fixture
def csrf_client(app):
    """Routes that raise each CSRFError flavour, dispatched by Flask for real.

    Raising through the app rather than calling the handler directly is the
    point: it exercises the registered errorhandler and the response Flask
    actually builds from it.
    """

    @app.route("/api/_raises_no_session", methods=["POST"])
    def _api_no_session():
        raise CSRFError(NO_SESSION)

    @app.route("/api/_raises_mismatch", methods=["POST"])
    def _api_mismatch():
        raise CSRFError(TOKEN_MISMATCH)

    @app.route("/page/_raises_no_session", methods=["POST"])
    def _page_no_session():
        raise CSRFError(NO_SESSION)

    @app.route("/page/_raises_mismatch", methods=["POST"])
    def _page_mismatch():
        raise CSRFError(TOKEN_MISMATCH)

    return app.test_client()


class TestSessionMissing:
    """No session at all -- the user is signed out."""

    def test_api_answers_401_not_400(self, csrf_client):
        """401 is the one status api.js knows how to recover from."""
        response = csrf_client.post("/api/_raises_no_session")

        assert response.status_code == 401

    def test_api_message_tells_the_user_what_to_do(self, csrf_client):
        """Word for word what _unauthorized() says. The two describe the same
        state, and a user should not get two different explanations of it."""
        body = csrf_client.post("/api/_raises_no_session").get_json()

        assert body["success"] is False
        assert body["message"] == "Your session has expired. Please sign in again."

    def test_api_envelope_matches_every_other_rpc_failure(self, csrf_client):
        body = csrf_client.post("/api/_raises_no_session").get_json()

        assert set(body) >= {"success", "data", "message"}
        assert body["data"] is None

    def test_a_page_is_sent_to_the_login_screen(self, csrf_client):
        """Not the 500 page. Being signed out is not a server error, and a
        500 gives the user nothing to act on."""
        response = csrf_client.post("/page/_raises_no_session")

        assert response.status_code == 302
        assert "/auth/login" in response.headers["Location"]


class TestGenuineCsrfFailure:
    """Everything else is a real rejection and keeps its 400.

    This is the half that must not move. Turning a token mismatch into a 401
    would tell an attacker's victim to go and sign in again, which is the
    opposite of what a CSRF defence is for.
    """

    def test_api_token_mismatch_is_still_400(self, csrf_client):
        response = csrf_client.post("/api/_raises_mismatch")

        assert response.status_code == 400

    def test_api_token_mismatch_is_not_reported_as_a_session_problem(self, csrf_client):
        body = csrf_client.post("/api/_raises_mismatch").get_json()

        assert "sign in again" not in body["message"].lower()
        assert "CSRF" in body["message"]

    def test_page_token_mismatch_does_not_redirect(self, csrf_client):
        """A redirect here would hand a genuine CSRF attempt a login page."""
        response = csrf_client.post("/page/_raises_mismatch")

        assert response.status_code == 400
