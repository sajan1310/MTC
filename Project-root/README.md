# MTC Inventory Management System

> **Production-ready inventory management with advanced security, performance optimization, and scalability**

[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![Flask 3.0](https://img.shields.io/badge/flask-3.0-green.svg)](https://flask.palletsprojects.com/)
[![PostgreSQL 14](https://img.shields.io/badge/postgresql-14-blue.svg)](https://www.postgresql.org/)
[![Redis 5.0](https://img.shields.io/badge/redis-5.0-red.svg)](https://redis.io/)
[![Test Coverage](https://img.shields.io/badge/coverage-89%25-brightgreen.svg)](./TESTING_CHECKLIST.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📚 Documentation

**📖 Complete Documentation:** [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md) - Consolidated changelog with all improvements and timestamps  
**🗂️ Documentation Index:** [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md) - Navigate all documentation  
**🚀 Quick Start:** [QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md) - Developer quick reference  

---

## ✨ Key Features

### Core Functionality
- 📦 **Inventory Management** - Items, variants, stock tracking
- 👥 **Supplier Management** - Contacts, rates, ledger
- 📋 **Purchase Orders** - Create, track, receive orders
- 📊 **Stock Ledger** - Complete transaction history
- 👤 **User Management** - Role-based access control

### Advanced Features (v1.3.0)
- 🔐 **Google OAuth 2.0** - Secure authentication
- 🚀 **Redis Rate Limiting** - Multi-instance ready
- 📈 **Performance Optimized** - 50-80% faster queries
- 🏗️ **Modular Architecture** - Blueprint-based design
- 🧪 **CI/CD Pipeline** - Automated testing with GitHub Actions
- 🔒 **Enterprise Security** - CSRF, file validation, audit logging

---

## 🚀 Quick Start

### Prerequisites
- Python 3.11+
- PostgreSQL 14+
- Redis 5.0+ (optional, recommended for production)

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-username/MTC-App.git
    cd MTC-App
    ```

2.  **Create and activate a virtual environment:**

    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows, use `venv\\Scripts\\activate`
    ```

3.  **Install system-level dependencies for python-magic:**

    - **Linux:**
        ```bash
        sudo apt-get install libmagic1
        ```
    - **macOS:**
        ```bash
        brew install libmagic
        ```
    - **Windows:**
        - python-magic will use a bundled DLL, but if you encounter issues, see https://github.com/ahupp/python-magic#installation for troubleshooting.

4.  **Install the dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

    > **Note:** `python-magic` is a hard requirement for secure file uploads. The application will not run without it.

5.  **Set up the database:**

    *   Create a PostgreSQL database named `MTC`.
    *   Run the migrations to create the necessary tables:

        ```bash
        python run_migration.py
        ```

6.  **Configure environment variables:**

    *   Copy the `.env.example` file to `.env`:

        ```bash
        cp .env.example .env
        ```

    *   Open the `.env` file and fill in the required values, including your database credentials and Google OAuth client ID and secret.

### Running the Application

```bash
flask run
```

The application will be available at `http://127.0.0.1:5000`.
        ```

5.  **Configure environment variables:**

    *   Copy the `.env.example` file to `.env`:

        ```bash
        cp .env.example .env
        ```

    *   Open the `.env` file and fill in the required values, including your database credentials and Google OAuth client ID and secret.

### Running the Application

```bash
flask run
```

The application will be available at `http://127.0.0.1:5000`.

## Google OAuth Configuration

1.  **Go to the Google Cloud Console:** [https://console.cloud.google.com/](https://console.cloud.google.com/)
2.  **Create a new project** or select an existing one.
3.  **Go to "APIs & Services" > "Credentials".**
4.  **Click "Create Credentials" > "OAuth client ID".**
5.  **Select "Web application"** as the application type.
6.  **Under "Authorized redirect URIs", add the following URL:**

    ```
    http://127.0.0.1:5000/auth/google/callback
    ```

7.  **Click "Create"** and copy the "Client ID" and "Client Secret".
8.  **Add the credentials to your `.env` file:**

    ```
    GOOGLE_CLIENT_ID="your_google_client_id"
    GOOGLE_CLIENT_SECRET="your_google_client_secret"
    ```

## Running the Tests

```bash
python -m pytest
