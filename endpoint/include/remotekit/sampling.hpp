#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
namespace remotekit {
struct H264RateBudget {uint32_t bitrate_bps=0,cpb_kb=0;};
inline H264RateBudget H264RateLimits(uint32_t level) {
 struct Limit {uint32_t level,kbps,cpb_kbits;};
 constexpr Limit limits[]={{9,128,350},{10,64,175},{11,192,500},{12,384,1000},{13,768,2000},
  {20,2000,2000},{21,4000,4000},{22,4000,4000},{30,10000,10000},{31,14000,14000},
  {32,20000,20000},{40,20000,25000},{41,50000,62500},{42,50000,62500},
  {50,135000,135000},{51,240000,240000},{52,240000,240000}};
 const Limit* result=nullptr;
 for(auto& value:limits)if(value.level<=level)result=&value;
 return result?H264RateBudget{result->kbps*1000,result->cpb_kbits/8}:H264RateBudget{};
}
struct MediaSampling {uint32_t width=0,height=0;double scale=0;};
// ITU-T H.264 Table A-1, also used by WebRTC H264SupportedLevel. Input
// dimensions remain the original atlas; this only selects encoder sampling.
inline MediaSampling FitH264Sampling(uint32_t width,uint32_t height,uint32_t fps,uint32_t level,
                                     uint32_t max_width=4096,uint32_t max_height=4096) {
 struct Limit {uint32_t level,mbps,fs;};
 constexpr Limit limits[]={{9,1485,99},{10,1485,99},{11,3000,396},{12,6000,396},{13,11880,396},
  {20,11880,396},{21,19800,792},{22,20250,1620},{30,40500,1620},{31,108000,3600},
  {32,216000,5120},{40,245760,8192},{41,245760,8192},{42,522240,8704},
  {50,589824,22080},{51,983040,36864},{52,2073600,36864}};
 if(!width||!height||!fps||!level)return {};
 const Limit* cap=nullptr;
 for(auto& limit:limits)if(limit.level<=level)cap=&limit;
 if(!cap)return {};
 const uint64_t budget=std::min<uint64_t>(cap->fs,cap->mbps/fps);
 if(!budget)return {};
 const double pixels=double(width)*height;
 const double axis=std::min(4096.0,std::floor(std::sqrt(8.0*cap->fs))*16);
 double scale=std::min({1.0,axis/width,axis/height,double(max_width)/width,double(max_height)/height,std::sqrt(double(budget)*256/pixels)});
 for(int attempt=0;attempt<200;++attempt) {
  auto w=std::max(2u,static_cast<uint32_t>(std::floor(width*scale/2))*2);
  auto h=std::max(2u,static_cast<uint32_t>(std::floor(height*scale/2))*2);
  if(uint64_t((w+15)/16)*((h+15)/16)<=budget) {
   const double uniform=std::min(double(w)/width,double(h)/height);
   w=std::min(w,std::max(2u,static_cast<uint32_t>(std::lround(width*uniform/2))*2));
   h=std::min(h,std::max(2u,static_cast<uint32_t>(std::lround(height*uniform/2))*2));
   return {w,h,std::min(double(w)/width,double(h)/height)};
  }
  scale*=0.995;
 }
 return {};
}
}
