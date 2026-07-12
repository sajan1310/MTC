#!/usr/bin/env python
import os
import sys
os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())
from app import create_app  # noqa: E402
from database import get_conn  # noqa: E402

app = create_app()
with app.app_context():
    with get_conn() as (conn, cur):
        cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='users'")
        print("users columns:", [r[0] for r in cur.fetchall()])
