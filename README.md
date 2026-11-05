# RemoteKit

Windows Chromium content embedder with isolated tenant sessions and WebRTC streaming.

Build from the repository root:

```powershell
python3 tools/patchset.py --chromium-root C:/src/chromium/src apply
python3 tools/chromium.py build --target remotekit_browser --target remotekit_sdk
python3 tools/export-sdk.py --out C:/src/chromium/src/out/dev --destination sdk/dist/dev
tools\build-endpoint.cmd package
cd control
npm ci
npm run build
```

Run Control with the packaged Endpoint:

```powershell
$env:REMOTEKIT_ENDPOINT = (Resolve-Path ..\build\endpoint-package\endpoint\endpoint_service.exe).Path
npm start
```

Open http://127.0.0.1:3001. Reveal the sign-in form with Up Up Down Down Left Right Left Right, then register the first administrator. Account and session data lives in SQLite. See [Control setup](control/README.md).

Checks from `control/`: `npx tsc --noEmit`, `npm test`, `npm run build`.

From the repository root:

```powershell
python3 -m unittest discover -s tools/tests -p test_patchset.py
python3 -m unittest discover -s tools/tests -p test_chromium_stage.py
python3 tools/tests/test-package-runtime-layout.py
tools\verify-sdk.cmd
python3 tests/integration/test-endpoint-service.py
```

Product scenario runners are in `tests/e2e/`; native Browser/Endpoint runners are in `tests/integration/`. They require built native binaries. Measurement entry points are in `tools/measure/`. Create a portable streaming package with `python3 tools/package-runtime.py`.
