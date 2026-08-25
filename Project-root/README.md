# Maharaja Bikes ERP

> **Manufacturing tracking & costing ERP** — vendors, purchase orders, stock, production, dispatch, billing, and returns, with an installable offline-first mobile PWA for the shop floor.

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![Flask 3.0](https://img.shields.io/badge/flask-3.0-green.svg)](https://flask.palletsprojects.com/)
[![PostgreSQL 14](https://img.shields.io/badge/postgresql-14-blue.svg)](https://www.postgresql.org/)
[![Redis 5.0](https://img.shields.io/badge/redis-5.0-red.svg)](https://redis.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What this is

A single Flask application (`app/erp/`) serving two front ends against the same
database and business-logic layer:

- **Desktop shell** (`/erp`) — a single-page, tab-based app covering Dashboard,
  Purchase Orders, Bill Ledger, Returns, Items Master, Vendors, Stock, Products
  & Processes, Contractors, Production, Dispatch, and Clients.
- **Mobile shell** (`/erp/mobile`) — an installable, offline-first PWA for the
  shop floor: read caching, a mutation outbox with replay/reconciliation for
  all 5 offline mutation types, and Background Sync.

Both shells talk to the same RPC layer (`/api/erp`, see `app/erp/rpc.py`) and
the same service modules under `app/erp/services/`.

---

## Key Features

- 📦 **Items, Vendors, Stock** — masters, ledgers, low-stock alerts
- 📋 **Purchase Orders & Bills** — create, receive, reconcile
- 🏭 **Production & Products/Processes** — BOM, process pipeline, colorwise summaries
- 🚚 **Dispatch, Clients, Contractors, Returns & Wastage**
- 📱 **Offline-first mobile PWA** — installable, works with no network, syncs when back online
- 🔐 **Google OAuth 2.0** authentication
- 🚀 **Redis-backed rate limiting**, CSRF protection, audit logging

---

## Quick Start

### Prerequisites
- Python 3.11+
- PostgreSQL 14+
- Redis 5.0+ (optional, recommended for production rate limiting)

### Installation

1. **Clone the repository and create a virtual environment:**

    ```bash
    git clone <repo-url>
    cd MTC/Project-root
    python -m venv .venv
    source .venv/bin/activate  # On Windows: .venv\Scripts\activate
    ```

2. **Install dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

3. **Set up the database:**

    ```bash
    python migrations/erp/runner.py
    ```

4. **Configure environment variables:**

    ```bash
    cp .env.example .env
    ```

    Fill in your database credentials and Google OAuth client ID/secret.

### Running the Application

```bash
flask run
```

The app is available at `http://127.0.0.1:5000` — `/` redirects to `/erp`
(and to `/auth/login` if you're not signed in yet).

---

## Google OAuth Configuration

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Go to **APIs & Services > Credentials**.
4. Click **Create Credentials > OAuth client ID**, select **Web application**.
5. Under **Authorized redirect URIs**, add:

    ```
    http://127.0.0.1:5000/auth/google/callback
    ```

6. Copy the Client ID and Secret into your `.env` file:

    ```
    GOOGLE_CLIENT_ID="your_google_client_id"
    GOOGLE_CLIENT_SECRET="your_google_client_secret"
    ```

---

## Running the Tests

```bash
python -m pytest
npm test    # frontend JS tests for static/erp/
```

## Response Envelope

The `/api/erp` RPC layer returns a consistent envelope
(`app/erp/envelope.py`):

```json
{
    "success": true,
    "data": {"items": []},
    "message": "OK"
}
```

## Testing on Windows (PowerShell)

From the repository root:

```powershell
python -m venv venv2
& .\venv2\Scripts\Activate.ps1

pip install -r Project-root\requirements.txt
cd Project-root
python -m pytest -q
```

Notes:
- Rate limiting uses Redis in production; tests automatically use in-memory
  storage to avoid external dependencies.
- Some endpoints enforce authentication in production but are open under
  `TESTING` to keep the suite fast and deterministic.
