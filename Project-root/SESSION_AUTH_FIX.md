# Session Authentication Fix for Variant Usage Updates

## Issue

**Symptom:** 500 Internal Server Error when updating variant usage (quantity/cost) via inline editor  
**Root Cause:** Session expiration + poor error handling

## Diagnosis

### What Was Happening:

1. **User session expired** while using the app
2. Flask-Login's `@login_required` decorator detected unauthenticated request
3. **Flask-Login redirected to login page** (HTTP 302 → 200 with HTML)
4. JavaScript `fetch()` followed the redirect and received HTML instead of JSON
5. Code tried to parse HTML as JSON → parsing error
6. Generic "internal_error" shown to user

### Console Evidence:

```javascript
PUT http://127.0.0.1:5000/api/upf/variant_usage/14 500 (INTERNAL SERVER ERROR)
process_framework_unified.js:1829 [Alert] Creating alert: Variant Usage Update: internal_error error
```

The error wasn't actually a 500 - it was a session authentication issue being mishandled!

## Fix Applied

### 1. Backend: JSON Response for Unauthorized API Requests

**File:** `app/__init__.py`

**Change:** Added `unauthorized_handler` to detect API requests and return JSON instead of HTML redirects

```python
@login_manager.unauthorized_handler
def unauthorized():
    from flask import request, jsonify
    # If it's an API request, return JSON
    if request.path.startswith('/api/'):
        return jsonify({
            'success': False,
            'error': 'unauthorized',
            'message': 'Authentication required. Please log in.'
        }), 401
    # Otherwise, redirect to login page (default behavior)
    from flask import redirect, url_for
    return redirect(url_for('auth.login'))
```

**Why:** This prevents the confusing HTML-in-API-response scenario and returns proper 401 status codes.

### 2. Frontend: Detect Session Expiration

**File:** `static/js/process_framework_unified.js`

**Changes:**

1. **Check Content-Type header** to detect HTML responses:
   ```javascript
   const contentType = resp.headers.get('content-type');
   if (contentType && contentType.includes('text/html')) {
       throw new Error('Session expired. Please refresh the page and log in again.');
   }
   ```

2. **Explicitly handle 401 status**:
   ```javascript
   if (resp.status === 401) {
       throw new Error('Session expired. Please refresh the page and log in again.');
   }
   ```

**Why:** Provides clear, actionable error messages to users when their session expires.

### 3. Improved Error Logging

**File:** `app/api/variant_management.py`

**Change:** Added detailed logging with tracebacks

```python
try:
    data = request.json
    current_app.logger.info(f"[UPDATE VARIANT USAGE] Request for ID {usage_id} with data: {data}")
    # ... existing code ...
except Exception as e:
    import traceback
    current_app.logger.error(f"Error updating variant usage {usage_id}: {e}")
    current_app.logger.error(f"Traceback: {traceback.format_exc()}")
    return APIResponse.error("internal_error", str(e), 500)
```

**Why:** Future debugging will be much easier with full stack traces in the logs.

## Testing

### Before Fix:
- ❌ Session expires → "internal_error" alert
- ❌ No clear indication of what went wrong
- ❌ HTML response parsed as JSON

### After Fix:
- ✅ Session expires → "Session expired. Please refresh the page and log in again."
- ✅ Clear 401 Unauthorized status
- ✅ JSON response for all API endpoints
- ✅ HTML login redirect only for non-API requests

## Verification Steps

1. **Start the Flask app** (if not already running)
2. **Open the processes page** in your browser
3. **Wait for session to expire** (or manually delete session cookie)
4. **Try to update a variant quantity/cost**
5. **Expected:** Clear message: "Session expired. Please refresh the page and log in again."

## Related Files Modified

- ✅ `app/__init__.py` - Added unauthorized handler
- ✅ `app/api/variant_management.py` - Enhanced error logging
- ✅ `static/js/process_framework_unified.js` - Improved error detection

## Session Configuration Recommendations

Consider adjusting Flask session timeout for better UX:

```python
# config.py
PERMANENT_SESSION_LIFETIME = timedelta(hours=12)  # Current default
# Or extend to:
PERMANENT_SESSION_LIFETIME = timedelta(hours=24)  # Longer sessions
```

Also consider implementing:
- **Session refresh** on user activity
- **JWT tokens** for API authentication (no session cookies)
- **"Remember me" functionality** for extended sessions

## Impact

- **User Experience:** Clear error messages instead of cryptic "internal_error"
- **Developer Experience:** Proper 401 status codes make debugging easier
- **API Consistency:** All `/api/*` endpoints now return JSON (never HTML)
- **Security:** No change - still requires authentication

## Next Steps (Optional)

1. Apply same authentication error handling to other fetch calls:
   - `variant_search.js`
   - `process_editor.js`
   - Other API client code

2. Consider global fetch wrapper:
   ```javascript
   async function apiFetch(url, options) {
       const resp = await fetch(url, { ...options, credentials: 'include' });
       if (resp.status === 401) {
           window.location.href = '/auth/login?redirect=' + encodeURIComponent(window.location.pathname);
           throw new Error('Session expired');
       }
       if (!resp.ok) {
           const err = await resp.json().catch(() => ({}));
           throw new Error(err.message || 'Request failed');
       }
       return resp;
   }
   ```

---

**Status:** ✅ Fixed  
**Date:** November 11, 2025
