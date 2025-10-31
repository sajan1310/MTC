# 🔍 Google Cloud Console OAuth Configuration Checklist

## 🎯 How to Check Your Google OAuth Settings

Follow these steps **in order** to verify your Google Cloud Console configuration.

---

## 📋 Step 1: Access Google Cloud Console

1. **Go to**: https://console.cloud.google.com/
2. **Select your project** from the dropdown at the top
   - Look for the project with Client ID: `135697839359-...`
   - Or create/select the correct project

---

## 🔑 Step 2: Check OAuth Client Configuration

### 2.1 Navigate to Credentials
1. **Go to**: https://console.cloud.google.com/apis/credentials
2. Or: Click **☰ Menu** → **APIs & Services** → **Credentials**

### 2.2 Find Your OAuth 2.0 Client ID
Look for a credential with:
- **Type**: OAuth 2.0 Client ID
- **Name**: (Your client name)
- **Client ID**: Starts with `135697839359-...`

### 2.3 Click on Your Client ID to Open Settings

You should see:

```
OAuth 2.0 Client ID
Name: [Your client name]
Client ID: 135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
Client Secret: [Your secret]
Creation date: [Date]
```

---

## ✅ Step 3: Verify Authorized Redirect URIs (CRITICAL!)

This is the **#1 cause** of OAuth 404 errors!

### What to Check:

In the **"Authorized redirect URIs"** section, you should see:

```
✅ CORRECT:
http://127.0.0.1:5000/auth/google/callback
```

### Common Mistakes to Avoid:

```
❌ WRONG - Using localhost instead of 127.0.0.1:
http://localhost:5000/auth/google/callback

❌ WRONG - Trailing slash:
http://127.0.0.1:5000/auth/google/callback/

❌ WRONG - Missing /callback:
http://127.0.0.1:5000/auth/google

❌ WRONG - Wrong port:
http://127.0.0.1:5001/auth/google/callback

❌ WRONG - Using https:
https://127.0.0.1:5000/auth/google/callback

❌ WRONG - Extra spaces:
http://127.0.0.1:5000/auth/google/callback 
```

### How to Fix:

1. **Delete any incorrect URIs**
2. **Click "+ ADD URI"**
3. **Enter exactly**: `http://127.0.0.1:5000/auth/google/callback`
4. **Click "SAVE"** at the bottom
5. **Wait 2-3 minutes** for changes to take effect

### Screenshot Reference:
Your redirect URI should match **exactly** what you showed in your screenshot:
```
Authorized redirect URIs
http://127.0.0.1:5000/auth/google/callback
```

---

## 🎨 Step 4: Check OAuth Consent Screen (CRITICAL!)

This is the **#2 cause** of OAuth errors!

### 4.1 Navigate to OAuth Consent Screen
1. **Go to**: https://console.cloud.google.com/apis/credentials/consent
2. Or: **☰ Menu** → **APIs & Services** → **OAuth consent screen**

### 4.2 Check Configuration Status

You'll see one of these:

#### Option A: "Publishing status: Testing" ✅ (Most Common)
```
Publishing status: Testing
User type: External

Last edit: [Date]
```

**Action Required**: Add yourself as a test user (see Step 5 below)

#### Option B: "Publishing status: In production" ✅
```
Publishing status: In production
```

**Action**: No additional steps needed

#### Option C: "Not Configured" ❌
```
OAuth consent screen not configured
```

**Action**: You need to configure it (see Step 6 below)

---

## 👥 Step 5: Add Test Users (If in Testing Mode)

**This is REQUIRED if your app is in "Testing" mode!**

### 5.1 Check Current Test Users

On the OAuth consent screen page, scroll down to:

```
Test users
Add the email addresses of users who can test your app.
Learn more

+ ADD USERS

[List of current test users]
```

### 5.2 Add Your Email

1. **Click "+ ADD USERS"**
2. **Enter your Gmail address** (the one you want to sign in with)
   - Example: `youremail@gmail.com`
3. **Click "Save"**

### 5.3 Verify Test User Added

You should now see:

```
Test users
youremail@gmail.com     [Remove]
```

---

## 📝 Step 6: Verify OAuth Consent Screen Details

Click **"EDIT APP"** to check these settings:

### 6.1 App Information (Required)
```
✅ App name: [Your app name, e.g., "MTC Inventory"]
✅ User support email: [Your email]
✅ App logo: [Optional]
```

### 6.2 App Domain (Optional for Testing)
```
Application home page: http://127.0.0.1:5000
Application privacy policy link: [Optional]
Application terms of service link: [Optional]
```

### 6.3 Authorized Domains
For local development (127.0.0.1), you can **leave this empty**.

For production, add your domain without `http://`:
```
Example: yourdomain.com
```

### 6.4 Developer Contact Information (Required)
```
✅ Email addresses: [Your email]
```

Click **"SAVE AND CONTINUE"**

---

## 🔐 Step 7: Verify Scopes

On the **"Scopes"** page, you should have:

```
✅ .../auth/userinfo.email
   View your email address
   
✅ .../auth/userinfo.profile  
   See your personal info, including any personal info you've made publicly available
   
✅ openid
   Associate you with your personal info on Google
```

These are the **default scopes** and should be automatically included.

Click **"SAVE AND CONTINUE"**

---

## ✅ Step 8: Summary Checklist

Go through this checklist **in order**:

### OAuth Client Settings:
- [ ] Client ID matches: `135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com`
- [ ] Authorized redirect URI is **exactly**: `http://127.0.0.1:5000/auth/google/callback`
- [ ] No trailing slash in redirect URI
- [ ] Using `127.0.0.1` (not `localhost`)
- [ ] Using `http://` (not `https://`)
- [ ] Port is `5000`
- [ ] Path is `/auth/google/callback`

### OAuth Consent Screen:
- [ ] OAuth consent screen is configured
- [ ] Publishing status is "Testing" or "In production"
- [ ] App name is filled in
- [ ] User support email is filled in
- [ ] Developer contact email is filled in
- [ ] If status is "Testing": Your email is in test users list

### Scopes:
- [ ] `userinfo.email` scope is enabled
- [ ] `userinfo.profile` scope is enabled
- [ ] `openid` scope is enabled

---

## 🔍 Step 9: Compare with Your .env File

Your Google Console settings **must match** your `.env` file:

### Check Your .env File:
```bash
# Open Project-root/.env and verify:
BASE_URL=http://127.0.0.1:5000
GOOGLE_CLIENT_ID=135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=[Your secret from Google Console]
OAUTHLIB_INSECURE_TRANSPORT=1
```

### Match These Values:

| Setting | Google Console | .env File | Match? |
|---------|---------------|-----------|--------|
| Protocol | `http://` | `http://` | ✅ |
| Host | `127.0.0.1` | `127.0.0.1` | ✅ |
| Port | `5000` | `5000` | ✅ |
| Path | `/auth/google/callback` | (auto-generated) | ✅ |
| Client ID | `135697839359-...` | `135697839359-...` | ✅ |

---

## 🧪 Step 10: Test After Configuration

After making **any changes** in Google Console:

1. **Click "SAVE"** on all settings pages
2. **Wait 2-3 minutes** (Google needs time to propagate changes)
3. **Clear your browser cache** or use **Incognito mode**
4. **Go to**: http://127.0.0.1:5000
5. **Click "Sign in with Google"**
6. **Select your account**
7. **Verify**: You should see the dashboard (no 404 error)

---

## 🚨 Common Configuration Errors

### Error 1: "Error 400: redirect_uri_mismatch"
**Cause**: Redirect URI in Google Console doesn't match what your app sends  
**Fix**: 
1. Check Step 3 above
2. Ensure exact match: `http://127.0.0.1:5000/auth/google/callback`
3. No trailing slash, no extra spaces

### Error 2: "Access blocked: This app's request is invalid"
**Cause**: OAuth consent screen not configured or app not approved  
**Fix**: 
1. Check Step 4-6 above
2. Configure OAuth consent screen
3. Add yourself as test user (Step 5)

### Error 3: "Error 403: access_denied"
**Cause**: User not authorized (not in test users list)  
**Fix**: 
1. Check Step 5 above
2. Add your email to test users
3. Wait 2-3 minutes
4. Try again

### Error 4: "authError=..." in URL
**Cause**: OAuth consent screen configuration issue  
**Fix**: 
1. Complete Steps 4-7 above
2. Ensure all required fields are filled
3. Add yourself as test user
4. Save and wait 2-3 minutes

---

## 📸 Visual Guide

### What Your Google Console Should Look Like:

#### Credentials Page:
```
OAuth 2.0 Client IDs
Name                    Type                  Created
Web client 1           Web application       Jan 1, 2025

Click on "Web client 1" to open ↑
```

#### Client Configuration:
```
Name: Web client 1
Client ID: 135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
Client secret: [Your secret - keep this private!]

Authorized JavaScript origins
[Empty for local development]

Authorized redirect URIs
http://127.0.0.1:5000/auth/google/callback    [🗑️]
                                             [+ ADD URI]
```

#### OAuth Consent Screen:
```
OAuth consent screen

Publishing status: Testing  [PUBLISH APP]

App information
App name: MTC Inventory
User support email: youremail@gmail.com

Test users
youremail@gmail.com    [Remove]
                      [+ ADD USERS]

[EDIT APP]
```

---

## 🎯 Quick Diagnostic Commands

Run these to verify your configuration:

### Check .env file:
```powershell
cd Project-root
Get-Content .env | Select-String "BASE_URL|GOOGLE_CLIENT_ID|OAUTHLIB"
```

**Expected output:**
```
BASE_URL=http://127.0.0.1:5000
GOOGLE_CLIENT_ID=135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
OAUTHLIB_INSECURE_TRANSPORT=1
```

### Test redirect URI format:
```powershell
# This should return 400 (not 404):
curl http://127.0.0.1:5000/auth/google/callback
```

**Expected**: `400 Bad Request` (means route exists!)  
**Bad**: `404 Not Found` (means route missing - already fixed in your case!)

---

## 📞 Still Having Issues?

If you've completed all steps above and OAuth still fails:

### 1. Take Screenshots
Capture these screens from Google Console:
- OAuth 2.0 Client ID configuration page (showing redirect URIs)
- OAuth consent screen page (showing status and test users)

### 2. Check Server Logs
Look for these in your Flask server terminal:
```
[OAuth] Initiating Google login with redirect_uri: ...
[OAuth] Redirecting user to: https://accounts.google.com/...
```

### 3. Check Browser Network Tab
1. Open browser DevTools (F12)
2. Go to Network tab
3. Try OAuth flow
4. Look for failed requests (red)
5. Check the URL that returned 404

### 4. Verify Environment
```powershell
# Check Python is loading .env correctly:
cd Project-root
python -c "import os; from dotenv import load_dotenv; load_dotenv(); print('BASE_URL:', os.getenv('BASE_URL')); print('OAUTHLIB:', os.getenv('OAUTHLIB_INSECURE_TRANSPORT'))"
```

**Expected output:**
```
BASE_URL: http://127.0.0.1:5000
OAUTHLIB: 1
```

---

## ✅ Final Verification

After completing all configuration steps:

**Your settings should be:**

```
Google Cloud Console:
✅ Client ID: 135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
✅ Redirect URI: http://127.0.0.1:5000/auth/google/callback (exact match)
✅ OAuth consent screen: Configured
✅ Publishing status: Testing (with your email as test user)
✅ Required fields: All filled in
✅ Scopes: email, profile, openid

Your .env file:
✅ BASE_URL=http://127.0.0.1:5000
✅ GOOGLE_CLIENT_ID=135697839359-98a3pof9u58q9nb3pv212r49l6uisr52.apps.googleusercontent.com
✅ GOOGLE_CLIENT_SECRET=[Your secret]
✅ OAUTHLIB_INSECURE_TRANSPORT=1

Your Flask App:
✅ Server running on http://127.0.0.1:5000
✅ Route /auth/google/callback exists (returns 400, not 404)
✅ All OAuth routes registered
```

**If all checkboxes above are ✅, OAuth should work!**

---

## 🚀 Ready to Test

1. Save all changes in Google Console
2. Wait 2-3 minutes
3. Clear browser cache or use Incognito
4. Go to: http://127.0.0.1:5000
5. Click "Sign in with Google"
6. Success! 🎉
