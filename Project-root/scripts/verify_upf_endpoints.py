import os
import sys

# Ensure app package is importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app


def verify_endpoints(process_id: int = 1) -> int:
    """
    Spin up a Flask test client with LOGIN_DISABLED and hit the UPF endpoints to ensure
    they return a non-500 response (verifying no SQL errors like missing columns).
    Returns non-zero if any verification fails.
    """
    # Set environment to use MTC database (matches .env DATABASE_URL)
    os.environ["DB_NAME"] = "MTC"
    os.environ["FLASK_ENV"] = "testing"

    app = create_app("testing")
    app.config.update(
        {
            "TESTING": True,
            "WTF_CSRF_ENABLED": False,
            "LOGIN_DISABLED": True,
            "SERVER_NAME": "localhost.localdomain",
            "DB_NAME": "MTC",  # Use production database that has the data
        }
    )

    paths = [
        f"/api/upf/processes/{process_id}",
        f"/api/upf/processes/{process_id}/structure",
    ]

    failures = 0
    client = app.test_client()

    for path in paths:
        resp = client.get(path)
        status = resp.status_code
        ok = status in (
            200,
            404,
        )  # 200 if exists, 404 if not found; 500 indicates server error
        print(f"GET {path} -> {status}")
        ct = resp.headers.get("Content-Type", "")
        print(f"  Content-Type: {ct}")
        # Print a small snippet of JSON when applicable
        try:
            data = resp.get_json(silent=True)
        except Exception:
            data = None
        if data is not None:
            print(f"  JSON keys: {list(data)[:8]}")
            if not ok and "message" in data:
                print(f"  Error message: {data['message']}")
        else:
            # Print a short snippet of text/HTML
            body = (resp.data or b"").decode("utf-8", errors="ignore")
            print(f"  Body preview: {body[:120].replace('\n', ' ')}")

        if not ok:
            print(f"  ERROR: Unexpected status code {status} for {path}")
            failures += 1

    return failures


if __name__ == "__main__":
    code = verify_endpoints(process_id=int(os.getenv("VERIFY_PROCESS_ID", 1)))
    if code:
        print("One or more verifications failed.")
    else:
        print("Verification passed: endpoints respond without server errors.")
    sys.exit(code)
