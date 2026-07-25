#!/usr/bin/env python3
# Dev-only static server: serves files with `Cache-Control: no-store` so the
# browser doesn't cache modules across edits. Production users will go through
# the service worker (sw.js) which has its own versioned cache.
import http.server
import os
import socketserver
import sys

PORT = int(os.environ.get('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 8765))
ROOT = os.path.dirname(os.path.abspath(__file__))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'serving {ROOT} on http://localhost:{PORT} (no-cache)')
    httpd.serve_forever()
