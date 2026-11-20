#pragma once
#include "util/error.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace remotekit {

using PhotoCancelled = std::function<bool()>;

enum class PhotoMode { kPhoto, kScan };
enum class PhotoTranscode { kJpeg, kPng };

struct PhotoGeometryResult {
  std::string kind = "unchanged";
  bool cropped = false;
};

struct PhotoOrientationResult {
  unsigned turns = 0;
  std::string state = "none";
};

template <class Json>
void to_json(Json& json, const PhotoGeometryResult& geometry) {
  json = {{"kind", geometry.kind}, {"cropped", geometry.cropped}};
}

template <class Json>
void to_json(Json& json, const PhotoOrientationResult& orientation) {
  json = {{"turns", orientation.turns}, {"state", orientation.state}};
}

struct PhotoProcessResult {
  std::uint32_t width;
  std::uint32_t height;
  PhotoGeometryResult geometry;
  unsigned quarter_turns = 0;
  PhotoOrientationResult orientation;
};

struct PhotoBurstCandidate {
  std::string frame_id;
  double score;
};

struct PhotoBurstDecision {
  std::string selected_frame_id;
  std::vector<std::string> keep_frame_ids;
  std::vector<PhotoBurstCandidate> candidates;
  bool uncertain = false;
  bool stop = false;
  std::string reason;
};

class PhotoBurstAnalyzer {
 public:
  PhotoBurstAnalyzer();
  ~PhotoBurstAnalyzer();
  Result<PhotoBurstDecision> Observe(const std::string& frame_id,
                                     std::span<const std::uint8_t> encoded,
                                     const std::vector<std::string>& available,
                                     const PhotoCancelled& cancelled = {});
  Result<PhotoBurstDecision> Finish(const std::vector<std::string>& available);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Writes lossy WebP to a caller-owned staging path. Manual turns are clockwise
// relative to the decoded, EXIF-oriented source.
Result<PhotoProcessResult> ProcessPhoto(const std::filesystem::path& input,
                                        const std::filesystem::path& output,
                                        PhotoMode mode,
                                        std::optional<unsigned> quarter_turns = {},
                                        const PhotoCancelled& cancelled = {});

Result<PhotoProcessResult> TranscodePhoto(const std::filesystem::path& input,
                                          const std::filesystem::path& output,
                                          PhotoTranscode format,
                                          const PhotoCancelled& cancelled = {});

// Produces a display-oriented JPEG up to 320 pixels per side and 64 KiB.
Result<PhotoProcessResult> CreatePhotoThumbnail(const std::filesystem::path& input,
                                                const std::filesystem::path& output,
                                                const PhotoCancelled& cancelled = {});

}  // namespace remotekit
