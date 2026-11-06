"""gunicorn settings that ship with the code.

gunicorn reads ./gunicorn.conf.py from its working directory by itself, and
deploy/mtc.service starts it in Project-root, so what is set here takes
effect on an ordinary deploy (pull + restart): no unit-file edit, no
daemon-reload. A flag on the command line still wins over anything here.
"""

import os

# Close each connection once its response is sent.
#
# nginx keeps idle connections to gunicorn and reuses them (deploy/
# nginx-mtc.conf, `keepalive 16`) for up to 60 s; gunicorn closes an idle
# one after 2 s, its default. In between, nginx can hand a request to a
# connection at the very moment gunicorn drops it. That request never
# reaches Flask: nginx logs "recv() failed (104: Connection reset by peer)
# while reading response header from upstream" and, because every RPC is a
# POST, will not try it again -- the browser gets a 502. It happened at
# 09:28:38 on 2026-11-06 (getDashboardData) and at 10:50 on 2026-11-03.
#
# With 0, gunicorn answers "Connection: close" and nginx never keeps a
# connection gunicorn is about to drop. A new connection over loopback costs
# a fraction of a millisecond. The other cure, keeping connections open
# longer than nginx does, would tie each of nginx's idle connections to one
# worker: requests would queue behind whichever worker owned the connection
# nginx picked, while the others sat idle.
keepalive = int(os.environ.get("GUNICORN_KEEPALIVE", "0"))
