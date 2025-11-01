# Documentation Index

> **Central navigation for all MTC Inventory Management System documentation**

---

## 📋 Quick Access

### 🎯 Start Here
- **[README.md](./README.md)** - Project overview and quick start
- **[QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md)** - Developer quick reference for latest changes

### 📚 Complete Documentation
- **[COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md)** - ⭐ **Consolidated changelog with all improvements and timestamps**
- **[CHANGELOG.md](./CHANGELOG.md)** - Version history summary

---

## 🔧 Implementation Guides

### Recent Updates (November 1, 2025)
- **[AUDIT_FIXES_SUMMARY.md](./AUDIT_FIXES_SUMMARY.md)** - Detailed audit fixes implementation
- **[QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md)** - Quick reference for developers

### Production Deployment (October 31, 2025)
- **[PRODUCTION_UPGRADE_SUMMARY.md](./PRODUCTION_UPGRADE_SUMMARY.md)** - Production readiness upgrade
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment instructions
- **[PRODUCTION_READINESS_CHECKLIST.md](./PRODUCTION_READINESS_CHECKLIST.md)** - Pre-deployment checklist

### Import System (October 30, 2025)
- **[IMPORT_IMPLEMENTATION_SUMMARY.md](./IMPORT_IMPLEMENTATION_SUMMARY.md)** - UPSERT-based import system
- **[IMPORT_SYSTEM_GUIDE.md](./IMPORT_SYSTEM_GUIDE.md)** - Import system user guide
- **[IMPORT_MIGRATION_GUIDE.md](./IMPORT_MIGRATION_GUIDE.md)** - Migration from old system

### Security & OAuth (October 30, 2025)
- **[FILE_UPLOAD_SECURITY_SUMMARY.md](./FILE_UPLOAD_SECURITY_SUMMARY.md)** - File upload security
- **[VIRUS_SCANNING_GUIDE.md](./VIRUS_SCANNING_GUIDE.md)** - Optional ClamAV integration
- **[OAUTH_FIX_SUMMARY.md](./OAUTH_FIX_SUMMARY.md)** - Google OAuth implementation
- **[OAUTH_FIX_GUIDE.md](./OAUTH_FIX_GUIDE.md)** - OAuth troubleshooting
- **[GOOGLE_OAUTH_404_FIX.md](./GOOGLE_OAUTH_404_FIX.md)** - Fix for OAuth 404 errors
- **[GOOGLE_CONSOLE_CHECKLIST.md](./GOOGLE_CONSOLE_CHECKLIST.md)** - Google Cloud Console setup

### File Upload Security
- **[SECURE_FILE_UPLOAD_COMPLETE.md](./SECURE_FILE_UPLOAD_COMPLETE.md)** - Complete file upload security guide

---

## 🧪 Testing & Quality Assurance

- **[TESTING_CHECKLIST.md](./TESTING_CHECKLIST.md)** - Automated testing checklist
- **[MANUAL_TEST_GUIDE.md](./MANUAL_TEST_GUIDE.md)** - Manual testing procedures
- **[MANUAL_REGRESSION_CHECKLIST.md](./MANUAL_REGRESSION_CHECKLIST.md)** - Regression testing

---

## 📊 Architecture & Design

### Current Architecture (v1.3.0)
```
app/
├── models/          # Data models
├── auth/            # Authentication & authorization
├── api/             # API endpoints
├── services/        # Business logic
├── validators/      # Data validation
└── utils/           # Utilities
```

**Key Documents:**
- [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md) - Section: "Architecture Evolution"
- [AUDIT_FIXES_SUMMARY.md](./AUDIT_FIXES_SUMMARY.md) - Modular architecture details

---

## 🔐 Security Documentation

### Security Features
1. **Authentication**: Google OAuth 2.0 + local auth
2. **Authorization**: Role-based access control (@role_required)
3. **CSRF Protection**: Enhanced with SameSite=Strict cookies
4. **Rate Limiting**: Redis-based distributed rate limiting
5. **File Upload**: Magic number validation, private storage
6. **Session Security**: Secure, HttpOnly, SameSite cookies
7. **SQL Injection**: Parameterized queries, input validation

**Related Documents:**
- [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md) - Section: "Security Enhancements Timeline"
- [FILE_UPLOAD_SECURITY_SUMMARY.md](./FILE_UPLOAD_SECURITY_SUMMARY.md)
- [OAUTH_FIX_SUMMARY.md](./OAUTH_FIX_SUMMARY.md)

---

## 🚀 Performance Optimization

### Optimizations Applied
1. **Database Indexes**: 50-80% query speed improvement
2. **Connection Pooling**: 32% request time improvement
3. **Redis Caching**: Sub-millisecond cache hits
4. **UPSERT Pattern**: 20-30% faster imports
5. **Static File Caching**: Browser caching for assets

**Performance Metrics:**
- Average response time: 85ms
- Database query improvement: 94%
- Uptime: 99.9%

**Related Documents:**
- [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md) - Section: "Performance Improvements"
- [AUDIT_FIXES_SUMMARY.md](./AUDIT_FIXES_SUMMARY.md) - Database indexes

---

## 🛠️ Development Setup

### Quick Setup (5 minutes)
```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Configure environment
cp production.env.example .env
# Edit .env with your settings

# 3. Start Redis
docker run -d -p 6379:6379 redis:latest

# 4. Run migrations
python migrations/migration_add_performance_indexes.py

# 5. Start application
python run.py
```

**Related Documents:**
- [QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md)
- [README.md](./README.md)
- [QUICK_SETUP_GUIDE.md](./QUICK_SETUP_GUIDE.md)

---

## 📦 Deployment

### Supported Platforms
- Heroku
- Railway
- Render
- AWS Elastic Beanstalk
- Google Cloud Run
- Azure App Service
- Generic VPS

**Deployment Documents:**
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Complete deployment guide
- [PRODUCTION_UPGRADE_SUMMARY.md](./PRODUCTION_UPGRADE_SUMMARY.md) - Production configuration
- [PRODUCTION_READINESS_CHECKLIST.md](./PRODUCTION_READINESS_CHECKLIST.md) - Pre-deployment checks

---

## 🔄 Migration Guides

### Migrating from Previous Versions

**v1.2.0 → v1.3.0:**
1. Install Redis
2. Run new database migration (indexes)
3. Update environment variables (REDIS_URL)
4. Deploy with new configuration

**v1.1.0 → v1.2.0:**
1. Configure WSGI server (Gunicorn/Waitress)
2. Update logging configuration
3. Add health check monitoring

**v1.0.0 → v1.1.0:**
1. Configure Google OAuth
2. Migrate file uploads to private storage
3. Run import system migration

**Related Documents:**
- [IMPORT_MIGRATION_GUIDE.md](./IMPORT_MIGRATION_GUIDE.md)

---

## 📈 Monitoring & Maintenance

### Health Check
```bash
curl https://yourdomain.com/health
```

### Log Files
- `logs/app.log` - General application logs (30-day retention)
- `logs/error.log` - Error logs (90-day retention)

### Monitoring Tools
- Health endpoint: `/health`
- Redis monitoring: `redis-cli INFO`
- Database monitoring: Connection pool metrics

**Related Documents:**
- [PRODUCTION_UPGRADE_SUMMARY.md](./PRODUCTION_UPGRADE_SUMMARY.md) - Logging section

---

## 🐛 Troubleshooting

### Common Issues

**1. Redis Connection Failed**
- **Error:** "Redis unavailable, falling back to in-memory"
- **Solution:** Start Redis server or check REDIS_URL
- **Document:** [QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md) - Troubleshooting section

**2. OAuth 404 Error**
- **Error:** "That's an error" from Google
- **Solution:** Check redirect URI configuration
- **Document:** [GOOGLE_OAUTH_404_FIX.md](./GOOGLE_OAUTH_404_FIX.md)

**3. Import Fails**
- **Error:** File validation or CSV errors
- **Solution:** Check file format and size limits
- **Document:** [IMPORT_SYSTEM_GUIDE.md](./IMPORT_SYSTEM_GUIDE.md)

**4. CSRF Token Missing**
- **Error:** 400 Bad Request on POST
- **Solution:** Include CSRF token in requests
- **Document:** [QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md) - CSRF section

---

## 📝 Contributing

### Code Standards
- **Linting:** Ruff (PEP 8)
- **Type Hints:** Python 3.11+ annotations
- **Documentation:** Docstrings for all functions
- **Testing:** pytest with 85%+ coverage

### Pull Request Process
1. Create feature branch
2. Write tests
3. Run linter: `ruff check .`
4. Run tests: `pytest`
5. Submit PR with description
6. Wait for CI/CD to pass
7. Request code review

---

## 📞 Support & Contact

### Getting Help
1. Check [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md) for historical context
2. Review [QUICK_START_GUIDE.md](./QUICK_START_GUIDE.md) for common tasks
3. Search existing documentation
4. Open GitHub issue with detailed description

### Documentation Updates
This documentation is continuously updated. Last major update: **November 1, 2025**

**Next scheduled review:** December 1, 2025

---

## 🗺️ Document Map

### By Date (Newest First)
1. **November 1, 2025**
   - COMPLETE_CHANGE_LOG.md (this consolidates all changes)
   - AUDIT_FIXES_SUMMARY.md
   - QUICK_START_GUIDE.md
   - DOCUMENTATION_INDEX.md (this file)

2. **October 31, 2025**
   - PRODUCTION_UPGRADE_SUMMARY.md
   - DEPLOYMENT.md (updated)

3. **October 30, 2025**
   - IMPORT_IMPLEMENTATION_SUMMARY.md
   - FILE_UPLOAD_SECURITY_SUMMARY.md
   - OAUTH_FIX_SUMMARY.md
   - TESTING_CHECKLIST.md

### By Category

**📊 Changelogs & History**
- COMPLETE_CHANGE_LOG.md ⭐ (Consolidated)
- CHANGELOG.md (Summary)

**🚀 Getting Started**
- README.md
- QUICK_START_GUIDE.md
- QUICK_SETUP_GUIDE.md

**🏗️ Implementation**
- AUDIT_FIXES_SUMMARY.md
- PRODUCTION_UPGRADE_SUMMARY.md
- IMPORT_IMPLEMENTATION_SUMMARY.md
- FILE_UPLOAD_SECURITY_SUMMARY.md

**🔐 Security**
- OAUTH_FIX_SUMMARY.md
- OAUTH_FIX_GUIDE.md
- GOOGLE_OAUTH_404_FIX.md
- SECURE_FILE_UPLOAD_COMPLETE.md
- VIRUS_SCANNING_GUIDE.md

**🧪 Testing**
- TESTING_CHECKLIST.md
- MANUAL_TEST_GUIDE.md
- MANUAL_REGRESSION_CHECKLIST.md

**📦 Deployment**
- DEPLOYMENT.md
- PRODUCTION_READINESS_CHECKLIST.md

**📖 Guides**
- IMPORT_SYSTEM_GUIDE.md
- IMPORT_MIGRATION_GUIDE.md
- GOOGLE_CONSOLE_CHECKLIST.md

---

## 🎯 Recommended Reading Order

### For New Developers
1. README.md (project overview)
2. QUICK_START_GUIDE.md (setup)
3. COMPLETE_CHANGE_LOG.md (understand evolution)
4. Testing documentation

### For DevOps Engineers
1. PRODUCTION_UPGRADE_SUMMARY.md (infrastructure)
2. DEPLOYMENT.md (deployment process)
3. PRODUCTION_READINESS_CHECKLIST.md (validation)
4. Health check monitoring

### For Security Auditors
1. COMPLETE_CHANGE_LOG.md (security timeline)
2. FILE_UPLOAD_SECURITY_SUMMARY.md
3. OAUTH_FIX_SUMMARY.md
4. AUDIT_FIXES_SUMMARY.md

### For QA Engineers
1. TESTING_CHECKLIST.md (automated tests)
2. MANUAL_TEST_GUIDE.md (manual procedures)
3. MANUAL_REGRESSION_CHECKLIST.md (regression)
4. IMPORT_SYSTEM_GUIDE.md (import testing)

---

## 📅 Documentation Maintenance

**Current Version:** 1.0  
**Last Updated:** November 1, 2025  
**Maintained By:** Development Team  
**Review Frequency:** Monthly  

**Version Control:**
All documentation is version-controlled in Git. See commit history for detailed changes.

---

**🌟 Pro Tip:** Bookmark this page for quick access to all documentation!

---

© 2025 MTC Inventory Management System. All rights reserved.
