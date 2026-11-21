#pragma once

#include "errors.h"
#include <cstddef>
#include <string_view>

namespace remotekit::protocol {
inline constexpr int kControlVersion = 1;
inline constexpr std::string_view kBrowserShutdown = "browser.shutdown";
inline constexpr std::string_view kStorageScavenge = "storage.scavenge";
inline constexpr std::string_view kStorageImport = "storage.import";
inline constexpr std::string_view kStorageImportStatus = "storage.import.status";
inline constexpr std::string_view kIdentity = "identity";
inline constexpr size_t kMaxSignInResultBytes = 8 * 1024;
inline constexpr std::string_view kViewSignIn = "view.signIn";
inline constexpr std::string_view kSignInEvents = "view.signIn.events";
inline constexpr std::string_view kViewAppInfo = "view.appInfo";
// A view that renders a staged PDF in the Browser's built-in pdf.js. The URL is only a marker:
// the Browser maps it to its internal viewer page and serves the bound document to that view.
inline constexpr std::string_view kPdfViewerUrl = "remotekit-pdf://viewer/";
inline constexpr int kBrowserShutdownFailureExitCode = 70;
}  // namespace remotekit::protocol
