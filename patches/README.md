# Chromium patchset

当前清单为空。RemoteKit SDK 通过 Chromium 官方
`//third_party/webrtc_overrides:webrtc_component` 使用 libwebrtc，
无需修改 `timeutils` 的 target visibility。

后续修改 Chromium tracked 源码时，将补丁加入 `manifest.json` 的有序清单，
填写 SHA-256，并用 `tools/patchset.py` 管理检查、应用和逆序撤回。
Chromium overlay `//remotekit` 由 `tools/chromium.py` 维护，不属于 tracked patch。
