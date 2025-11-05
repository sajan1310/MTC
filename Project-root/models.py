from flask_login import UserMixin


class User(UserMixin):
    """Custom User class to hold user data from the database."""

    def __init__(self, user_data):
        self.id = user_data["user_id"]
        self.name = user_data["name"]
        self.email = user_data["email"]
        self.role = user_data["role"]
        self.profile_picture = user_data.get("profile_picture")
        self.company = user_data.get("company")
        self.mobile = user_data.get("mobile")
