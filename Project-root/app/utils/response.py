from flask import jsonify


class APIResponse:
    """Standardized API response wrapper"""

    @staticmethod
    def success(data=None, message: str = "Success", status_code: int = 200):
        return jsonify(
            {
                "success": True,
                "data": data,
                "error": None,
                "message": message,
            }
        ), status_code

    @staticmethod
    def error(error_code: str, message: str, status_code: int = 400, data=None):
        return jsonify(
            {
                "success": False,
                "data": data,
                "error": error_code,
                "message": message,
            }
        ), status_code

    @staticmethod
    def created(data=None, message: str = "Resource created"):
        return APIResponse.success(data, message, 201)

    @staticmethod
    def not_found(resource_type: str, resource_id):
        return APIResponse.error(
            "not_found",
            f"{resource_type} with ID {resource_id} not found",
            404,
        )


# Import in blueprints:
# from app.utils.response import APIResponse
