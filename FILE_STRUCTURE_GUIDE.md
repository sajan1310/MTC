# 📂 File Structure Guide

**Understanding the MTC project organization**

---

## 🎯 Main Folders - What Goes Where

```
MTC Project Root/
│
├── 📚 docs/                    ← ALL DOCUMENTATION
│   ├── README.md               (Documentation hub)
│   ├── getting-started/        (Setup & installation)
│   ├── api/                    (API reference)
│   ├── development/            (Dev guides)
│   ├── deployment/             (Deployment guides)
│   ├── features/               (Feature docs)
│   └── troubleshooting/        (Fixes & solutions)
│
├── 🔧 utilities/               ← HELPER SCRIPTS
│   ├── README.md               (Utilities guide)
│   ├── verification/           (Setup verification)
│   ├── auditors/               (Code quality tools)
│   ├── repairs/                (Auto-fix scripts)
│   └── database/               (Database utilities)
│
├── 📦 Project-root/            ← APPLICATION CODE
│   ├── app/                    (Flask application)
│   ├── tests/                  (Test suite)
│   ├── migrations/             (Database migrations)
│   ├── static/                 (Frontend files)
│   └── requirements.txt        (Dependencies)
│
├── 🔄 .github/                 ← CI/CD WORKFLOWS
│   └── workflows/              (GitHub Actions)
│
├── 📋 scripts/                 ← DEVELOPMENT SCRIPTS
│
├── 🗃️ archive/                 ← OLD FILES (reference only)
│   └── README.md               (Archive guide)
│
├── 📄 ROOT DOCUMENTATION       ← KEY STARTING POINTS
│   ├── README.md               ← START HERE (structure overview)
│   ├── START_HERE_DOCUMENTATION.md  ← Project intro
│   ├── QUICK_NAVIGATION.md     (Find docs by role)
│   ├── DOCUMENTATION_MASTER_INDEX.md (Complete index)
│   └── DOCUMENTATION_QUICK_REFERENCE_CARD.md (Printable)
│
└── ⚙️ CONFIG FILES
    ├── pytest.ini              (Test configuration)
    ├── .env.example            (Environment template)
    └── .pre-commit-config.yaml (Pre-commit hooks)
```

---

## 📍 Root Level Files - Quick Reference

| File | Purpose | When to Use |
|------|---------|-----------|
| **README.md** | 🚀 Structure overview | First - understand layout |
| **START_HERE_DOCUMENTATION.md** | 📖 Project introduction | Learn what MTC is |
| **QUICK_NAVIGATION.md** | 🗺️ Find docs by role | Daily lookups |
| **DOCUMENTATION_MASTER_INDEX.md** | 📚 Complete index | Full exploration |
| **DOCUMENTATION_QUICK_REFERENCE_CARD.md** | 📌 Printable reference | Quick printout |
| **.env.example** | ⚙️ Environment setup | Configuration |
| **pytest.ini** | 🧪 Test settings | Running tests |

---

## 🗂️ Folder-by-Folder Breakdown

### **docs/** - All Documentation
```
docs/
├── getting-started/    Installation, setup, first run
├── api/                API endpoints, request/response
├── development/        Code patterns, backend guide
├── deployment/         Production deployment, CI/CD
├── features/           Production lot, subprocesses
└── troubleshooting/    Fixes, errors, FAQ
```

**When to use:** Look here for any documentation

---

### **utilities/** - Tools & Scripts
```
utilities/
├── verification/       Run VERIFY_IMPLEMENTATION.py
├── auditors/          Code quality analysis
├── repairs/           Auto-fix scripts
└── database/          Database utilities
```

**When to use:** Need a helper script? Check here

---

### **Project-root/** - Main Application
```
Project-root/
├── app/               The Flask application
├── tests/             All test files
├── migrations/        Database migrations
└── static/            Frontend/static files
```

**When to use:** Actual coding work

---

### **.github/workflows/** - CI/CD
```
.github/
└── workflows/         GitHub Actions workflows
```

**When to use:** Check CI/CD configuration

---

### **scripts/** - Development Scripts
```
scripts/               Various development scripts
```

**When to use:** Build, setup, or utility scripts

---

### **archive/** - Historical Files
```
archive/               Old documentation & files
```

**When to use:** Reference only - for historical context

---

## 🎯 Common Workflows - Where to Look

### "I'm new, what do I do?"
```
1. README.md (this folder structure)
2. START_HERE_DOCUMENTATION.md (project intro)
3. docs/getting-started/README.md (setup)
```

### "I need to add a feature"
```
1. docs/development/BACKEND_IMPLEMENTATION_GUIDE.md
2. docs/api/API_ENDPOINTS_COMPLETE.md
3. Project-root/app/ (start coding)
```

### "I need to deploy"
```
1. docs/deployment/DEPLOYMENT_GUIDE.md
2. utilities/verification/VERIFY_IMPLEMENTATION.py (verify first)
3. .github/workflows/ (check CI/CD)
```

### "Something is broken"
```
1. docs/troubleshooting/QUICK_FIX_GUIDE.md
2. utilities/ (find a tool to fix it)
3. docs/troubleshooting/ISSUES_RESOLVED.md
```

### "I want to verify setup"
```
1. utilities/verification/VERIFY_IMPLEMENTATION.py
2. Run: python utilities/verification/VERIFY_IMPLEMENTATION.py
```

---

## ✅ File Organization Rules

- **Documentation:** Always in `docs/` folder
- **Scripts:** Verification & tools in `utilities/`
- **Code:** Work in `Project-root/app/`
- **Tests:** Add to `Project-root/tests/`
- **Old Docs:** Move to `archive/` folder
- **CI/CD:** Configure in `.github/workflows/`

---

## 🚫 What NOT to Do

❌ **Don't:**
- Keep docs in root (move to `docs/`)
- Mix code and documentation
- Leave random scripts around (move to `utilities/`)
- Keep old files in root (move to `archive/`)

✅ **Do:**
- Keep root clean (only key docs)
- Organize by category
- Use folder structure consistently
- Move old files to archive

---

## 📊 File Statistics

| Folder | Type | Count |
|--------|------|-------|
| `docs/` | Documentation | ~50+ |
| `utilities/` | Scripts | ~10+ |
| `Project-root/app/` | Code | Multiple files |
| `Project-root/tests/` | Tests | 40+ tests |
| Root | Key docs | ~15 |
| `archive/` | Historical | Many |

---

## 🔍 Finding Files

### By Purpose

| Purpose | Location |
|---------|----------|
| Learn the project | `START_HERE_DOCUMENTATION.md` + `docs/` |
| Write code | `Project-root/app/` |
| Run tests | `Project-root/tests/` |
| Deploy | `docs/deployment/` |
| Fix issues | `docs/troubleshooting/` or `utilities/` |
| Verify setup | `utilities/verification/` |

### By Role

| Role | Start Location |
|------|-----------------|
| Backend Dev | `docs/development/` |
| Frontend Dev | `docs/features/` |
| DevOps | `docs/deployment/` |
| QA/Tester | `Project-root/tests/` |
| Support | `docs/troubleshooting/` |

---

## 📋 Quick Checklist

When starting a new task:

- [ ] Is this a documentation question? → Check `docs/`
- [ ] Do I need a verification tool? → Check `utilities/`
- [ ] Am I coding? → Work in `Project-root/`
- [ ] Is this outdated? → Move to `archive/`
- [ ] Do I need an overview? → Read root docs first
- [ ] Am I deploying? → Read `docs/deployment/`

---

## 💡 Pro Tips

1. **Bookmark these locations:**
   - `README.md` - Structure overview
   - `QUICK_NAVIGATION.md` - Find by role
   - `docs/` - All documentation

2. **Use folder structure to find things:**
   - Docs? → `docs/`
   - Tools? → `utilities/`
   - Code? → `Project-root/`

3. **When adding new files:**
   - Documentation → `docs/` subfolder
   - Scripts → `utilities/` subfolder
   - Old files → `archive/` folder

4. **Keep root clean:**
   - Only key entry points
   - No temporary files
   - No duplicate docs

---

**Next:** Open `README.md` for folder overview or choose your task!

**Questions?** Check `QUICK_NAVIGATION.md` for your role
