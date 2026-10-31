# Streaming matrix layers

| case | n | source | capture | copy | encode | decode | paint | render p95 ms | CPU p50/p95 | keyframes | PLI/loss Δ | relay drop/maxKB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|
| matrix-q-d1-tu1-vbr-1080p-t1-24 | 1 | 30.7 | 30.7 | 30.7 | 30.7 | 30.7 | 25.3 | 206.0 | 34.2/39.4 | 5.0 | 0.0/0.0 | 0.0/69.1 |
| matrix-q-d1-tu1-vbr-1080p-t1-48 | 1 | 30.8 | 30.9 | 30.9 | 30.9 | 30.8 | 23.1 | 213.0 | 36.3/42.9 | 5.0 | 0.0/0.0 | 0.0/62.3 |
| matrix-q-d1-tu1-vbr-1080p-t4-24 | 4 | 7.7–7.9 | 7.5–7.9 | 7.6–7.8 | 9.7–10.3 | 9.6–10.0 | 3.7–3.9 | 1098.0–1205.0 | 55.1/67.2 | 51.0–61.0 | 0.0/0.0 | 0.0/75.3–90.6 |
| matrix-q-d1-tu1-vbr-1080p-t4-48 | 4 | 7.3–8.4 | 7.2–8.1 | 7.2–8.3 | 9.6–10.5 | 9.5–10.4 | 3.7–4.3 | 1138.0–1267.0 | 57.2/70.1 | 54.0–59.0 | 0.0/0.0 | 0.0/77.9–86.9 |
| matrix-q-d1-tu1-vbr-720p-t1-24-marker-visible | 1 | 53.0 | 53.0 | 52.9 | 52.8 | 52.9 | 31.5 | 110.0 | 34.2/38.1 | 9.0 | 0.0/0.0 | 0.0/66.2 |
| matrix-q-d1-tu1-vbr-720p-t1-48-marker-visible | 1 | 53.0 | 53.0 | 52.5 | 52.4 | 52.4 | 30.7 | 130.0 | 35.7/43.4 | 8.0 | 0.0/0.0 | 0.0/61.6 |
| matrix-q-d1-tu1-vbr-720p-t4-24-marker-visible | 4 | 18.3–18.8 | 17.9–18.5 | 18.3–19.0 | 16.4–16.9 | 16.2–16.7 | 5.9–6.7 | 663.0–836.0 | 65.1/74.1 | 2.0–3.0 | 0.0/0.0 | 0.0/61.2–61.6 |
| matrix-q-d1-tu1-vbr-720p-t4-48-marker-visible | 4 | 18.4–18.8 | 17.7–18.3 | 18.3–18.6 | 16.2–16.8 | 16.2–16.9 | 6.5–6.8 | 648.0–763.0 | 63.2/73.8 | 3.0–4.0 | 0.0/0.0 | 0.0/61.5–62.0 |
| matrix-t-d4-tu7-vbr-1080p-t1-24 | 1 | 31.3 | 31.2 | 31.3 | 31.3 | 31.2 | 23.8 | 214.0 | 33.2/38.7 | 5.0 | 0.0/0.0 | 0.0/66.3 |
| matrix-t-d4-tu7-vbr-1080p-t1-48 | 1 | 30.9 | 30.9 | 30.9 | 30.9 | 30.8 | 24.7 | 203.0 | 35.1/38.6 | 5.0 | 0.0/0.0 | 0.0/81.2 |
| matrix-t-d4-tu7-vbr-1080p-t4-24 | 4 | 7.8–8.3 | 7.6–7.9 | 7.6–8.2 | 10.1–10.5 | 10.2–10.4 | 3.5–4.0 | 1033.0–1171.0 | 59.8/78.6 | 47.0–61.0 | 0.0/0.0 | 0.0/74.3–83.0 |
| matrix-t-d4-tu7-vbr-1080p-t4-48 | 4 | 7.7–8.3 | 7.2–8.3 | 7.6–8.3 | 10.2–10.7 | 10.2–10.5 | 3.6–4.3 | 972.0–1165.0 | 59.5/73.1 | 54.0–59.0 | 0.0/0.0 | 0.0/80.2–112.0 |
| matrix-t-d4-tu7-vbr-720p-t1-24-marker-visible | 1 | 52.9 | 52.9 | 52.9 | 52.8 | 52.8 | 31.7 | 111.0 | 33.6/40.6 | 9.0 | 0.0/0.0 | 0.0/62.0 |
| matrix-t-d4-tu7-vbr-720p-t1-48-marker-visible | 1 | 53.2 | 53.2 | 52.7 | 52.7 | 52.6 | 31.3 | 115.0 | 33.5/44.5 | 8.0 | 0.0/0.0 | 0.0/61.6 |
| matrix-t-d4-tu7-vbr-720p-t4-24-marker-visible | 4 | 18.3–18.4 | 17.2–18.0 | 18.0–18.4 | 17.4–17.9 | 17.4–18.0 | 6.4–7.5 | 632.0–732.0 | 65.1/81.2 | 3.0–4.0 | 0.0/0.0 | 0.0/61.5–74.8 |
| matrix-t-d4-tu7-vbr-720p-t4-48-marker-visible | 4 | 18.1–18.9 | 17.3–18.7 | 18.0–18.8 | 17.4–18.4 | 17.5–18.2 | 6.3–7.9 | 601.0–715.0 | 63.8/76.9 | 3.0–4.0 | 0.0/0.0 | 0.0/61.7–66.5 |

FPS ranges cover tenants, not confidence intervals. Marker-visible retakes replace matching original cases.
Capture joins Session to browser PID using control.err, then selects its matching raw trace; its first-event +5..+25s window is not proven perfectly aligned with client measurement windows.
Relay maxima/totals include warmup. CPU is whole-host aggregate; GPU utilization and per-process attribution are absent.
Sender video bitrate uses sender bytes/time from the same SDK clock, never the client upload BWE. Missing fields remain null and are listed per row.
Marker readback/callback costs, sample counts, visibility and per-second FPS observations are retained in JSON. Invalid/absent markers do not imply zero render latency.
