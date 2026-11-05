#!/usr/bin/env python3
"""Serve only RemoteKit's local browser input fixtures on loopback."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parents[2] / 'browser/testdata'
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(directory))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'http://127.0.0.1:{server.server_port}/input.html', flush=True)
    server.serve_forever()
