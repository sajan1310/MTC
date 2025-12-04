"""Backwards compatibility wrapper for app.py.

DEPRECATED: This file is kept only for backwards compatibility.
The canonical runner has been moved to the repository root as app.py.

Please use:
    python app.py

From any directory in the project. This wrapper simply delegates to the
root app.py to maintain backwards compatibility with existing scripts
and CI/CD pipelines that reference this file.
"""

import os
import sys
import importlib.util

# Load the root app.py directly to avoid naming conflicts
root_app_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py")
spec = importlib.util.spec_from_file_location("root_app", root_app_path)
root_app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(root_app)

if __name__ == "__main__":
    root_app.main()
