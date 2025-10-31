<#
DEPRECATED: This PowerShell script is no longer used.

Reason: Google OAuth logic has been rewritten and simplified in the backend.
Please remove this file if not required.
#>

Write-Host "This script is deprecated and no longer in use." -ForegroundColor Yellow
return

# Test 1: Check .env file
Write-Host "[Test 1] Checking .env configuration..." -ForegroundColor Yellow
if (Test-Path ".env") {
    Write-Host "  ✅ .env file exists" -ForegroundColor Green
    $passed++
    
    $envContent = Get-Content .env -Raw
    
    if ($envContent -match "OAUTHLIB_INSECURE_TRANSPORT\s*=\s*1") {
        Write-Host "  ✅ OAUTHLIB_INSECURE_TRANSPORT is set to 1" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  ❌ OAUTHLIB_INSECURE_TRANSPORT is MISSING or not set to 1" -ForegroundColor Red
        Write-Host "     Required: OAUTHLIB_INSECURE_TRANSPORT=1" -ForegroundColor Red
        $failed++
    }
    
    if ($envContent -match "BASE_URL\s*=\s*http://127\.0\.0\.1:5000") {
        Write-Host "  ✅ BASE_URL is set to http://127.0.0.1:5000" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  ⚠️  BASE_URL might not match Google Console" -ForegroundColor Yellow
        Write-Host "     Expected: BASE_URL=http://127.0.0.1:5000" -ForegroundColor Yellow
    }
    
    if ($envContent -match "GOOGLE_CLIENT_ID\s*=\s*135697839359") {
        Write-Host "  ✅ GOOGLE_CLIENT_ID matches screenshot" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  ⚠️  GOOGLE_CLIENT_ID might not match Google Console" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ❌ .env file not found in current directory" -ForegroundColor Red
    Write-Host "     Make sure you're in the Project-root directory" -ForegroundColor Red
    $failed++
}

Write-Host ""

# Test 2: Check if server is running
Write-Host "[Test 2] Checking if Flask server is running..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    Write-Host "  ✅ Server is running on $baseUrl" -ForegroundColor Green
    $passed++
} catch {
    try {
        # Try login page instead
        $response = Invoke-WebRequest -Uri "$baseUrl/login" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        Write-Host "  ✅ Server is running on $baseUrl" -ForegroundColor Green
        $passed++
    } catch {
        Write-Host "  ❌ Server is not running or not accessible" -ForegroundColor Red
        Write-Host "     Start server with: python app.py" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""

# Test 3: Check callback route
Write-Host "[Test 3] Testing OAuth callback route..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/auth/google/callback" -TimeoutSec 3 -UseBasicParsing -ErrorAction SilentlyContinue
    
    if ($response.StatusCode -eq 400) {
        Write-Host "  ✅ Callback route exists (returned 400 BAD REQUEST)" -ForegroundColor Green
        Write-Host "     This is expected - route requires OAuth code parameter" -ForegroundColor Gray
        $passed++
    } elseif ($response.StatusCode -eq 200 -or $response.StatusCode -eq 302) {
        Write-Host "  ✅ Callback route exists (returned $($response.StatusCode))" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "  ⚠️  Callback route returned unexpected status: $($response.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    
    if ($statusCode -eq 400) {
        Write-Host "  ✅ Callback route exists (returned 400 BAD REQUEST)" -ForegroundColor Green
        Write-Host "     This is expected - route requires OAuth code parameter" -ForegroundColor Gray
        $passed++
    } elseif ($statusCode -eq 404) {
        Write-Host "  ❌ Callback route returns 404 - ROUTE NOT FOUND!" -ForegroundColor Red
        Write-Host "     Expected route: /auth/google/callback" -ForegroundColor Red
        Write-Host "     Check blueprint registration and route definition" -ForegroundColor Red
        $failed++
    } else {
        Write-Host "  ⚠️  Unexpected error: $statusCode" -ForegroundColor Yellow
        Write-Host "     Error: $($_.Exception.Message)" -ForegroundColor Gray
    }
}

Write-Host ""

# Test 4: Check login page
Write-Host "[Test 4] Testing login page..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/login" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
        Write-Host "  ✅ Login page loads successfully" -ForegroundColor Green
        $passed++
        
        # Check if it contains Google OAuth button
        if ($response.Content -match "Sign in with Google|google") {
            Write-Host "  ✅ Login page contains Google sign-in option" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "  ⚠️  Google sign-in button not found in page" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  ⚠️  Login page returned status: $($response.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ❌ Login page failed to load" -ForegroundColor Red
    Write-Host "     Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
}

Write-Host ""

# Test 5: Check OAuth initiation
Write-Host "[Test 5] Testing OAuth initiation redirect..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/auth/google" -MaximumRedirection 0 -TimeoutSec 3 -UseBasicParsing -ErrorAction SilentlyContinue
    
    if ($response.StatusCode -eq 302) {
        $location = $response.Headers.Location
        if ($location -match "accounts\.google\.com") {
            Write-Host "  ✅ OAuth initiation redirects to Google" -ForegroundColor Green
            Write-Host "     Redirect URL: $($location.Substring(0, [Math]::Min(80, $location.Length)))..." -ForegroundColor Gray
            $passed++
            
            # Check if redirect_uri parameter is present
            if ($location -match "redirect_uri=([^&]+)") {
                $redirectUri = [System.Web.HttpUtility]::UrlDecode($matches[1])
                Write-Host "     Redirect URI in request: $redirectUri" -ForegroundColor Gray
                
                if ($redirectUri -eq "http://127.0.0.1:5000/auth/google/callback") {
                    Write-Host "  ✅ Redirect URI matches Google Console exactly!" -ForegroundColor Green
                    $passed++
                } else {
                    Write-Host "  ❌ Redirect URI MISMATCH!" -ForegroundColor Red
                    Write-Host "     Expected: http://127.0.0.1:5000/auth/google/callback" -ForegroundColor Red
                    Write-Host "     Got:      $redirectUri" -ForegroundColor Red
                    $failed++
                }
            }
        } else {
            Write-Host "  ❌ OAuth initiation does not redirect to Google" -ForegroundColor Red
            Write-Host "     Redirects to: $location" -ForegroundColor Red
            $failed++
        }
    } else {
        Write-Host "  ⚠️  Unexpected response: $($response.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    $response = $_.Exception.Response
    if ($response.StatusCode -eq 302) {
        $location = $response.Headers.Location.AbsoluteUri
        if ($location -match "accounts\.google\.com") {
            Write-Host "  ✅ OAuth initiation redirects to Google" -ForegroundColor Green
            $passed++
        } else {
            Write-Host "  ⚠️  Redirects but not to Google: $location" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  ❌ OAuth initiation failed" -ForegroundColor Red
        Write-Host "     Error: $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Test Results" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })

if ($failed -eq 0) {
    Write-Host "`n✅ ALL TESTS PASSED!" -ForegroundColor Green
    Write-Host "`nNext steps:" -ForegroundColor Cyan
    Write-Host "1. Open browser to: http://127.0.0.1:5000" -ForegroundColor White
    Write-Host "2. Click 'Sign in with Google'" -ForegroundColor White
    Write-Host "3. Select your Google account" -ForegroundColor White
    Write-Host "4. You should be redirected back and logged in!" -ForegroundColor White
} else {
    Write-Host "`n❌ SOME TESTS FAILED" -ForegroundColor Red
    Write-Host "`nReview the errors above and:" -ForegroundColor Yellow
    Write-Host "1. Ensure OAUTHLIB_INSECURE_TRANSPORT=1 in .env" -ForegroundColor White
    Write-Host "2. Restart the Flask server" -ForegroundColor White
    Write-Host "3. Run this test script again" -ForegroundColor White
}

Write-Host "`n========================================`n" -ForegroundColor Cyan
