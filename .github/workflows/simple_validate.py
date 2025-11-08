import yaml
import sys
from pathlib import Path


def validate_workflow(filepath):
    """Validate a single workflow file."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            workflow = yaml.safe_load(f)

        print(f"✅ {filepath.name} is valid YAML")
        print(f"   Name: {workflow.get('name', 'N/A')}")
        print(f"   Jobs: {', '.join(workflow.get('jobs', {}).keys())}")

        # Check for 'on' trigger (note: 'on' is a reserved word in YAML)
        if workflow.get("on") or workflow.get(True):
            print("   Triggers: Configured")
        else:
            print("   ⚠️  No triggers found")

        return True
    except yaml.YAMLError as e:
        print(f"❌ {filepath.name} has YAML errors:")
        print(f"   {e}")
        return False
    except Exception as e:
        print(f"❌ Error reading {filepath.name}:")
        print(f"   {e}")
        return False


# Validate both workflows
workflows_dir = Path(r"C:\Users\erkar\OneDrive\Desktop\MTC\.github\workflows")
ci_yml = workflows_dir / "ci.yml"
test_yml = workflows_dir / "test.yml"

print("🔍 Validating GitHub Actions workflows...\n")

all_valid = True
all_valid &= validate_workflow(ci_yml)
print()
all_valid &= validate_workflow(test_yml)

print("\n" + "=" * 50)
if all_valid:
    print("✨ All workflows are valid!")
    sys.exit(0)
else:
    print("❌ Some workflows have errors")
    sys.exit(1)
