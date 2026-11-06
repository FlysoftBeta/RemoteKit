"""Give a Browser probe a fixed profile key through its sole inherited handle."""
import msvcrt
import os
import subprocess


def spawn_browser(command, **kwargs):
    reader, writer = os.pipe()
    try:
        os.write(writer, bytes([7]) * 32)
        os.close(writer)
        writer = None
        handle = msvcrt.get_osfhandle(reader)
        os.set_handle_inheritable(handle, True)
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {"handle_list": [handle]}
        return subprocess.Popen(
            [*command, "--profile-key-handle=" + str(handle)],
            startupinfo=startup, close_fds=True, **kwargs)
    finally:
        os.close(reader)
        if writer is not None:
            os.close(writer)
