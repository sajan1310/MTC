"""Compatibility shim for the legacy monolithic app module.

This file previously contained the entire Flask application. The project has
been refactored to use the Application Factory pattern under the package
directory named 'app/'.

To preserve import compatibility (e.g. `import app`), this module forwards all
attributes to the new application package, so code and tests can keep using
`import app` while actually getting the package implementation.
"""

import importlib.util
import os
import sys

# Compute the path to the new application package directory
_pkg_dir = os.path.join(os.path.dirname(__file__), "app")
_init_py = os.path.join(_pkg_dir, "__init__.py")

if not os.path.isfile(_init_py):
    raise RuntimeError(
        "Application package not found at 'app/'. Ensure the new structure exists."
    )

# Load the package module under the same top-level name and replace this module
_spec = importlib.util.spec_from_file_location(
    "app", _init_py, submodule_search_locations=[_pkg_dir]
)
_module = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
assert _spec and _spec.loader
_spec.loader.exec_module(_module)  # type: ignore[union-attr]

# Replace current module object with the loaded package module
sys.modules[__name__] = _module
