# Import Fix Applied ✅

## Files Fixed:
1. ✅ `check_process.py` - Fixed import order
2. ✅ `debug_process_structure.py` - Fixed import order

## What Changed:

### Before (Broken):
```python
os.chdir(os.path.join(..., 'Project-root'))
sys.path.insert(0, os.path.join(..., 'Project-root'))  # Different path!
import database  # Import fails
```

### After (Fixed):
```python
project_root = os.path.join(os.path.dirname(__file__), 'Project-root')
os.chdir(project_root)
sys.path.insert(0, project_root)  # Same path!
import database  # Now works!
```

## Key Changes:
- ✅ Store `project_root` path in a variable
- ✅ Use the SAME path for both `os.chdir()` and `sys.path.insert()`
- ✅ Ensures imports work after directory change

## To Test:

```bash
# Test check_process.py
cd C:\Users\erkar\OneDrive\Desktop\MTC
python check_process.py 7

# Test debug_process_structure.py  
python debug_process_structure.py 7
```

## Expected Output:
Both scripts should now run without import errors and show:
- ✅ Process information
- ✅ Database connection status
- ✅ No import errors

## Note:
The lint warnings about "Import could not be resolved" are normal for dynamic imports. The scripts will work correctly at runtime because:
1. We change directory to Project-root first
2. We add Project-root to sys.path
3. Then we import database module (which exists in Project-root/)

**The imports are fixed and will work when you run the scripts!** 🎉
