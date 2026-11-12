#!/usr/bin/env python3
"""Verify the production clipboard bridge retains its applied Control revision."""

import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from browser_key import spawn_browser

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, default=Path("C:/src/chromium/src/out/rel/remotekit_browser.exe"))
    parser.add_argument("--work-dir", type=Path, default=ROOT / "develop/tmp/browser-clipboard-revision")
    args = parser.parse_args()
    run = args.work_dir / uuid.uuid4().hex
    run.mkdir(parents=True)
    dll_directory = os.add_dll_directory(str(args.browser.parent))
    sdk = ctypes.CDLL(str(args.browser.parent / "remotekit_sdk.dll"))
    sdk.remotekit_sdk_control_connect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [
        ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
        ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_uint32,
    ]
    sdk.remotekit_sdk_control_close.argtypes = [ctypes.c_uint64]
    assert sdk.remotekit_sdk_initialize() == 0
    channel = "RemoteKit.clipboardRevision." + uuid.uuid4().hex
    handle = ctypes.c_uint64()
    evidence = []
    with (run / "browser.log").open("wb") as log:
        browser = spawn_browser([
            str(args.browser), "--control-channel=" + channel,
            "--browser-incarnation=" + channel, "--session-id=1", "--tenant-id=1",
            "--remotekit-render-host=offscreen", "--data-path=" + str(run / "state"),
        ], stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 15
            while sdk.remotekit_sdk_control_connect(channel.encode(), ctypes.byref(handle)):
                assert time.monotonic() < deadline, "Browser control did not connect"
                time.sleep(0.05)

            def rpc(method, **fields):
                request = dict(version=1, id=len(evidence) + 1, method=method, **fields)
                encoded = json.dumps(request).encode()
                output = ctypes.create_string_buffer(1024 * 1024)
                size = ctypes.c_size_t()
                status = sdk.remotekit_sdk_control_request(
                    handle, encoded, len(encoded), output, len(output), ctypes.byref(size), 10000,
                )
                assert status == 0, status
                reply = json.loads(output.raw[:size.value])
                evidence.append(dict(request=request, response=reply))
                assert reply["ok"], reply
                return reply

            assert rpc("clipboard.read")["baseRevision"] == "0"
            for revision in ("7", "9", "18446744073709551615"):
                written = rpc("clipboard.write", revision=revision, text="same text", html="<b>same text</b>")
                assert written["baseRevision"] == revision
                read = rpc("clipboard.read")
                assert read["baseRevision"] == revision, read
                assert read["text"] == "same text", read
                assert read["html"] == "<b>same text</b>", read
        finally:
            if handle.value:
                sdk.remotekit_sdk_control_close(handle)
            try:
                browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            assert sdk.remotekit_sdk_shutdown() == 0
            (run / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
            dll_directory.close()
    print(json.dumps(dict(evidence=str(run))))


if __name__ == "__main__":
    main()
