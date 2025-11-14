from pathlib import Path
import sys
base = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(base))
from app import create_app
from app.services.production_service import ProductionService

app = create_app('testing') if 'testing' in sys.argv else create_app()
app.config['LOGIN_DISABLED'] = True
app.config['TESTING'] = True

LOT_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 1
VARIANT_ID = int(sys.argv[2]) if len(sys.argv) > 2 else 53011
PROCESS_SUBPROCESS_ID = int(sys.argv[3]) if len(sys.argv) > 3 else 8

with app.app_context():
    try:
        sel = ProductionService.select_variant_for_group(
            lot_id=LOT_ID,
            substitute_group_id=None,
            variant_id=VARIANT_ID,
            supplier_id=None,
            quantity=None,
            process_subprocess_id=PROCESS_SUBPROCESS_ID,
        )
        import json
        print(json.dumps(sel, default=str, indent=2))
    except Exception as e:
        print('ERROR', repr(e))
