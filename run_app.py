"""Run the application using the package `app` (application factory).

This is a small runner that uses the package-level `create_app` defined in
`app/__init__.py`. It replaces the old top-level `app.py` which conflicted
with the package name during test discovery.
"""
import os

from app import create_app


def main():
    env = os.getenv("FLASK_ENV", "development")
    app = create_app(env)
    app.run(debug=(env == "development"), port=int(os.getenv("PORT", 5000)))


if __name__ == "__main__":
    main()
