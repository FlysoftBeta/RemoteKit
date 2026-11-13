#pragma once
#include "hardware_encoder.hpp"
#include "util/error.hpp"
namespace remotekit::media {
remotekit::Result<void> ValidateQsvGeometry(const EncoderSettings& requested,
                                            uint32_t width,
                                            uint32_t height,
                                            uint32_t crop_width,
                                            uint32_t crop_height);
}
