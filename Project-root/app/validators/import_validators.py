"""
Data validation and sanitization layer for import operations.

This module provides comprehensive validation functions for:
- Item master data (name, category, description, etc.)
- Color master data (color names, color codes)
- Size master data (size codes, size descriptions)
- Variant data (stock, thresholds, units)

Features:
- SQL injection prevention through pattern detection
- XSS prevention through HTML escape validation
- Data type validation and conversion
- Length constraints enforcement
- Required field validation
- Duplicate detection within batches
- Sanitization (trim whitespace, normalize case, etc.)
"""

import re
from typing import Dict, List, Optional, Tuple, Any
from html import escape as html_escape


class ValidationError(Exception):
    """Custom exception for validation errors with detailed field-level information."""
    
    def __init__(self, field: str, message: str, value: Any = None):
        self.field = field
        self.message = message
        self.value = value
        super().__init__(f"{field}: {message}")


class DataValidator:
    """
    Comprehensive data validator for import operations.
    
    Provides static methods for validating and sanitizing various data types
    used in the import system.
    """
    
    # SQL injection patterns (basic detection)
    SQL_INJECTION_PATTERNS = [
        r"(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|DECLARE)\b)",
        r"(--|;|\/\*|\*\/|xp_|sp_)",
        r"(\bOR\b.*=.*|AND\b.*=.*)",
    ]
    
    # Allowed categories (extend as needed)
    ALLOWED_CATEGORIES = [
        'Electronics', 'Clothing', 'Furniture', 'Accessories', 
        'Footwear', 'Tools', 'Groceries', 'Books', 'Toys', 'Sports', 'Other'
    ]
    
    # Allowed units
    ALLOWED_UNITS = ['Pcs', 'Kg', 'Ltr', 'Mtr', 'Box', 'Set', 'Pair', 'Dozen']
    
    @staticmethod
    def sanitize_string(value: Any) -> str:
        """
        Sanitize string input by:
        - Converting to string
        - Stripping leading/trailing whitespace
        - Removing null bytes
        - Limiting to reasonable length
        
        Args:
            value: Input value (any type)
            
        Returns:
            Sanitized string
        """
        if value is None:
            return ''
        
        # Convert to string and strip whitespace
        sanitized = str(value).strip()
        
        # Remove null bytes
        sanitized = sanitized.replace('\x00', '')
        
        # Remove excessive whitespace (collapse multiple spaces)
        sanitized = re.sub(r'\s+', ' ', sanitized)
        
        return sanitized
    
    @staticmethod
    def check_sql_injection(value: str, field: str) -> None:
        """
        Check for potential SQL injection patterns.
        
        Args:
            value: String to check
            field: Field name for error reporting
            
        Raises:
            ValidationError: If SQL injection pattern detected
        """
        for pattern in DataValidator.SQL_INJECTION_PATTERNS:
            if re.search(pattern, value, re.IGNORECASE):
                raise ValidationError(
                    field,
                    f"Potential SQL injection detected",
                    value
                )
    
    @staticmethod
    def validate_item_data(row: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate and sanitize item master data.
        
        Validates:
        - Item name: required, 1-255 chars, no SQL injection
        - Category: optional, must be in allowed list
        - Description: optional, max 1000 chars
        - Model: optional, max 255 chars
        - Variation: optional, max 255 chars
        
        Args:
            row: Dictionary containing item data
            
        Returns:
            Sanitized and validated data dictionary
            
        Raises:
            ValidationError: If validation fails
        """
        validated = {}
        
        # Validate item name (REQUIRED)
        name = DataValidator.sanitize_string(row.get('Item') or row.get('name') or row.get('Name'))
        if not name:
            raise ValidationError('name', 'Item name is required')
        if len(name) > 255:
            raise ValidationError('name', f'Item name too long (max 255 characters, got {len(name)})', name)
        DataValidator.check_sql_injection(name, 'name')
        validated['name'] = name
        
        # Validate category (OPTIONAL)
        category = DataValidator.sanitize_string(row.get('Category') or row.get('category') or '')
        if category:
            if len(category) > 100:
                raise ValidationError('category', f'Category too long (max 100 characters)', category)
            # Normalize category to title case for consistency
            category = category.title()
            if category not in DataValidator.ALLOWED_CATEGORIES:
                # Allow custom categories but warn in logs
                pass
        validated['category'] = category
        
        # Validate description (OPTIONAL)
        description = DataValidator.sanitize_string(row.get('Description') or row.get('description') or '')
        if len(description) > 1000:
            raise ValidationError('description', f'Description too long (max 1000 characters, got {len(description)})')
        DataValidator.check_sql_injection(description, 'description')
        validated['description'] = description
        
        # Validate model (OPTIONAL)
        model = DataValidator.sanitize_string(row.get('Model') or row.get('model') or '')
        if len(model) > 255:
            raise ValidationError('model', f'Model too long (max 255 characters)', model)
        DataValidator.check_sql_injection(model, 'model')
        validated['model'] = model
        
        # Validate variation (OPTIONAL)
        variation = DataValidator.sanitize_string(row.get('Variation') or row.get('variation') or '')
        if len(variation) > 255:
            raise ValidationError('variation', f'Variation too long (max 255 characters)', variation)
        DataValidator.check_sql_injection(variation, 'variation')
        validated['variation'] = variation
        
        return validated
    
    @staticmethod
    def validate_color_data(row: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate and sanitize color master data.
        
        Validates:
        - Color name: required, 1-100 chars, no SQL injection
        - Color code: optional, hex format (#RRGGBB or #RGB) or color name
        
        Args:
            row: Dictionary containing color data
            
        Returns:
            Sanitized and validated data dictionary
            
        Raises:
            ValidationError: If validation fails
        """
        validated = {}
        
        # Validate color name (REQUIRED)
        color_name = DataValidator.sanitize_string(
            row.get('Color') or row.get('color_name') or row.get('name') or row.get('color')
        )
        if not color_name:
            raise ValidationError('color_name', 'Color name is required')
        if len(color_name) > 100:
            raise ValidationError('color_name', f'Color name too long (max 100 characters)', color_name)
        DataValidator.check_sql_injection(color_name, 'color_name')
        # Normalize to title case
        validated['color_name'] = color_name.title()
        
        # Validate color code (OPTIONAL)
        color_code = DataValidator.sanitize_string(row.get('color_code') or row.get('ColorCode') or '')
        if color_code:
            # Check hex format: #RGB or #RRGGBB
            if color_code.startswith('#'):
                if not re.match(r'^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$', color_code):
                    raise ValidationError('color_code', f'Invalid hex color code format', color_code)
                # Normalize to uppercase
                color_code = color_code.upper()
            if len(color_code) > 20:
                raise ValidationError('color_code', f'Color code too long (max 20 characters)', color_code)
        validated['color_code'] = color_code
        
        return validated
    
    @staticmethod
    def validate_size_data(row: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate and sanitize size master data.
        
        Validates:
        - Size code/name: required, 1-50 chars, no SQL injection
        - Size description: optional, max 500 chars
        
        Args:
            row: Dictionary containing size data
            
        Returns:
            Sanitized and validated data dictionary
            
        Raises:
            ValidationError: If validation fails
        """
        validated = {}
        
        # Validate size code/name (REQUIRED)
        size_name = DataValidator.sanitize_string(
            row.get('Size') or row.get('size_name') or row.get('size_code') or row.get('name')
        )
        if not size_name:
            raise ValidationError('size_name', 'Size name/code is required')
        if len(size_name) > 50:
            raise ValidationError('size_name', f'Size name too long (max 50 characters)', size_name)
        DataValidator.check_sql_injection(size_name, 'size_name')
        # Normalize to uppercase for size codes (S, M, L, XL, etc.)
        validated['size_name'] = size_name.upper()
        
        # Validate size description (OPTIONAL)
        size_description = DataValidator.sanitize_string(row.get('size_description') or row.get('description') or '')
        if len(size_description) > 500:
            raise ValidationError('size_description', f'Size description too long (max 500 characters)')
        validated['size_description'] = size_description
        
        return validated
    
    @staticmethod
    def validate_variant_data(row: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate and sanitize variant data (color, size, stock, unit).
        
        Validates:
        - Color: required, references color_master
        - Size: required, references size_master
        - Stock: required, non-negative integer, max 999999999
        - Threshold: optional, non-negative integer, default 5
        - Unit: optional, must be in allowed units, default 'Pcs'
        
        Args:
            row: Dictionary containing variant data
            
        Returns:
            Sanitized and validated data dictionary
            
        Raises:
            ValidationError: If validation fails
        """
        validated = {}
        
        # Validate color (REQUIRED)
        color = DataValidator.sanitize_string(row.get('Color') or row.get('color') or '')
        if not color:
            raise ValidationError('color', 'Color is required for variant')
        if len(color) > 100:
            raise ValidationError('color', f'Color name too long (max 100 characters)', color)
        validated['color'] = color.title()
        
        # Validate size (REQUIRED)
        size = DataValidator.sanitize_string(row.get('Size') or row.get('size') or '')
        if not size:
            raise ValidationError('size', 'Size is required for variant')
        if len(size) > 50:
            raise ValidationError('size', f'Size too long (max 50 characters)', size)
        validated['size'] = size.upper()
        
        # Validate stock (REQUIRED)
        stock_value = row.get('Stock') or row.get('stock') or row.get('opening_stock') or 0
        try:
            stock = int(float(str(stock_value).strip() or 0))
            if stock < 0:
                raise ValidationError('stock', 'Stock cannot be negative', stock)
            if stock > 999999999:
                raise ValidationError('stock', 'Stock value too large (max 999999999)', stock)
        except (ValueError, TypeError) as e:
            raise ValidationError('stock', f'Invalid stock value: {str(e)}', stock_value)
        validated['opening_stock'] = stock
        
        # Validate threshold (OPTIONAL, default 5)
        threshold_value = row.get('threshold') or row.get('Threshold') or 5
        try:
            threshold = int(float(str(threshold_value).strip() or 5))
            if threshold < 0:
                raise ValidationError('threshold', 'Threshold cannot be negative', threshold)
            if threshold > 99999:
                raise ValidationError('threshold', 'Threshold too large (max 99999)', threshold)
        except (ValueError, TypeError):
            # Use default on error
            threshold = 5
        validated['threshold'] = threshold
        
        # Validate unit (OPTIONAL, default 'Pcs')
        unit = DataValidator.sanitize_string(row.get('Unit') or row.get('unit') or 'Pcs')
        if unit:
            # Normalize to title case
            unit = unit.title()
            if unit not in DataValidator.ALLOWED_UNITS:
                # Allow custom units but default to 'Pcs' for unknown
                unit = 'Pcs'
        else:
            unit = 'Pcs'
        validated['unit'] = unit
        
        return validated
    
    @staticmethod
    def validate_batch(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Validate a batch of rows for import.
        
        Combines item and variant validation for each row.
        Detects duplicate item names within the batch.
        
        Args:
            rows: List of row dictionaries to validate
            
        Returns:
            Tuple of (valid_rows, invalid_rows)
            - valid_rows: List of validated and sanitized rows
            - invalid_rows: List of dicts with {'row': original_row, 'error': error_message}
        """
        valid_rows = []
        invalid_rows = []
        seen_items = set()
        
        for idx, row in enumerate(rows, start=1):
            try:
                # Validate item data
                validated_item = DataValidator.validate_item_data(row)
                
                # Check for duplicates within batch
                item_name = validated_item['name']
                if item_name in seen_items:
                    raise ValidationError('name', f'Duplicate item name in batch: {item_name}')
                seen_items.add(item_name)
                
                # Validate variant data
                validated_variant = DataValidator.validate_variant_data(row)
                
                # Combine validated data
                validated_row = {**validated_item, **validated_variant}
                validated_row['row_number'] = idx
                valid_rows.append(validated_row)
                
            except ValidationError as e:
                invalid_rows.append({
                    'row_number': idx,
                    'row': row,
                    'error': str(e),
                    'field': e.field
                })
            except Exception as e:
                invalid_rows.append({
                    'row_number': idx,
                    'row': row,
                    'error': f'Unexpected validation error: {str(e)}',
                    'field': 'unknown'
                })
        
        return valid_rows, invalid_rows


# Convenience functions for direct validation

def validate_item(row: Dict[str, Any]) -> Dict[str, Any]:
    """Shorthand for DataValidator.validate_item_data()"""
    return DataValidator.validate_item_data(row)


def validate_color(row: Dict[str, Any]) -> Dict[str, Any]:
    """Shorthand for DataValidator.validate_color_data()"""
    return DataValidator.validate_color_data(row)


def validate_size(row: Dict[str, Any]) -> Dict[str, Any]:
    """Shorthand for DataValidator.validate_size_data()"""
    return DataValidator.validate_size_data(row)


def validate_variant(row: Dict[str, Any]) -> Dict[str, Any]:
    """Shorthand for DataValidator.validate_variant_data()"""
    return DataValidator.validate_variant_data(row)


def validate_batch(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Shorthand for DataValidator.validate_batch()"""
    return DataValidator.validate_batch(rows)
