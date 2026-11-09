#pragma once
#include "manifest.hpp"
namespace remotekit::release {
using Consume = std::function<void(std::span<const uint8_t>)>;
using Produce = std::function<void(const Consume&)>;
void Compress(const fs::path& payload,
              const fs::path& output,
              const fs::path& base,
              int level,
              unsigned workers);
void Decode(const Produce& input,
            const fs::path& output,
            const Payload& payload,
            const fs::path& base,
            bool patch);
}  // namespace remotekit::release
