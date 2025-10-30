# MTC App

This is a Flask-based web application for managing inventory, suppliers, and purchase orders.

## Features

*   **Dashboard**: View key metrics such as total stock, low stock items, and total suppliers.
*   **Inventory Management**: Add, edit, and delete items and their variants.
*   **Supplier Management**: Manage supplier information and contacts.
*   **Purchase Orders**: Create and manage purchase orders.
*   **User Management**: Manage user roles and permissions.
*   **Google OAuth**: Securely log in with your Google account.

## Getting Started

### Prerequisites

*   Python 3.10+
*   PostgreSQL

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/your-username/MTC-App.git
    cd MTC-App
    ```

2.  **Create and activate a virtual environment:**

    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
    ```

3.  **Install the dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

4.  **Set up the database:**

    *   Create a PostgreSQL database named `MTC`.
    *   Run the migrations to create the necessary tables:

        ```bash
        python run_migration.py
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
