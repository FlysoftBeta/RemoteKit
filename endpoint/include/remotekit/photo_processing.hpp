#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
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
};

PhotoRankResult RankPhotos(std::span<const std::filesystem::path> inputs,
                          const PhotoCancelled& cancelled = {});

// Writes JPEG to a caller-owned staging path. The caller cleans up on failure
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
