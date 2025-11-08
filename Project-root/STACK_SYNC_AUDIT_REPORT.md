# MTC Full Stack Synchronization Audit

---

## Audit Overview

This report reflects a full-stack synchronization audit for the MTC repository, covering:
- **Frontend**: HTML templates, JS event/data bindings, CSS selectors
- **Backend**: Python routes/views, Flask logic, DB/ORM models
- **Database Layer**: PostgreSQL schemas/tables, migration scripts
- **Interoperability**: Data flow between layers, endpoint mapping, error handling

---

## Audit Findings Table

| Category         | File(s) Affected                                         | Issue                                                                 | Severity   | Recommended Fix                  |
|-----------------|----------------------------------------------------------|-----------------------------------------------------------------------|------------|----------------------------------|
| Missing Template| app/api/routes.py → dashboard.html                       | Route references a non-existing template                              | Critical   | Create dashboard.html or update route reference |
| Unused CSS      | static/styles.css, static/css/login.css                  | Several classes defined, not referenced in any HTML/JS                | Moderate   | Remove or refactor unused selectors |
| Unused JS Func  | static/js/api_client.js                                  | submitForm() is defined, not invoked by any template                  | Moderate   | Remove or refactor function         |
| Mismatched DB   | migrations/init_schema.sql vs models/process.py           | Table fields in SQL missing from ORM model and vice versa             | Critical   | Align ORM fields and DB schema      |
| Broken Endpoint | static/js/inventory.js → /api/get_stock                  | JS references endpoint not defined in any python route                | Critical   | Implement backend API endpoint      |
| Orphaned Table  | migrations/add_indexes.sql                               | Table indexes remain for dropped tables                               | Low        | Cleanup obsolete indexes/tables     |
| Redundant Route | app/api/routes.py, app/main/routes.py                    | Multiple routes serve same data with different function names          | Moderate   | Consolidate duplicate routes        |
| Bad JS Binding  | static/inventory.js → inventory.html                     | JS expects data structure not provided by backend                     | High       | Update backend response/JS parsing  |
| Broken Include  | templates/base.html `{% include "footer.html" %}`       | footer.html not found in template directory                           | Moderate   | Create footer.html or fix include   |
| Outdated Migration| migrations/migration_add_master_tables.py               | Migration references deprecated fields/tables                         | Moderate   | Update migration script             |
| Unused Model    | app/models/inventory.py                                  | Model defined but not imported/used anywhere                          | Low        | Remove or use model logically       |
| Redundant Service| app/services/process_service.py                          | Contains duplicate logic for variant selection                        | Moderate   | Refactor/remove duplicated logic    |

---

## Summary of Overall Synchronization Health
- **Critical mismatches** between backend route references and missing templates
- **Major issues** found in data binding between JS and backend responses, especially in inventory and production lot workflows
- **Several redundant/unused functions and models** observed (CSS, JS, Python)
- **Database schema drift** detected between models and migration scripts

---

## Recommendations & Fix Priorities
1. Address missing templates and broken includes for stable route-view flow
2. Implement backend endpoints referenced but not present (AJAX/fetch)
3. Align ORM models and DB schema/migrations for uninterrupted data sync
4. Consolidate redundant backend routes and JS logic for maintainability

---

## Detailed Issue Log
(Attach or expand this table with examples/code references as needed)

- Missing: dashboard.html
- Unused: submitForm() in api_client.js
- Mismatched: Table fields (init_schema.sql) vs ORM (process.py)
- Broken: /api/get_stock referenced by inventory.js

> **Generated on 2025-11-08, via Perplexity Full Stack Deep Audit**
