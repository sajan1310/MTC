#!/usr/bin/env python3
"""
Improve error handling in process_framework_unified.js
Replaces console.error with centralized error handler
"""

import re

file_path = 'c:/Users/erkar/OneDrive/Desktop/MTC/Project-root/static/js/process_framework_unified.js'

# Read the file
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Patterns to replace - map old error pattern to new one
replacements = [
    # console.error followed by showAlert
    (
        r"console\.error\('\[Add Variant\] Error:', error\);\s+this\.showAlert\(error\.message \|\| 'Failed to add variant', 'error'\);",
        "processFramework.handleError(error, 'Add Variant', 'Failed to add variant');"
    ),
    (
        r"console\.error\('\[Remove Variant\] Error:', error\);\s+this\.showAlert\(error\.message \|\| 'Failed to remove variant', 'error'\);",
        "processFramework.handleError(error, 'Remove Variant', 'Failed to remove variant');"
    ),
    (
        r"console\.error\('\[Batch Add\] Error', e\);\s+this\.showAlert\(e\.message \|\| 'Failed to add variants', 'error'\);",
        "processFramework.handleError(e, 'Batch Add', 'Failed to add variants');"
    ),
    (
        r"console\.error\('\[Variant Usage\] Update error', e\);\s+this\.showAlert\(e\.message \|\| 'Failed to update', 'error'\);",
        "processFramework.handleError(e, 'Variant Usage Update', 'Failed to update variant');"
    ),
    (
        r"console\.error\('\[Inline Editor\] Error opening editor:', error\);\s+this\.showAlert\('Failed to open inline editor', 'error'\);",
        "processFramework.handleError(error, 'Open Inline Editor', 'Failed to open inline editor');"
    ),
    (
        r"console\.error\('\[Inline Editor\] Error saving process:', error\);\s+this\.showAlert\('Failed to save process', 'error'\);",
        "processFramework.handleError(error, 'Save Process', 'Failed to save process');"
    ),
    (
        r"console\.error\('\[Inline Editor\] Error loading subprocesses:', error\);\s+this\.showAlert\('Failed to load subprocesses', 'error'\);",
        "processFramework.handleError(error, 'Load Subprocesses', 'Failed to load subprocesses');"
    ),
    (
        r"console\.error\('\[Inline Editor\] Error removing subprocess:', error\);\s+this\.showAlert\('Failed to remove subprocess', 'error'\);",
        "processFramework.handleError(error, 'Remove Subprocess', 'Failed to remove subprocess');"
    ),
    (
        r"console\.error\('\[Inline Editor\] Error adding subprocess:', error\);\s+this\.showAlert\('Failed to add subprocess', 'error'\);",
        "processFramework.handleError(error, 'Add Subprocess', 'Failed to add subprocess');"
    ),
    # Standalone console.error with process operations
    (
        r"console\.error\('Error loading process:', error\);\s+processFramework\.showAlert\('Failed to load process', 'error'\);",
        "processFramework.handleError(error, 'Load Process', 'Failed to load process');"
    ),
    (
        r"console\.error\('Error deleting process:', error\);\s+processFramework\.showAlert\('Failed to delete process', 'error'\);",
        "processFramework.handleError(error, 'Delete Process', 'Failed to delete process');"
    ),
    (
        r"console\.error\('Error loading subprocesses:', error\);\s+processFramework\.showAlert\('Failed to load subprocesses', 'error'\);",
        "processFramework.handleError(error, 'Load Subprocesses', 'Failed to load subprocesses');"
    ),
    (
        r"console\.error\('Error loading subprocess:', error\);\s+processFramework\.showAlert\('Failed to load subprocess', 'error'\);",
        "processFramework.handleError(error, 'Load Subprocess', 'Failed to load subprocess');"
    ),
    (
        r"console\.error\('Error deleting subprocess:', error\);\s+processFramework\.showAlert\('Failed to delete subprocess', 'error'\);",
        "processFramework.handleError(error, 'Delete Subprocess', 'Failed to delete subprocess');"
    ),
    (
        r"console\.error\('Error loading production lots:', error\);\s+processFramework\.showAlert\('Failed to load production lots', 'error'\);",
        "processFramework.handleError(error, 'Load Production Lots', 'Failed to load production lots');"
    ),
    (
        r"console\.error\('Error loading metrics:', error\);\s+processFramework\.showAlert\('Failed to load metrics', 'error'\);",
        "processFramework.handleError(error, 'Load Metrics', 'Failed to load metrics');"
    ),
    (
        r"console\.error\('Error loading top processes:', error\);\s+processFramework\.showAlert\('Failed to load top processes', 'error'\);",
        "processFramework.handleError(error, 'Load Top Processes', 'Failed to load top processes');"
    ),
    (
        r"console\.error\('Error loading recent lots:', error\);\s+processFramework\.showAlert\('Failed to load recent lots', 'error'\);",
        "processFramework.handleError(error, 'Load Recent Lots', 'Failed to load recent lots');"
    ),
]

# Apply replacements
for pattern, replacement in replacements:
    content = re.sub(pattern, replacement, content)

# Remove standalone console.error that don't have matching showAlert
# We keep the error handling but improve the user messaging
standalone_errors = [
    (r"console\.error\('\[Inline Editor\] No process ID set'\);",
     "processFramework.handleError(new Error('No process selected'), 'Inline Editor', 'Please select a process first');"),
    (r"console\.error\('\[Inline Editor\] No process ID set for adding subprocess'\);",
     "// Already has showAlert below"),
]

for pattern, replacement in standalone_errors:
    if replacement != "// Already has showAlert below":
        content = re.sub(pattern, replacement, content)

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ Error handling improvements applied!")
print(f"✅ Updated file: {file_path}")
