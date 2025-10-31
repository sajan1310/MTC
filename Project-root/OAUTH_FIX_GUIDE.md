# Google OAuth Fix - Quick Start Guide

## What Was Fixed

The Google OAuth 404 error has been resolved by applying the following critical fixes:

### 1. **Removed Circular Import Bug in config.py** ✓
   - Removed invalid code that referenced `app` before initialization
   - Added proper OAuth credential validation with warnings
   
### 2. **Added ProxyFix Middleware to app.py** ✓
   - Handles X-Forwarded-* headers from reverse proxies
   - Ensures correct redirect URI generation behind Nginx/Apache
   - Sets PREFERRED_URL_SCHEME for HTTPS support

### 3. **Enhanced OAuth Logging** ✓
   - Logs exact redirect_uri sent to Google
   - Logs callback requests with full URL
   - Enhanced error messages for debugging
   - Request/response logging for all routes

### 4. **Route Map Printing at Startup** ✓
   - Prints all registered Flask routes on startup
   - Highlights OAuth-specific routes for verification
   - Makes debugging route mismatches easy

### 5. **Session Security Configuration** ✓
   - Configured secure session cookies
   - Added PERMANENT_SESSION_LIFETIME
   - HttpOnly and SameSite flags for production

### 6. **Created OAuth Diagnostic Tool** ✓
   - `check_oauth_config.py` verifies configuration before running
   - Shows exact redirect_uri to configure in Google Console
   - Catches configuration errors early

### 7. **Updated .env.example** ✓
   - Clear instructions for Google Cloud Console setup
   - Explicit callback path documentation
   - Warnings about exact URL matching

### 8. **Created Test Suite** ✓
   - Comprehensive OAuth tests in `test_oauth_redirect_uri.py`
   - Validates redirect URI generation
   - Tests callback route existence
   - Verifies error handling

---

## How to Use

### Step 1: Verify Your Configuration

Run the diagnostic tool to check your OAuth setup:

```powershell
cd Project-root
python check_oauth_config.py
```

This will print the EXACT redirect URI your app generates. Example output:
```
============================================================
GOOGLE OAUTH CONFIGURATION CHECK
============================================================

1. Environment Variables:
   GOOGLE_CLIENT_ID: ✓ Set
   GOOGLE_CLIENT_SECRET: ✓ Set
   BASE_URL: http://127.0.0.1:5000

2. Flask URL Building Test:
   Generated callback URL: http://127.0.0.1:5000/auth/google/callback

3. Google Cloud Console Setup:
   Go to: https://console.cloud.google.com/apis/credentials
   Your OAuth 2.0 Client ID must have this EXACT redirect URI:
   
   http://127.0.0.1:5000/auth/google/callback
   
   ⚠️  Copy the URL above and add it to 'Authorized redirect URIs'
============================================================
```

### Step 2: Configure Google Cloud Console

1. Go to https://console.cloud.google.com/apis/credentials
2. Click on your OAuth 2.0 Client ID
3. Under "Authorized redirect URIs", click "ADD URI"
4. Paste the EXACT URL from Step 1 (e.g., `http://127.0.0.1:5000/auth/google/callback`)
5. Click "SAVE"
6. Wait 1-2 minutes for changes to propagate

**IMPORTANT**: The callback path is `/auth/google/callback` (NOT `/auth/callback`)

### Step 3: Run the Application

Start the Flask app with debug logging:

```powershell
cd Project-root
$env:FLASK_ENV="development"
$env:FLASK_DEBUG="1"
$env:OAUTHLIB_INSECURE_TRANSPORT="1"  # Allow HTTP for local testing
python app.py
```

You should see output like:
```
============================================================
REGISTERED FLASK ROUTES:
============================================================
  auth.login                               GET        /login
  auth.auth_google                         GET        /auth/google
  auth.auth_google_callback                GET        /auth/google/callback
  ...

OAUTH-RELATED ROUTES:
  /login -> auth.login
  /auth/google -> auth.auth_google
  /auth/google/callback -> auth.auth_google_callback
============================================================
```

### Step 4: Test OAuth Login

1. Open browser to http://127.0.0.1:5000/login
2. Click "Sign in with Google"
3. You should be redirected to Google's login page
4. After logging in, you should be redirected back to your app
5. Check the terminal logs for detailed OAuth flow information

**Expected Log Output**:
```
[OAuth] Initiating Google login with redirect_uri: http://127.0.0.1:5000/auth/google/callback
[OAuth] Redirecting user to: https://accounts.google.com/o/oauth2/v2/auth...
[OAuth] Callback received at http://127.0.0.1:5000/auth/google/callback?code=...
[OAuth] Exchanging code for token with redirect_uri: http://127.0.0.1:5000/auth/google/callback
[OAuth] Successfully retrieved user info for user@example.com
[OAuth] User user@example.com logged in successfully (new=True)
```

---

## Testing

Run the OAuth test suite:

```powershell
cd Project-root
python -m pytest tests/test_oauth_redirect_uri.py -v -s
```

Expected output:
```
tests/test_oauth_redirect_uri.py::test_oauth_redirect_uri_matches_expected PASSED
tests/test_oauth_redirect_uri.py::test_oauth_initiate_returns_redirect_to_google PASSED
tests/test_oauth_redirect_uri.py::test_callback_route_exists_and_accepts_get PASSED
tests/test_oauth_redirect_uri.py::test_callback_route_handles_missing_code PASSED
tests/test_oauth_redirect_uri.py::test_callback_route_handles_google_error PASSED
tests/test_oauth_redirect_uri.py::test_config_has_oauth_credentials PASSED
```

---

## Troubleshooting

### Still Getting 404 from Google?

**Check 1**: Verify redirect URI in logs matches Google Console
```powershell
# Look for this line in your terminal:
[OAuth] Initiating Google login with redirect_uri: http://127.0.0.1:5000/auth/google/callback
```

**Check 2**: Verify the callback route is registered
```powershell
# Look for this in startup output:
OAUTH-RELATED ROUTES:
  /auth/google/callback -> auth.auth_google_callback
```

**Check 3**: Ensure Google Console has the EXACT URL
- Protocol must match (http vs https)
- Port must match (5000)
- Path must be `/auth/google/callback`

### Getting "Missing authorization code" error?

This means the callback route is working, but Google isn't sending the code. Check:
1. Your GOOGLE_CLIENT_ID is correct
2. The OAuth consent screen is configured
3. Your app is not in "testing" mode with restricted users

### Getting "HTTP error during token exchange"?

This means:
1. GOOGLE_CLIENT_SECRET might be wrong
2. Redirect URI mismatch during token exchange
3. Check logs for the exact error code

---

## Production Deployment

When deploying to production:

1. Update `.env`:
   ```bash
   BASE_URL="https://yourdomain.com"
   FLASK_ENV="production"
   ```

2. Update Google Console redirect URI:
   ```
   https://yourdomain.com/auth/google/callback
   ```

3. Ensure your reverse proxy (Nginx/Apache) forwards these headers:
   ```nginx
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-Host $host;
   proxy_set_header X-Forwarded-Port $server_port;
   ```

4. The ProxyFix middleware will handle the rest automatically

---

## Summary of Changes

**Files Modified**:
- `config.py` - Removed circular import, added validation
- `app.py` - Added ProxyFix, logging, route printing, session config
- `auth/routes.py` - Enhanced logging and error handling

**Files Created**:
- `check_oauth_config.py` - Diagnostic tool
- `tests/test_oauth_redirect_uri.py` - OAuth test suite
- `OAUTH_FIX_GUIDE.md` - This guide

**Updated**:
- `.env.example` - Clear OAuth setup instructions

All changes are backward compatible and preserve existing functionality.
