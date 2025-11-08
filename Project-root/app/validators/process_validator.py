"""
Process and Subprocess Data Validation

Validates data before database operations to prevent invalid data entry.
"""

from typing import Any, Dict, Optional
import re


class ValidationError(Exception):
    """Raised when data validation fails."""

    pass


class ProcessValidator:
    """Validator for process-related data."""

    # Validation constants
    MIN_NAME_LENGTH = 3
    MAX_NAME_LENGTH = 200
    MAX_DESCRIPTION_LENGTH = 1000
    VALID_PROCESS_CLASSES = [
        "assembly",
        "manufacturing",
        "packaging",
        "quality_check",
        "other",
    ]
    VALID_STATUSES = ["Active", "Inactive", "Draft", "Archived"]

    @staticmethod
    def validate_process_name(name: Optional[str]) -> str:
        """
        Validate process name.

        Args:
            name: Process name to validate

        Returns:
            Cleaned/validated name

        Raises:
            ValidationError: If validation fails
        """
        if not name:
            raise ValidationError("Process name is required")

        name = name.strip()

        if len(name) < ProcessValidator.MIN_NAME_LENGTH:
            raise ValidationError(
                f"Process name must be at least {ProcessValidator.MIN_NAME_LENGTH} characters"
            )

        if len(name) > ProcessValidator.MAX_NAME_LENGTH:
            raise ValidationError(
                f"Process name must not exceed {ProcessValidator.MAX_NAME_LENGTH} characters"
            )

        # Allow common punctuation used in descriptive names: colon, ampersand, parentheses, dot
        if not re.match(r"^[a-zA-Z0-9\s\-_:&().]+$", name):
            raise ValidationError(
                "Process name contains invalid characters (allowed: letters, numbers, spaces, - _ : & ( ) .)"
            )

        return name

    @staticmethod
    def validate_description(description: Optional[str]) -> Optional[str]:
        """
        Validate process description.

        Args:
            description: Description to validate

        Returns:
            Cleaned description or None

        Raises:
            ValidationError: If validation fails
        """
        if not description:
            return None

        description = description.strip()

        if len(description) > ProcessValidator.MAX_DESCRIPTION_LENGTH:
            raise ValidationError(
                f"Description must not exceed {ProcessValidator.MAX_DESCRIPTION_LENGTH} characters"
            )

        return description

    @staticmethod
    def validate_process_class(process_class: str) -> str:
        """
        Validate process class.

        Args:
            process_class: Process class to validate

        Returns:
            Validated process class

        Raises:
            ValidationError: If validation fails
        """
        if not process_class:
            return "other"  # Default

        process_class = process_class.lower().strip()

        if process_class not in ProcessValidator.VALID_PROCESS_CLASSES:
            raise ValidationError(
                f"Invalid process class. Must be one of: {', '.join(ProcessValidator.VALID_PROCESS_CLASSES)}"
            )

        return process_class

    @staticmethod
    def validate_status(status: str) -> str:
        """
        Validate process status.

        Args:
            status: Status to validate

        Returns:
            Validated status

        Raises:
            ValidationError: If validation fails
        """
        if not status:
            return "Active"  # Default

        status = status.strip()

        if status not in ProcessValidator.VALID_STATUSES:
            raise ValidationError(
                f"Invalid status. Must be one of: {', '.join(ProcessValidator.VALID_STATUSES)}"
            )

        return status

    @staticmethod
    def validate_process_data(data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate complete process data.

        Args:
            data: Process data dictionary

        Returns:
            Validated and cleaned data

        Raises:
            ValidationError: If validation fails
        """
        validated = {}

        # Required fields
        validated["name"] = ProcessValidator.validate_process_name(data.get("name"))

        # Optional fields
        validated["description"] = ProcessValidator.validate_description(
            data.get("description")
        )
        validated["process_class"] = ProcessValidator.validate_process_class(
            data.get("process_class", data.get("class", "other"))
        )
        validated["status"] = ProcessValidator.validate_status(
            data.get("status", "Active")
        )

        # User ID (required for creation)
        if "user_id" in data:
            user_id = data.get("user_id")
            if not isinstance(user_id, int) or user_id <= 0:
                raise ValidationError("Valid user_id is required")
            validated["user_id"] = user_id

        return validated


class SubprocessValidator:
    """Validator for subprocess-related data."""

    MIN_QUANTITY = 0.001
    MAX_QUANTITY = 1000000
    VALID_COST_TYPES = [
        "labor",
        "electricity",
        "maintenance",
        "tooling",
        "overhead",
        "other",
    ]

    @staticmethod
    def validate_quantity(quantity: Any, field_name: str = "Quantity") -> float:
        """
        Validate quantity value.

        Args:
            quantity: Quantity to validate
            field_name: Name of the field for error messages

        Returns:
            Validated quantity as float

        Raises:
            ValidationError: If validation fails
        """
        try:
            qty = float(quantity)
        except (TypeError, ValueError):
            raise ValidationError(f"{field_name} must be a number")

        if qty < SubprocessValidator.MIN_QUANTITY:
            raise ValidationError(
                f"{field_name} must be at least {SubprocessValidator.MIN_QUANTITY}"
            )

        if qty > SubprocessValidator.MAX_QUANTITY:
            raise ValidationError(
                f"{field_name} must not exceed {SubprocessValidator.MAX_QUANTITY}"
            )

        return qty

    @staticmethod
    def validate_unit(unit: Optional[str]) -> str:
        """
        Validate measurement unit.

        Args:
            unit: Unit to validate

        Returns:
            Validated unit

        Raises:
            ValidationError: If validation fails
        """
        if not unit:
            return "pcs"  # Default

        unit = unit.strip().lower()

        if len(unit) > 20:
            raise ValidationError("Unit must not exceed 20 characters")

        # Basic sanitization
        if not re.match(r"^[a-z0-9/]+$", unit):
            raise ValidationError(
                "Unit can only contain lowercase letters, numbers, and forward slashes"
            )

        return unit

    @staticmethod
    def validate_cost_type(cost_type: str) -> str:
        """
        Validate cost item type.

        Args:
            cost_type: Cost type to validate

        Returns:
            Validated cost type

        Raises:
            ValidationError: If validation fails
        """
        if not cost_type:
            raise ValidationError("Cost type is required")

        cost_type = cost_type.lower().strip()

        if cost_type not in SubprocessValidator.VALID_COST_TYPES:
            raise ValidationError(
                f"Invalid cost type. Must be one of: {', '.join(SubprocessValidator.VALID_COST_TYPES)}"
            )

        return cost_type

    @staticmethod
    def validate_variant_usage(data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate variant usage data.

        Args:
            data: Variant usage data

        Returns:
            Validated data

        Raises:
            ValidationError: If validation fails
        """
        validated = {}

        # Required fields
        if "variant_id" not in data or not isinstance(data["variant_id"], int):
            raise ValidationError("Valid variant_id is required")
        validated["variant_id"] = data["variant_id"]

        if "process_subprocess_id" not in data or not isinstance(
            data["process_subprocess_id"], int
        ):
            raise ValidationError("Valid process_subprocess_id is required")
        validated["process_subprocess_id"] = data["process_subprocess_id"]

        # Quantity validation
        validated["quantity"] = SubprocessValidator.validate_quantity(
            data.get("quantity", 1), "Variant quantity"
        )

        # Unit validation
        validated["unit"] = SubprocessValidator.validate_unit(data.get("unit", "pcs"))

        # Optional fields
        validated["is_alternative"] = bool(data.get("is_alternative", False))
        validated["substitute_group_id"] = data.get("substitute_group_id")
        validated["alternative_order"] = data.get("alternative_order", 0)

        return validated

    @staticmethod
    def validate_cost_item(data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate cost item data.

        Args:
            data: Cost item data

        Returns:
            Validated data

        Raises:
            ValidationError: If validation fails
        """
        validated = {}

        # Required fields
        validated["cost_type"] = SubprocessValidator.validate_cost_type(
            data.get("cost_type")
        )

        if "process_subprocess_id" not in data or not isinstance(
            data["process_subprocess_id"], int
        ):
            raise ValidationError("Valid process_subprocess_id is required")
        validated["process_subprocess_id"] = data["process_subprocess_id"]

        # Quantity and rate
        validated["quantity"] = SubprocessValidator.validate_quantity(
            data.get("quantity", 1), "Cost quantity"
        )

        validated["rate"] = SubprocessValidator.validate_quantity(
            data.get("rate", 0), "Cost rate"
        )

        # Calculate total
        validated["total_cost"] = validated["quantity"] * validated["rate"]

        # Optional description
        description = data.get("description", "").strip()
        if len(description) > 500:
            raise ValidationError("Cost description must not exceed 500 characters")
        validated["description"] = description if description else None

        return validated

    @staticmethod
    def validate_substitute_group(data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate substitute group data.

        Args:
            data: Substitute group data

        Returns:
            Validated data

        Raises:
            ValidationError: If validation fails
        """
        validated = {}

        # Required fields
        if not data.get("name"):
            raise ValidationError("Substitute group name is required")

        name = data["name"].strip()
        if len(name) < 3 or len(name) > 200:
            raise ValidationError(
                "Substitute group name must be between 3 and 200 characters"
            )
        validated["name"] = name

        if "process_subprocess_id" not in data or not isinstance(
            data["process_subprocess_id"], int
        ):
            raise ValidationError("Valid process_subprocess_id is required")
        validated["process_subprocess_id"] = data["process_subprocess_id"]

        # Optional description
        description = data.get("description", "").strip()
        if len(description) > 500:
            raise ValidationError("Description must not exceed 500 characters")
        validated["description"] = description if description else None

        return validated
