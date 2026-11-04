#pragma once

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

struct PhotoPoint {
  double x;
  double y;
};

enum class PhotoMode { kRectify, kScan };

struct PhotoRankCandidate {
  std::size_t index;
  double score;  // Relative quality heuristic in [0, 1], not a probability.
};

struct PhotoRankResult {
  std::size_t selected_index;
  bool uncertain;
  std::vector<PhotoRankCandidate> candidates;
  std::string reason;
};

struct PhotoProcessResult {
  std::uint32_t width;
  std::uint32_t height;
  std::string geometry;
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
  PhotoBurstDecision Observe(const std::string& frame_id,
                             std::span<const std::uint8_t> encoded,
                             const std::vector<std::string>& available,
                             const PhotoCancelled& cancelled = {});
  PhotoBurstDecision Finish(const std::vector<std::string>& available);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

PhotoRankResult RankPhotos(std::span<const std::filesystem::path> inputs,
                          const PhotoCancelled& cancelled = {});

// Writes PNG to a caller-owned staging path. The caller cleans up on failure
// and publishes the result only on success. Corners are in displayed image
// coordinates, normalized clockwise.
PhotoProcessResult ProcessPhoto(
    const std::filesystem::path& input,
    const std::filesystem::path& output,
    PhotoMode mode,
    const std::optional<std::array<PhotoPoint, 4>>& corners = {},
    const PhotoCancelled& cancelled = {});

// Produces a display-oriented JPEG up to 320 pixels per side and 64 KiB.
PhotoProcessResult CreatePhotoThumbnail(const std::filesystem::path& input,
                                       const std::filesystem::path& output,
                                       const PhotoCancelled& cancelled = {});

}  // namespace remotekit
