#pragma once
#include <charconv>
#include <cstdint>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace remotekit {
// Values follow oneVPL mfxCodingOption: ON=0x10, OFF=0x20.
inline std::vector<uint32_t> ParseQsvLowPowerPattern(std::string_view text) {
  std::vector<uint32_t> result;
  if(text.empty())return result;
  while(true) {
    const auto comma=text.find(',');const auto token=text.substr(0,comma);
    if(token!="on" && token!="off")
      throw std::invalid_argument("qsv-low-power-pattern requires 1..16 comma-separated on/off entries");
    result.push_back(token=="on"?0x10u:0x20u);
    if(result.size()>16)throw std::invalid_argument("qsv-low-power-pattern permits at most 16 entries");
    if(comma==std::string_view::npos)return result;
    text.remove_prefix(comma+1);
  }
}
inline void ValidateQsvLowPowerPattern(const std::vector<uint32_t>& pattern,
                                      std::string_view encoder,bool explicit_single) {
  if(pattern.empty())return;
  if(encoder!="qsv")throw std::invalid_argument("qsv-low-power-pattern requires encoder=qsv");
  if(explicit_single)throw std::invalid_argument("qsv-low-power-pattern conflicts with explicit qsv-low-power");
}
inline size_t QsvLowPowerPatternIndex(std::string_view session,size_t size) {
  if(size<1 || size>16)throw std::invalid_argument("invalid qsv-low-power-pattern size");
  uint64_t number=0;const auto parsed=std::from_chars(session.data(),session.data()+session.size(),number);
  if(session.empty() || session.front()=='0' || parsed.ec!=std::errc{} ||
     parsed.ptr!=session.data()+session.size() || !number)
    throw std::invalid_argument("qsv-low-power-pattern requires a canonical positive uint64 Session id");
  return static_cast<size_t>((number-1)%size);
}
} // namespace remotekit
