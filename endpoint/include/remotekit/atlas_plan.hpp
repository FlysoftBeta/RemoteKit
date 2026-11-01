#pragma once
#include <algorithm>
#include <set>
#include <tuple>
#include "remotekit/core.hpp"
#include "remotekit/atlas_dimensions.hpp"
namespace remotekit {
inline std::vector<PackItem> OrderAtlasItems(std::vector<PackItem> items) {
  std::stable_sort(items.begin(),items.end(),[](const auto& a,const auto& b){return std::pair(a.width,a.height)>std::pair(b.width,b.height);});
  return items;
}
struct AtlasPlan {int width=16,height=16;float scale=1;AtlasDimensions physical;};
// Search subset-sum widths; MaxRects establishes actual feasibility. Logical
// bounds and physical allocation bounds are intentionally separate.
inline std::optional<AtlasPlan> PlanAtlas(const std::vector<PackItem>& input,float scale,uint32_t alignment=1) {
  if(!std::isfinite(scale)||scale<.5f||scale>4||(alignment!=1&&alignment!=16))return std::nullopt;
  auto items=OrderAtlasItems(input);
  std::set<int> widths{0};int total_height=0;
  for(const auto& item:items) {
    if(item.width<1||item.height<1||item.width>8192||item.height>8192)return std::nullopt;
    std::vector<int> add;
    for(int width:widths)if(width+item.width+8<=16384)add.push_back(width+item.width+8);
    widths.insert(add.begin(),add.end());total_height=std::min(16384,total_height+item.height+8);
  }
  if(items.empty()) {auto physical=AtlasAllocationDimensions(16,16,scale,alignment);if(!physical)return std::nullopt;return AtlasPlan{16,16,scale,*physical};}
  std::optional<AtlasPlan> best;
  const auto rank=[](const AtlasPlan& p){return std::tuple(uint64_t(p.physical.width)*p.physical.height,std::max(p.physical.width,p.physical.height),p.width,p.height);};
  for(int width:widths) {
    if(width<16)width=16;
    auto strip=AtlasAllocationDimensions(width,16,scale,alignment);if(!strip)continue;
    const auto a=std::max(2u,alignment);
    const auto physical_height=std::min(8192u,16777216u/strip->width)/a*a;
    int height=std::min(total_height,std::min(16384,static_cast<int>(std::floor(physical_height/scale))));height=std::max(16,height);
    while(height>=16&&!AtlasAllocationDimensions(width,height,scale,alignment))--height;
    if(height<16)continue;
    auto packed=PackAtlas(width,height,4,items);if(!packed)continue;
    int crop_width=16,crop_height=16;
    for(const auto& placement:packed.value.placements) {crop_width=std::max(crop_width,placement.outer.x+placement.outer.width);crop_height=std::max(crop_height,placement.outer.y+placement.outer.height);}
    if(PackAtlas(crop_width,crop_height,4,items)) {width=crop_width;height=crop_height;}
    auto physical=AtlasAllocationDimensions(width,height,scale,alignment);if(!physical)continue;
    AtlasPlan candidate{width,height,scale,*physical};if(!best||rank(candidate)<rank(*best))best=candidate;
  }
  return best;
}
} // namespace remotekit
