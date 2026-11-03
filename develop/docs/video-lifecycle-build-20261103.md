# Video lifecycle build verification — 2026-11-03

## Result and scope

The reviewed scheduler admission and Viewer video watchdog/diagnostic changes pass incremental native build, normal lifecycle probes, all 293 Control tests and the Chrome89-targeted production build/startup smoke. The SDK export matches all 195 GN runtime dependencies, public headers and import library. The existing Release Endpoint needs no rebuild. These are build and CPU functional results; real GPU/WebRTC/runtime acceptance belongs to the separate runtime report.

No clean/full build, new Chromium output, performance matrix, intentional CHECK-abort probe or user-process termination was performed. Build completion was reported to root before runtime QA was released, preserving exclusive GPU experiments.

## Native and patch verification

- Ran `C:/src/depot_tools/python3.bat tools/chromium.py build --target remotekit_browser --target remotekit_sdk --target remotekit_begin_frame_probe` against existing `C:/src/chromium/src/out/dev`, defaulting to every logical CPU, in one Ninja invocation. Exit 0; 37.23 seconds, four steps: scheduler object, Viz component DLL, probe object and probe executable. Browser/SDK executable targets themselves remained current; the changed scheduler resides in the new `components_viz_service.dll`.
- `tools/patchset.py --chromium-root C:/src/chromium/src status` exits 0 and reports all 12 patches applied. This command peels the series in reverse and replays it in order in an isolated file snapshot, without changing the real Chromium tree. Patch 0012 SHA256 matches `patches/manifest.json`: `994d0b5dd044fd49fa09f2d783a0443345aeb870c24494d208ebd33b7ecbd274`.
- `tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev` exits 0. A separate byte-hash comparison verifies every one of 195 dependencies, three public headers and import library against its source.
- Existing CMake cache is Release. `ninja -C build/endpoint-package -n endpoint_service` exits 0 with `ninja: no work to do.`

All five authorized normal probe invocations exit 0:

| Invocation | Result |
| --- | --- |
| `--scheduler-admission` | Scheduler idempotent admission passed |
| default | Three scheduler lifecycle cases passed: idle/missed, GPU busy/deferred resume, immediate resize/swap |
| `--mojo-stale` | Real Mojo retired-frame completion passed |
| `--mojo-sync` | Real Mojo synchronous admission passed, wait=1 |
| `--mojo-sync-fast` | Real Mojo synchronous admission passed, wait=0 |

## Control

`npm --prefix control test` passes 293/293, zero failures/skips. `npm --prefix control run build` exits 0: TypeScript, Vite target and CSS target `chrome89`, server bundle, minimal native runtime and isolated production startup smoke all pass. Vite emits the existing advisory for the main chunk exceeding 500 kB; it does not fail the build. Startup uses only the staged deployment/runtime and verifies the page, API state, tab-create action and database creation. Smoke result: `develop/tmp/control-production-eXzhV2/result.json`.

## Artifact identity

| Artifact | SHA256 |
| --- | --- |
| `C:/src/chromium/src/out/dev/remotekit_browser.exe` | `dc6351322e7b934d2c4d7e172d158cce06b6157227787e360f259fa3c712b501` |
| `C:/src/chromium/src/out/dev/components_viz_service.dll` | `e78fcd73384f23a07508df57b6e9be01a8dcfdef647423f753131793259e75ae` |
| `C:/src/chromium/src/out/dev/remotekit_sdk.dll` | `c41fff82d4792410ed33095adced1d2d22cdc436e91e453e91f1dfc454e9e04f` |
| `C:/src/chromium/src/out/dev/remotekit_sdk.dll.lib` | `42b811ddb737cf8b9e53798d3d4d0462e3e18bec070a7c6d5a8d36b70a8ee6d5` |
| `C:/src/chromium/src/out/dev/remotekit_begin_frame_probe.exe` | `72b671eefe118c5b301d2b48653f002be11d2dafcde25c9fc6b6ceca67c17bea` |
| `build/endpoint-package/endpoint/endpoint_service.exe` | `ef383b7656ce052d9dc573b6a93eac81c0596bbf08949402312557bc555ed6c8` |
| `control/dist/server.mjs` | `575df323e83f6fa5a0b2e9bf8d8d12caad8e8772ecd299d339dbe3edfd4b634e` |
| `control/dist/client/assets/index-CjfQEW6_.js` | `1b25429f2f8271f9f17b1c9ee2302507e4b489574ec25ca47463f44bc05378c5` |

Use the complete `out/dev` Browser runtime and `sdk/dist/dev` export, with existing Release Endpoint above. Copying only the unchanged Browser EXE would omit the actual scheduler fix. Full absolute artifact paths, sizes, UTC mtimes, per-dependency/export hashes, Control output hashes and probe output are recorded in `develop/tmp/video-lifecycle-build-manifest.json`; logs are in `develop/tmp/video-lifecycle-build/`. No package was created by this build task.
