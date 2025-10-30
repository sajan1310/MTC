import sys
import os
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'Project-root')))

from migrations import migration_add_category_type_brand_tables
from database import init_app

load_dotenv()

# Mock Flask app for context
class MockApp:
    def __init__(self):
        self.logger = lambda: None
        self.logger.info = print
        self.logger.critical = print

if __name__ == '__main__':
    init_app(MockApp())
    migration_add_category_type_brand_tables.upgrade()
