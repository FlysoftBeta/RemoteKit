"""Run against out/dev: missing adapter is a structured output error, not a reconnect loop."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests/integration"))
from browser_key import spawn_browser

runtime = Path(sys.argv[1]).resolve()
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(parents=True, exist_ok=True)
channel = f"RemoteKit.startup.probe.{os.getpid()}"
with os.add_dll_directory(str(runtime)):
    sdk = ctypes.CDLL(str(runtime / "remotekit_sdk.dll"))
    sdk.remotekit_sdk_control_connect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t,
        ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_uint32]
    sdk.remotekit_sdk_control_close.argtypes = [ctypes.c_uint64]
    assert sdk.remotekit_sdk_initialize() == 0
    process = spawn_browser([str(runtime / "remotekit_browser.exe"),
        f"--control-channel={channel}", "--session-id=1", "--tenant-id=startup-probe",
        f"--data-path={evidence}", "--use-adapter-luid=2147483647,4294967295"],
        creationflags=subprocess.CREATE_NO_WINDOW)
    handle = ctypes.c_uint64()
    serial = 0
    try:
        deadline = time.monotonic() + 15
        while sdk.remotekit_sdk_control_connect(channel.encode(), ctypes.byref(handle)):
            assert process.poll() is None, f"Browser exited: {process.returncode}"
            assert time.monotonic() < deadline, "control startup timed out"
            time.sleep(.05)

        def request(method, **fields):
            global serial
            serial += 1
            wire = json.dumps(dict(version=1, id=serial, method=method, **fields)).encode()
            output = ctypes.create_string_buffer(1024 * 1024)
            size = ctypes.c_size_t()
            status = sdk.remotekit_sdk_control_request(handle, wire, len(wire), output,
                len(output), ctypes.byref(size), 3000)
            assert status == 0, f"{method}: SDK {status}"
            return json.loads(output.raw[:size.value])

        opened = request("output.open", consumer_pid=str(os.getpid()))
        description = request("output.describe", consumer_pid=str(os.getpid()))
        status = request("output.status")
        assert opened["ok"]
        assert not description["ok"] and description["reason"] == "hardware_output_unavailable"
        assert "not present" in status["output"]["error"]
        assert status["output"]["retryable"] is False
        assert request("snapshot")["ok"] and process.poll() is None
        result = dict(pid=process.pid, description=description, output=status["output"],
                      live_control_after_failure=True)
        (evidence / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    finally:
        if handle.value:
            sdk.remotekit_sdk_control_close(handle)
        process.terminate()
        process.wait(timeout=10)
        assert sdk.remotekit_sdk_shutdown() == 0
