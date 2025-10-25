# MTC Inventory Management System

A secure, performant Flask-based inventory management system with PostgreSQL backend.

## ✨ Features

- 🔐 Secure authentication (Google OAuth + Manual)
- 📦 Complete inventory management (items, variants, stock tracking)
- 🏭 Supplier management with contact tracking
- 📝 Purchase order creation and management
- 📊 Low stock reporting
- 📁 CSV/Excel data import
- 👥 User role management (Super Admin, Admin, User)
- 🎨 Dark mode support
- 📱 Fully responsive design

## 🔒 Security Features

- ✅ SQL injection protection
- ✅ CSRF protection on all forms
- ✅ File upload validation
- ✅ Rate limiting on sensitive endpoints
- ✅ Strong password requirements
- ✅ HTTPS enforcement (production)
- ✅ Secure session management

## 🚀 Installation

### Prerequisites
- Python 3.9+
- PostgreSQL 13+
- pip

### Setup

1. **Clone repository**
```bash
git clone https://github.com/sajan1310/MTC.git
cd MTC/Project-root
```

2. **Create virtual environment**
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. **Install dependencies**
```bash
pip install -r requirements.txt
```

4. **Configure environment variables**
```bash
cp .env.example .env
# Edit .env with your database credentials and secrets
```

5. **Run database migrations**
```bash
cd migrations
python run_migration.py
cd ..
```

6. **Start application**
```bash
python app.py
```

7. **Access application**
Open browser to http://127.0.0.1:5000

## 📋 Environment Variables

Required in `.env` file:

```env
# Database Configuration
DB_HOST=127.0.0.1
DB_NAME=MTC
DB_USER=postgres
DB_PASS=Sajan@1995

# Flask Configuration
FLASK_SECRET_KEY=your_secret_key_here
FLASK_ENV=development  # or production

# Google OAuth (Optional)
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# Database Pool (Optional)
DB_POOL_MIN=2
DB_POOL_MAX=20
```

## 🏗️ Project Structure

```
Project-root/
├── app.py                  # Main Flask application
├── config.py               # Configuration management
├── database.py             # Database connection pool
├── requirements.txt        # Python dependencies
├── .env                    # Environment variables (not in git)
├── migrations/             # Database migrations
│   ├── add_indexes.sql
│   └── run_migration.py
├── static/
│   ├── app.js             # Frontend JavaScript
│   ├── styles.css         # CSS styles
│   └── uploads/           # User uploaded files
└── templates/             # HTML templates
    ├── base.html
    ├── inventory.html
    ├── add_item.html
    └── ...
```

## 🧪 Testing

Run complete test suite:

```bash
# See TESTING_CHECKLIST.md for detailed testing procedures
cat TESTING_CHECKLIST.md
```

## 🔧 Performance Optimizations

- Database connection pooling (2-20 connections)
- Query optimization with strategic indexes
- Debounced search (300ms delay)
- Lazy loading for large datasets
- DOM update batching with requestAnimationFrame

## 📊 Database Schema

See `migrations/` directory for complete schema definition.

Key tables:
- `users` - User accounts and roles
- `item_master` - Product catalog
- `item_variant` - Product variants (color, size)
- `suppliers` - Supplier information
- `purchase_orders` - PO management
- `stock_entries` - Stock movement tracking

## 🐛 Troubleshooting

**Database connection error:**
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Verify credentials in .env
psql -h 127.0.0.1 -U postgres -d MTC
```

**Import modal not showing:**
```bash
# Check browser console for JavaScript errors
# Verify app.js loaded correctly
```

**File upload rejected:**
```bash
# Ensure file is PNG, JPG, JPEG, GIF, or WEBP
# Check file size < 5MB
```

## 📝 License

Proprietary - All rights reserved

## 👨‍💻 Author

Sajan Sontakke (@sajan1310)

## 🔄 Version History

### v2.0.0 (2025-10-25) - Security & Performance Update
- ✅ Fixed SQL injection vulnerabilities
- ✅ Added file upload validation
- ✅ Implemented rate limiting
- ✅ Optimized database queries
- ✅ Added password strength requirements
- ✅ Improved error handling
- ✅ Enhanced frontend performance

### v1.0.0 (2025-10-01) - Initial Release
- Basic inventory management
- User authentication
- Supplier management
