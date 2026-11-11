#include "http.hpp"
#include <winhttp.h>
#include <algorithm>
#include <charconv>

namespace remotekit::release {
namespace {
struct Internet {
  HINTERNET value = nullptr;
  explicit Internet(HINTERNET handle) : value(handle) {
    Io(value != nullptr, "release HTTP transport failed");
  }
  ~Internet() { WinHttpCloseHandle(value); }
};
std::wstring Wide(const std::string& text) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                 static_cast<int>(text.size()), nullptr, 0);
  Require(size > 0, "invalid HTTP URL encoding");
  std::wstring out(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
                      out.data(), size);
  return out;
}
URL_COMPONENTS Crack(std::wstring& wide) {
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  parts.dwHostNameLength = parts.dwUserNameLength = parts.dwPasswordLength = parts.dwUrlPathLength =
      parts.dwExtraInfoLength = static_cast<DWORD>(-1);
  Require(WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &parts) &&
              (parts.nScheme == INTERNET_SCHEME_HTTP || parts.nScheme == INTERNET_SCHEME_HTTPS) &&
              parts.dwHostNameLength && !parts.dwUserNameLength && !parts.dwPasswordLength,
          "invalid HTTP URL");
  return parts;
}
std::wstring Header(HINTERNET request, DWORD name) {
  DWORD size = 0;
  WinHttpQueryHeaders(request, name, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size,
                      WINHTTP_NO_HEADER_INDEX);
  if (!size)
    return {};
  std::wstring out(size / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(request, name, WINHTTP_HEADER_NAME_BY_INDEX, out.data(), &size,
                           WINHTTP_NO_HEADER_INDEX))
    return {};
  out.resize(size / sizeof(wchar_t));
  while (!out.empty() && !out.back())
    out.pop_back();
  return out;
}
std::optional<uint32_t> RetryAfter(HINTERNET request) {
  auto value = Header(request, WINHTTP_QUERY_RETRY_AFTER);
  if (value.empty())
    return {};
  if (std::all_of(value.begin(), value.end(), [](wchar_t c) { return c >= L'0' && c <= L'9'; })) {
    uint64_t seconds = 0;
    for (auto c : value)
      seconds = std::min<uint64_t>(86400, seconds * 10 + c - L'0');
    return static_cast<uint32_t>(seconds * 1000);
  }
  SYSTEMTIME date{};
  if (WinHttpTimeToSystemTime(value.c_str(), &date)) {
    FILETIME target{}, now{};
    if (SystemTimeToFileTime(&date, &target)) {
      GetSystemTimeAsFileTime(&now);
      ULARGE_INTEGER t{{target.dwLowDateTime, target.dwHighDateTime}},
          n{{now.dwLowDateTime, now.dwHighDateTime}};
      return static_cast<uint32_t>(std::min<uint64_t>(
          86400000, t.QuadPart > n.QuadPart ? (t.QuadPart - n.QuadPart) / 10000 : 0));
    }
  }
  return {};
}
}  // namespace
bool ValidUrl(const std::string& url) {
  auto delimiter = url.find("://");
  auto scheme = url.substr(0, delimiter);
  std::transform(scheme.begin(), scheme.end(), scheme.begin(),
                 [](unsigned char c) { return static_cast<char>(tolower(c)); });
  if (delimiter == url.npos || (scheme != "http" && scheme != "https") ||
      url.find_first_of("\\#") != url.npos ||
      std::any_of(url.begin(), url.end(), [](unsigned char c) { return c <= 32 || c == 127; }))
    return false;
  size_t start = url.find("://") + 3, end = url.find_first_of("/?", start);
  if (url.substr(start, end - start).find('@') != std::string::npos)
    return false;
  try {
    auto wide = Wide(url);
    Crack(wide);
    return true;
  } catch (const Failure&) {
    return false;
  }
}
Http::Http(std::string proxy, HANDLE stop, updater::Log* log)
    : proxy_(std::move(proxy)), stop_(stop), log_(log) {}
void Http::Request(const std::string& url,
                   uint64_t offset,
                   const std::function<void(bool)>& begin,
                   const std::function<void(std::span<const uint8_t>)>& consume) const {
  Require(ValidUrl(url), "invalid release HTTP URL");
  auto wide = Wide(url);
  auto parts = Crack(wide);
  std::wstring proxy;
  if (!proxy_.empty()) {
    Require(ValidUrl(proxy_), "invalid HTTP proxy");
    auto proxy_url = Wide(proxy_);
    auto proxy_parts = Crack(proxy_url);
    Require(proxy_parts.nScheme == INTERNET_SCHEME_HTTP &&
                (!proxy_parts.dwUrlPathLength ||
                 std::wstring_view(proxy_parts.lpszUrlPath, proxy_parts.dwUrlPathLength) == L"/") &&
                !proxy_parts.dwExtraInfoLength,
            "proxy must be http://host:port");
    proxy.assign(proxy_parts.lpszHostName, proxy_parts.dwHostNameLength);
    if (proxy.find(L':') != proxy.npos && !proxy.starts_with(L"["))
      proxy = L"[" + proxy + L"]";
    proxy += L":" + std::to_wstring(proxy_parts.nPort);
  }
  Internet session(WinHttpOpen(
      L"RemoteKit-Manager",
      proxy.empty() ? WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY : WINHTTP_ACCESS_TYPE_NAMED_PROXY,
      proxy.empty() ? WINHTTP_NO_PROXY_NAME : proxy.c_str(), WINHTTP_NO_PROXY_BYPASS, 0));
  Io(WinHttpSetTimeouts(session.value, 30000, 30000, 60000, 60000), "cannot set HTTP timeouts");
  std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
  Internet connection(WinHttpConnect(session.value, host.c_str(), parts.nPort, 0));
  std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
  path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
  if (path.empty())
    path = L"/";
  Internet request(
      WinHttpOpenRequest(connection.value, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER,
                         WINHTTP_DEFAULT_ACCEPT_TYPES,
                         parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0));
  std::wstring range = offset ? L"Range: bytes=" + std::to_wstring(offset) + L"-\r\n" : L"";
  Io(WinHttpSendRequest(request.value,
                        range.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : range.c_str(),
                        static_cast<DWORD>(range.size()), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
         WinHttpReceiveResponse(request.value, nullptr),
     "release HTTP transport failed");
  DWORD status = 0, status_size = sizeof(status);
  Io(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                         WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                         WINHTTP_NO_HEADER_INDEX),
     "cannot read HTTP status");
  if (status != 200 && status != 206) {
    ErrorCode code = ErrorCode::kInternal;
    if (status == 404)
      code = ErrorCode::kNotFound;
    else if (status == 401)
      code = ErrorCode::kUnauthenticated;
    else if (status == 403)
      code = ErrorCode::kForbidden;
    else if (status == 429)
      code = ErrorCode::kRateLimited;
    else if (status == 408 || (status >= 500 && status < 600))
      code = ErrorCode::kUnavailable;
    throw Failure(
        {code, "release HTTP status " + std::to_string(status), {}, RetryAfter(request.value)});
  }
  if (status == 206) {
    auto content_range = Header(request.value, WINHTTP_QUERY_CONTENT_RANGE);
    Require(content_range.starts_with(L"bytes " + std::to_wstring(offset) + L"-"),
            "invalid HTTP Content-Range");
  }
  begin(status == 206);
  std::array<uint8_t, 65536> bytes;
  while (true) {
    if (stop_ && updater::Stopping(stop_))
      Fail(ErrorCode::kCanceled, "release download stopped");
    DWORD n = 0;
    Io(WinHttpReadData(request.value, bytes.data(), static_cast<DWORD>(bytes.size()), &n),
       "release HTTP transfer interrupted");
    if (!n)
      break;
    consume(std::span(bytes).first(n));
  }
}
Bytes Http::Get(const std::string& url, uint64_t limit) const {
  Bytes bytes;
  Request(
      url, 0, [](bool) {},
      [&](std::span<const uint8_t> chunk) {
        Require(chunk.size() <= limit - bytes.size(), "release HTTP response too large");
        bytes.insert(bytes.end(), chunk.begin(), chunk.end());
      });
  return bytes;
}
void Http::LogFailure(const Error& error) const {
  if (log_)
    log_->Event(LogLevel::kWarn, "release.http_failed", LogErrorFields(error));
}
void Http::Download(const std::string& url, const fs::path& partial, uint64_t expected) const {
  uint64_t offset = fs::exists(partial) ? fs::file_size(partial) : 0;
  if (offset > expected) {
    fs::remove(partial);
    offset = 0;
  }
  if (offset == expected)
    return;
  uint64_t received = 0;
  auto started = GetTickCount64();
  std::ofstream file;
  Request(
      url, offset,
      [&](bool append) {
        if (!append)
          offset = 0;
        file.open(partial, std::ios::binary | (append ? std::ios::app : std::ios::trunc));
        Io(file.is_open(), "cannot open slice download");
      },
      [&](std::span<const uint8_t> bytes) {
        Require(bytes.size() <= expected - offset, "release slice exceeds promised size");
        Io(static_cast<bool>(file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size())),
           "cannot write slice download");
        offset += bytes.size();
        received += bytes.size();
      });
  file.close();
  Io(!file.fail() && offset == expected, "release slice transfer interrupted");
  if (log_)
    log_->Event(
        LogLevel::kInfo, "release.slice_downloaded",
        {{"file", partial.filename().string()},
         {"bytes", offset},
         {"bytesPerSecond", received * 1000 / std::max<ULONGLONG>(1, GetTickCount64() - started)}});
}
}  // namespace remotekit::release
