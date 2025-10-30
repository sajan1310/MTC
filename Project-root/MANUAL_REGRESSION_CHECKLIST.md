# Manual Regression Checklist

This checklist should be completed before each release to ensure that critical functionality has not been compromised.

## Authentication

| Test Case | Steps | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| **Google Login** | 1. Navigate to the login page. <br> 2. Click the "Sign in with Google" button. <br> 3. Complete the Google authentication flow. | The user is redirected to the dashboard. | `[ ]` |
| **Logout** | 1. Log in to the application. <br> 2. Click the "Logout" button. | The user is redirected to the login page. | `[ ]` |

## Core Functionality

| Test Case | Steps | Expected Result | Status |
| :--- | :--- | :--- | :--- |
| **Dashboard Access** | 1. Log in to the application. | The dashboard is displayed with key metrics. | `[ ]` |
| **Inventory Access** | 1. Log in to the application. <br> 2. Navigate to the inventory page. | The inventory page is displayed with a list of items. | `[ ]` |
| **Add New Item** | 1. Navigate to the inventory page. <br> 2. Click the "Add Item" button. <br> 3. Fill in the required fields and submit the form. | The new item is added to the inventory. | `[ ]` |
