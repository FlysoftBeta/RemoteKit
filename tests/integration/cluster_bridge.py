"""Launch the authenticated local-node bridge for JSONL integration probes."""
import json
from pathlib import Path


def endpoint_command(endpoint, browser, data_path, *, control_private_key=None, object_index=None,
                     metrics_file=None, **config):
    root = Path(data_path).resolve()
    command = [
        "node", str(Path(__file__).with_name("cluster-bridge.mjs")),
        "--endpoint=" + str(Path(endpoint).resolve()),
        "--node-root=" + str(root),
        "--config=" + json.dumps(config),
    ]
    for name, value in (
        ("control-private-key", control_private_key),
        ("browser", Path(browser).resolve()),
        ("object-index", object_index),
        ("metrics-file", metrics_file),
    ):
        if value is not None:
            command.append("--" + name + "=" + str(value))
    return command
