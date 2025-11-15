#!/usr/bin/env python3
"""
Smoke test for UPF variant endpoints.

Usage examples:
  python scripts\smoke_variant_endpoints.py --base http://localhost:5000 --lot 1
  python scripts\smoke_variant_endpoints.py --base http://localhost:5000 --lot 1 --variant 53011 --group 3 --quantity 1

Notes:
- If your dev server requires auth, pass a bearer token with `--token TOKEN`.
- This script prints status codes and JSON (if available).
"""

import argparse
import json
import sys

try:
    import requests
except Exception:
    requests = None


def pretty_print(prefix, resp):
    try:
        text = resp.text
        try:
            j = resp.json()
            body = json.dumps(j, indent=2)
        except Exception:
            body = text
    except Exception:
        body = "<no body>"
    print(f"{prefix} -> status: {resp.status_code}\n{body}\n")


def do_get(session, url):
    if requests:
        return session.get(url)
    else:
        # minimal fallback
        from urllib.request import Request, urlopen

        req = Request(url)
        for k, v in session.headers.items():
            req.add_header(k, v)
        try:
            with urlopen(req) as r:
                status = r.getcode()
                data = r.read().decode("utf-8")

                class R:
                    status_code = status
                    text = data

                    def json(self):
                        return json.loads(self.text)

                return R()
        except Exception as e:
            raise


def do_post(session, url, payload):
    if requests:
        return session.post(url, json=payload)
    else:
        from urllib.request import Request, urlopen

        data = json.dumps(payload).encode("utf-8")
        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        for k, v in session.headers.items():
            req.add_header(k, v)
        try:
            with urlopen(req) as r:
                status = r.getcode()
                body = r.read().decode("utf-8")

                class R:
                    status_code = status
                    text = body

                    def json(self):
                        return json.loads(self.text)

                return R()
        except Exception as e:
            raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://localhost:5000", help="Base URL of server")
    p.add_argument("--lot", type=int, required=True, help="Production lot id")
    p.add_argument(
        "--variant", type=str, help="Variant id to select (numeric or string)"
    )
    p.add_argument("--group", type=int, help="Substitute group id (optional)")
    p.add_argument("--quantity", type=float, default=1, help="Quantity to select")
    p.add_argument("--token", help="Bearer token for Authorization header (optional)")
    args = p.parse_args()

    base = args.base.rstrip("/")
    lot_id = args.lot

    headers = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    # Use requests.Session if available
    if requests:
        session = requests.Session()
        session.headers.update(headers)
    else:

        class Sess:
            headers = headers

        session = Sess()

    # GET variant options
    vopts_url = f"{base}/api/upf/production-lots/{lot_id}/variant_options"
    print(f"GET {vopts_url}")
    try:
        resp = do_get(session, vopts_url)
        pretty_print("variant_options", resp)
    except Exception as e:
        print("GET variant_options failed:", e)
        sys.exit(1)

    # If variant not provided, suggest one from response if possible
    chosen_variant = args.variant
    if not chosen_variant:
        try:
            j = resp.json()
            payload = j.get("data") or j
            subs = payload.get("subprocesses") if isinstance(payload, dict) else None
            # Try to find a standalone variant id
            if subs:
                for sp in subs:
                    sv = sp.get("standalone_variants") or []
                    if sv:
                        first = sv[0]
                        vid = (
                            first.get("item_id")
                            or first.get("variant_id")
                            or first.get("usage_id")
                            or first.get("id")
                        )
                        if vid:
                            chosen_variant = str(vid)
                            print(
                                "Auto-picked variant id from variant_options:",
                                chosen_variant,
                            )
                            break
        except Exception:
            pass

    if not chosen_variant:
        print(
            "No variant supplied and none auto-detected; skipping select-variant POST."
        )
        return

    post_url = f"{base}/api/upf/production-lots/{lot_id}/select-variant"
    payload = {
        # include both keys for compatibility with various API versions
        "selected_variant_id": (
            int(chosen_variant) if chosen_variant.isdigit() else chosen_variant
        ),
        "variant_id": (
            int(chosen_variant) if chosen_variant.isdigit() else chosen_variant
        ),
        "quantity": args.quantity,
    }
    if args.group:
        payload["substitute_group_id"] = args.group

    print(f"POST {post_url} with payload: {json.dumps(payload)}")
    try:
        resp2 = do_post(session, post_url, payload)
        pretty_print("select-variant", resp2)
    except Exception as e:
        print("POST select-variant failed:", e)
        sys.exit(2)


if __name__ == "__main__":
    main()
