#!/usr/bin/env python3
"""
Workflow Validation Script
===========================
Validates GitHub Actions workflow files for common issues and best practices.

Usage:
    python validate_workflows.py
    python validate_workflows.py --workflow ci.yml
    python validate_workflows.py --fix
"""

import argparse
import sys
from pathlib import Path
from typing import List, Dict, Tuple

try:
    import yaml
except ImportError:
    print("❌ PyYAML not installed. Install with: pip install pyyaml")
    sys.exit(1)


class WorkflowValidator:
    """Validates GitHub Actions workflow files."""

    def __init__(self, workflow_dir: Path):
        self.workflow_dir = workflow_dir
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.info: List[str] = []

    def validate_all(self) -> bool:
        """Validate all workflow files."""
        print("🔍 Validating GitHub Actions workflows...\n")
        
        workflow_files = list(self.workflow_dir.glob("*.yml")) + \
                        list(self.workflow_dir.glob("*.yaml"))
        
        if not workflow_files:
            print(f"❌ No workflow files found in {self.workflow_dir}")
            return False
        
        all_valid = True
        for workflow_file in workflow_files:
            print(f"📄 Validating {workflow_file.name}...")
            if not self.validate_workflow(workflow_file):
                all_valid = False
            print()
        
        return all_valid

    def validate_workflow(self, workflow_file: Path) -> bool:
        """Validate a single workflow file."""
        try:
            with open(workflow_file, 'r', encoding='utf-8') as f:
                content = f.read()
                workflow = yaml.safe_load(content)
        except yaml.YAMLError as e:
            self.errors.append(f"YAML syntax error: {e}")
            return False
        except Exception as e:
            self.errors.append(f"Failed to read file: {e}")
            return False

        # Run validation checks
        self._check_required_fields(workflow, workflow_file.name)
        self._check_job_structure(workflow, workflow_file.name)
        self._check_action_versions(workflow, workflow_file.name)
        self._check_secrets_usage(workflow, workflow_file.name)
        self._check_caching(workflow, workflow_file.name)
        self._check_best_practices(workflow, workflow_file.name)
        
        # Print results
        self._print_results(workflow_file.name)
        
        return len(self.errors) == 0

    def _check_required_fields(self, workflow: dict, filename: str):
        """Check for required workflow fields."""
        required = ['name', 'on', 'jobs']
        for field in required:
            if field not in workflow:
                self.errors.append(f"Missing required field: '{field}'")

    def _check_job_structure(self, workflow: dict, filename: str):
        """Check job structure and dependencies."""
        if 'jobs' not in workflow:
            return
        
        jobs = workflow['jobs']
        job_names = set(jobs.keys())
        
        for job_name, job_config in jobs.items():
            # Check for job name
            if 'name' not in job_config:
                self.warnings.append(
                    f"Job '{job_name}' missing descriptive name"
                )
            
            # Check for runs-on
            if 'runs-on' not in job_config:
                self.errors.append(
                    f"Job '{job_name}' missing 'runs-on' field"
                )
            
            # Check job dependencies
            if 'needs' in job_config:
                needs = job_config['needs']
                if isinstance(needs, str):
                    needs = [needs]
                for dep in needs:
                    if dep not in job_names:
                        self.errors.append(
                            f"Job '{job_name}' depends on unknown job '{dep}'"
                        )
            
            # Check steps
            if 'steps' not in job_config:
                self.warnings.append(
                    f"Job '{job_name}' has no steps defined"
                )

    def _check_action_versions(self, workflow: dict, filename: str):
        """Check that actions use specific versions (not @main, @master)."""
        if 'jobs' not in workflow:
            return
        
        for job_name, job_config in workflow['jobs'].items():
            if 'steps' not in job_config:
                continue
            
            for step_idx, step in enumerate(job_config['steps']):
                if 'uses' not in step:
                    continue
                
                action = step['uses']
                
                # Check for unpinned versions
                if '@main' in action or '@master' in action:
                    self.warnings.append(
                        f"Job '{job_name}', step {step_idx}: "
                        f"Action '{action}' uses unpinned branch "
                        "(prefer @v4, @v5, etc.)"
                    )
                
                # Check for outdated common actions
                outdated_versions = {
                    'actions/checkout': 'v3',
                    'actions/setup-python': 'v4',
                    'actions/upload-artifact': 'v3',
                    'actions/download-artifact': 'v3',
                }
                
                for action_name, old_version in outdated_versions.items():
                    if f"{action_name}@{old_version}" in action:
                        self.info.append(
                            f"Job '{job_name}': Consider updating "
                            f"'{action_name}' from @{old_version} to newer version"
                        )

    def _check_secrets_usage(self, workflow: dict, filename: str):
        """Check secrets usage and security."""
        content_str = str(workflow)
        
        # Check for hardcoded sensitive values
        sensitive_patterns = [
            'password', 'secret', 'token', 'api_key', 'private_key'
        ]
        
        for pattern in sensitive_patterns:
            if pattern in content_str.lower():
                # Verify it's using secrets
                if 'secrets.' not in content_str:
                    self.warnings.append(
                        f"Found '{pattern}' but no secrets usage detected. "
                        "Ensure sensitive values use ${{{{ secrets.NAME }}}}"
                    )

    def _check_caching(self, workflow: dict, filename: str):
        """Check for dependency caching."""
        has_pip = False
        has_cache = False
        
        if 'jobs' not in workflow:
            return
        
        for job_config in workflow['jobs'].values():
            if 'steps' not in job_config:
                continue
            
            for step in job_config['steps']:
                # Check for Python setup
                if step.get('uses', '').startswith('actions/setup-python'):
                    if 'with' in step and 'cache' in step['with']:
                        has_cache = True
                
                # Check for pip install
                if 'run' in step and 'pip install' in step['run']:
                    has_pip = True
        
        if has_pip and not has_cache:
            self.warnings.append(
                "Workflow installs pip packages but doesn't use caching. "
                "Add 'cache: pip' to actions/setup-python for faster builds"
            )

    def _check_best_practices(self, workflow: dict, filename: str):
        """Check for GitHub Actions best practices."""
        # Check for concurrency control
        if 'concurrency' not in workflow:
            self.info.append(
                "Consider adding concurrency control to cancel outdated runs"
            )
        
        # Check for proper triggers
        if 'on' in workflow:
            triggers = workflow['on']
            
            # Recommend path filters for efficiency
            if isinstance(triggers, dict):
                if 'push' in triggers and isinstance(triggers['push'], dict):
                    if 'paths' not in triggers['push']:
                        self.info.append(
                            "Consider adding 'paths' filter to 'push' trigger "
                            "to avoid unnecessary runs"
                        )
        
        # Check for fail-fast strategy
        for job_config in workflow.get('jobs', {}).values():
            if 'strategy' in job_config:
                strategy = job_config['strategy']
                if 'fail-fast' not in strategy:
                    self.info.append(
                        "Consider setting 'fail-fast: false' in matrix "
                        "strategy for better feedback"
                    )

    def _print_results(self, filename: str):
        """Print validation results."""
        if not self.errors and not self.warnings and not self.info:
            print(f"✅ {filename}: No issues found!")
            return
        
        if self.errors:
            print(f"❌ Errors in {filename}:")
            for error in self.errors:
                print(f"   • {error}")
            print()
        
        if self.warnings:
            print(f"⚠️  Warnings in {filename}:")
            for warning in self.warnings:
                print(f"   • {warning}")
            print()
        
        if self.info:
            print(f"ℹ️  Suggestions for {filename}:")
            for info in self.info:
                print(f"   • {info}")
            print()
        
        # Clear for next file
        self.errors.clear()
        self.warnings.clear()
        self.info.clear()


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Validate GitHub Actions workflow files"
    )
    parser.add_argument(
        '--workflow',
        help='Specific workflow file to validate (e.g., ci.yml)'
    )
    parser.add_argument(
        '--workflow-dir',
        default='.github/workflows',
        help='Path to workflows directory (default: .github/workflows)'
    )
    
    args = parser.parse_args()
    
    # Find workflow directory
    workflow_dir = Path(args.workflow_dir)
    if not workflow_dir.exists():
        # Try relative to Project-root
        workflow_dir = Path('Project-root') / args.workflow_dir
        if not workflow_dir.exists():
            # Try in parent directory
            workflow_dir = Path('..') / args.workflow_dir
            if not workflow_dir.exists():
                print(f"❌ Workflow directory not found: {args.workflow_dir}")
                sys.exit(1)
    
    validator = WorkflowValidator(workflow_dir)
    
    if args.workflow:
        # Validate specific workflow
        workflow_file = workflow_dir / args.workflow
        if not workflow_file.exists():
            print(f"❌ Workflow file not found: {workflow_file}")
            sys.exit(1)
        
        success = validator.validate_workflow(workflow_file)
    else:
        # Validate all workflows
        success = validator.validate_all()
    
    if success:
        print("\n✨ All validations passed!")
        sys.exit(0)
    else:
        print("\n❌ Validation failed - please fix errors above")
        sys.exit(1)


if __name__ == '__main__':
    main()
