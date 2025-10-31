# 🔧 Google OAuth 404 Error - Quick Fix Guide

## Problem
When clicking "Sign in with Google", you're getting a **404 error** from Google. This means the redirect URI is not authorized in Google Cloud Console.

## Root Cause
Your app is sending this redirect URI to Google:
```
http://localhost:5000/auth/google/callback
```

But Google Cloud Console doesn't have this URI in the list of authorized redirect URIs.

---

## ✅ Solution: Add Redirect URI to Google Cloud Console

### Step 1: Go to Google Cloud Console
1. Open: https://console.cloud.google.com/apis/credentials
2. Find your OAuth 2.0 Client ID (the one matching your `GOOGLE_CLIENT_ID`)
3. Click on it to edit

### Step 2: Add Authorized Redirect URIs

Add **ALL** of these redirect URIs (Google requires exact matches):

```
http://localhost:5000/auth/google/callback
http://127.0.0.1:5000/auth/google/callback
```

**Why both?** Because:
- `localhost` and `127.0.0.1` are treated as different domains by Google
- Your app currently uses `localhost`, but you might access it via `127.0.0.1` too

### Step 3: Save Changes
Click **"Save"** at the bottom of the page.

### Step 4: Test Again
1. Go back to your app: http://localhost:5000
2. Click "Sign in with Google"
3. You should now be redirected to Google's login page successfully

---

## 🔍 How to Verify Your Current Configuration

Run this diagnostic tool:
```bash
cd Project-root
python check_oauth_config.py
```

This will show you:
- ✅ Your current `GOOGLE_CLIENT_ID`
- ✅ Your current `BASE_URL`
- ✅ The exact redirect URI your app will send to Google

---

## 🌐 Alternative Fix: Change BASE_URL to Use 127.0.0.1

If you already have `http://127.0.0.1:5000/auth/google/callback` configured in Google Console:

1. Edit `.env` file in `Project-root/` directory
2. Change:
   ```bash
   BASE_URL=http://localhost:5000
   ```
   To:
   ```bash
   BASE_URL=http://127.0.0.1:5000
   ```
3. Restart the Flask server
4. Access the app at: http://127.0.0.1:5000

---

## 📋 Common Mistakes to Avoid

❌ **Wrong path**: `/auth/callback` (missing `/google`)  
✅ **Correct path**: `/auth/google/callback`

❌ **Wrong port**: `http://localhost:3000/auth/google/callback`  
✅ **Correct port**: `http://localhost:5000/auth/google/callback`

❌ **Wrong protocol**: `https://localhost:5000/auth/google/callback` (unless using HTTPS)  
✅ **Correct protocol**: `http://localhost:5000/auth/google/callback`

❌ **Trailing slash**: `http://localhost:5000/auth/google/callback/`  
✅ **No trailing slash**: `http://localhost:5000/auth/google/callback`

---

## 🚀 For Production Deployment

When deploying to production (Railway, Render, Heroku, etc.):

1. Update `.env`:
   ```bash
   BASE_URL=https://yourdomain.com
   ```

2. Add production redirect URI to Google Console:
   ```
   https://yourdomain.com/auth/google/callback
   ```

3. **Keep the localhost URIs** for local development

---

## 🆘 Still Having Issues?

### Check Server Logs
Look for this line in the terminal:
```
[OAuth] Initiating Google login with redirect_uri: http://localhost:5000/auth/google/callback
```

This is the EXACT URI that must be in Google Cloud Console.

### Verify Google Console Settings
1. Go to: https://console.cloud.google.com/apis/credentials
2. Click your OAuth 2.0 Client ID
3. Scroll to "Authorized redirect URIs"
4. Confirm `http://localhost:5000/auth/google/callback` is listed
5. Click "Save" if you made changes
6. Wait 5 minutes for changes to propagate

### Test with Different Browser
Sometimes browser cache can cause issues. Try:
- Opening in Incognito/Private mode
- Using a different browser
- Clearing browser cache

---

**Quick Summary:**
```
1. Go to: https://console.cloud.google.com/apis/credentials
2. Edit your OAuth 2.0 Client ID
3. Add: http://localhost:5000/auth/google/callback
4. Add: http://127.0.0.1:5000/auth/google/callback
5. Click "Save"
6. Try signing in again
```

✅ This should fix the 404 error!
