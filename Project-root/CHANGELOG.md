# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2025-10-30

### Added

*   **Google OAuth**: Implemented a secure Google OAuth 2.0 login flow.
*   **Testing Framework**: Added a comprehensive test suite with unit, integration, and smoke tests.
*   **`models.py`**: Created a `models.py` file to house the `User` model, resolving a circular dependency.
*   **`CHANGELOG.md`**: Added this changelog to track changes to the application.
*   **`MANUAL_REGRESSION_CHECKLIST.md`**: Added a manual regression checklist to ensure key functionality remains intact.

### Changed

*   **Dependencies**: Pinned all dependencies in `requirements.txt` to ensure a stable, reproducible build.
*   **Session Cookies**: Hardened session cookie settings in the production configuration for enhanced security.
*   **OAuth Redirect URI**: Updated the Google OAuth flow to use a dynamic redirect URI, improving portability.
*   **Error Handling**: Added robust error handling to the Google OAuth callback to prevent unhandled exceptions.
*   **`base.html`**: Corrected the `url_for` call for the logout button.

### Fixed

*   **Google OAuth Flow**: Resolved the 404 error in the Google OAuth flow by providing clear configuration instructions and implementing a robust backend.
*   **Circular Dependency**: Eliminated the circular dependency between `app.py` and `auth/routes.py`.
