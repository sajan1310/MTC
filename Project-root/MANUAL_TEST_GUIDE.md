# 🧪 Manual OAuth Testing Guide

## ✅ Automated Test Results

**Status: 9/10 Tests Passed** ✅

### Configuration Verification
- ✅ `.env` file exists
- ✅ `OAUTHLIB_INSECURE_TRANSPORT=1` is set
- ✅ `BASE_URL=http://127.0.0.1:5000` matches Google Console
- ✅ `GOOGLE_CLIENT_ID` matches screenshot (135697839359-...)

### Server Status
- ✅ Flask server running on http://127.0.0.1:5000
- ✅ OAuth callback route exists (`/auth/google/callback`)
- ✅ Login page loads successfully
- ✅ Login page contains Google sign-in option
- ✅ OAuth initiation redirects to Google properly

---

## 🎯 Final Manual Test (DO THIS NOW)

### Step 1: Open Browser
1. Open a web browser (Chrome, Firefox, or Edge)
2. Navigate to: **http://127.0.0.1:5000**

### Step 2: Test Google OAuth
1. You should see the login page
2. Click the **"Sign in with Google"** button
3. **Expected**: Browser redirects to Google's OAuth consent screen
4. Select your Google account
5. **Expected**: After authenticating, you're redirected back to http://127.0.0.1:5000/auth/google/callback
6. **Expected**: You see the dashboard (logged in successfully)

### Step 3: Watch Server Logs
While testing, watch the terminal where Flask is running. You should see:

```
[OAuth] Initiating Google login with redirect_uri: http://127.0.0.1:5000/auth/google/callback
[OAuth] Callback received at http://127.0.0.1:5000/auth/google/callback?code=...
[OAuth] Successfully retrieved user info for your-email@gmail.com
[OAuth] User your-email@gmail.com logged in successfully
```

---

## ✅ Success Indicators

If OAuth works correctly, you will:
1. ✅ Be redirected to Google (not see a 404 error)
2. ✅ See Google's account selection screen
3. ✅ Be redirected back to your app (http://127.0.0.1:5000/auth/google/callback)
4. ✅ Be logged in and see the dashboard
5. ✅ See OAuth success messages in server logs

---

## ❌ Failure Indicators

If you see a **404 error** during the OAuth flow:

### Scenario A: 404 from Your App
- **URL**: http://127.0.0.1:5000/auth/google/callback
- **Problem**: Route not registered (but our tests confirm it exists!)
- **Action**: Check server logs for route registration

### Scenario B: 404 from Google
- **URL**: https://accounts.google.com/...
- **Problem**: Google OAuth configuration issue
- **Action**: Verify redirect URI in Google Console

---

## 🔍 Troubleshooting Steps

### If OAuth Still Fails:

#### 1. Verify Environment Variable is Loaded
Add this debug code to `app.py` (after line 15):
```python
print(f"[DEBUG] OAUTHLIB_INSECURE_TRANSPORT = {os.getenv('OAUTHLIB_INSECURE_TRANSPORT')}")
```

Restart server and check output. Should show: `[DEBUG] OAUTHLIB_INSECURE_TRANSPORT = 1`

#### 2. Check Redirect URI in Browser
When redirected to Google, look at the URL in the browser's address bar. Copy the full URL and check:
- Does it contain `redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fauth%2Fgoogle%2Fcallback`?
- URL decode it: http://127.0.0.1:5000/auth/google/callback
- Does it exactly match Google Console?

#### 3. Clear Browser Cache
- Open browser in **Incognito/Private mode**
- Try OAuth again
- This eliminates cached redirects

#### 4. Verify Google Console Settings
Double-check in https://console.cloud.google.com/apis/credentials:
- **Authorized redirect URI**: http://127.0.0.1:5000/auth/google/callback
- **No trailing slash**
- **No extra spaces**
- **Exact match with BASE_URL in .env**

#### 5. Check for Multiple Flask Instances
```powershell
# Kill all Python processes
Get-Process python | Stop-Process -Force

# Restart Flask
cd Project-root
python app.py
```

---

## 📊 What We Fixed

### Root Cause
**Missing `OAUTHLIB_INSECURE_TRANSPORT=1` environment variable**

The `oauthlib` library (used by Google OAuth) requires HTTPS by default. For local development with HTTP, we must explicitly allow it.

### Applied Fix
Added to `.env` file:
```bash
# ✅ CRITICAL: Allow OAuth over HTTP for local development
# This MUST be set to "1" when using http:// (not https://)
# Remove or set to "0" in production with HTTPS
OAUTHLIB_INSECURE_TRANSPORT=1
```

### Why This Works
- `oauthlib` checks this environment variable during OAuth flow initialization
- Without it, OAuth over HTTP is blocked (even if routes exist)
- With it, OAuth over HTTP is explicitly allowed for development

---

## 🚀 After Successful Testing

Once OAuth works locally:

### 1. Document the Success
Add a comment to your terminal output or save logs showing successful OAuth login

### 2. Prepare for Production Deployment
When deploying to production:

```bash
# In production .env file:
# Remove or comment out OAUTHLIB_INSECURE_TRANSPORT
# OAUTHLIB_INSECURE_TRANSPORT=0

# Update BASE_URL to your production domain
BASE_URL=https://yourdomain.com

# Add HTTPS redirect URI to Google Console
# https://yourdomain.com/auth/google/callback
```

### 3. Use Production Server
Follow `DEPLOYMENT.md` for platform-specific instructions:
- Railway
- Render
- Heroku
- VPS/Cloud Server

### 4. Production Checklist
See `PRODUCTION_READINESS_CHECKLIST.md` for:
- Security configurations
- Environment variables validation
- Database migration
- SSL/TLS setup
- Monitoring and logging

---

## 📝 Test Results Log

**Date**: 2025-10-31  
**Time**: 13:52  
**Test Status**: 9/10 Passed ✅

### Passed Tests:
- ✅ .env file exists and is configured
- ✅ OAUTHLIB_INSECURE_TRANSPORT=1 is set
- ✅ BASE_URL matches Google Console (127.0.0.1:5000)
- ✅ GOOGLE_CLIENT_ID matches screenshot
- ✅ Flask server running on correct port
- ✅ OAuth callback route exists (returns 400 as expected)
- ✅ Login page loads successfully
- ✅ Login page contains Google sign-in option
- ✅ OAuth initiation redirects to Google

### Manual Test Pending:
- ⏳ End-to-end OAuth flow (waiting for your test)

---

## 🎯 Next Action

**Please test the OAuth flow now:**
1. Go to http://127.0.0.1:5000
2. Click "Sign in with Google"
3. Complete the sign-in process
4. Report back whether it works!

If you see the **dashboard after signing in**, the fix is complete! ✅  
If you still see a **404 error**, let me know the exact URL where it occurs.
