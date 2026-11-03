#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
namespace remotekit {
// ITU-T H.264 Table A-1, baseline profile. Level 1b uses the SDK value 9.
// Rate, frame-size and macroblock-rate limits share one source of truth.
struct H264LevelLimit {uint32_t level,mbps,fs,kbps,cpb_kbits;};
inline const H264LevelLimit* FindH264LevelLimit(uint32_t level) {
 static constexpr H264LevelLimit limits[]={
  {9,1485,99,128,350},{10,1485,99,64,175},{11,3000,396,192,500},
  {12,6000,396,384,1000},{13,11880,396,768,2000},{20,11880,396,2000,2000},
  {21,19800,792,4000,4000},{22,20250,1620,4000,4000},{30,40500,1620,10000,10000},
  {31,108000,3600,14000,14000},{32,216000,5120,20000,20000},
  {40,245760,8192,20000,25000},{41,245760,8192,50000,62500},
  {42,522240,8704,50000,62500},{50,589824,22080,135000,135000},
  {51,983040,36864,240000,240000},{52,2073600,36864,240000,240000}};
 for(const auto& value:limits)if(value.level==level)return &value;
 return nullptr;
}
struct H264RateBudget {uint32_t bitrate_bps=0,cpb_kb=0;};
inline H264RateBudget H264RateLimits(uint32_t level) {
 const auto* cap=FindH264LevelLimit(level);
 return cap?H264RateBudget{cap->kbps*1000,cap->cpb_kbits/8}:H264RateBudget{};
}
// Maximum integer frame rate at these actual coded dimensions. This does not
// resize or select a network rate. Zero means no legal frame rate/dimensions.
inline uint32_t H264FrameRateLimit(uint32_t width,uint32_t height,uint32_t level) {
 const auto* cap=FindH264LevelLimit(level);
 if(!cap || !width || !height)return 0;
 const uint64_t mb_width=(uint64_t(width)+15)/16,mb_height=(uint64_t(height)+15)/16;
 const uint64_t frame_mbs=mb_width*mb_height;
 if(frame_mbs>cap->fs || mb_width*mb_width>8ull*cap->fs || mb_height*mb_height>8ull*cap->fs)return 0;
 return static_cast<uint32_t>(cap->mbps/frame_mbs);
}
struct MediaSampling {
 uint32_t width=0,height=0;double scale=0;
 uint32_t level=0,fps=0,max_frame_macroblocks=0,max_macroblocks_per_second=0;
 const char* limitation="unknown";
};
// ITU-T H.264 Table A-1, also used by WebRTC H264SupportedLevel. Input
// dimensions remain the original atlas; this only selects encoder sampling.
inline MediaSampling FitH264Sampling(uint32_t width,uint32_t height,uint32_t fps,uint32_t level,
                                     uint32_t max_width=4096,uint32_t max_height=4096) {
 if(!width||!height||!fps||!level)return {};
 const auto* cap=FindH264LevelLimit(level);
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
   const auto actual_scale=std::min(double(w)/width,double(h)/height);
   const char* reason="none";
   if(actual_scale<.999999) {
    const auto codec_scale=std::sqrt(double(budget)*256/pixels);
    if(double(max_width)/width<codec_scale || double(max_height)/height<codec_scale)reason="encoder-axis-limit";
    else if(axis/width<codec_scale || axis/height<codec_scale)reason="receiver-level-axis-limit";
    else reason=cap->mbps/fps<cap->fs?"receiver-level-macroblock-rate":"receiver-level-frame-size";
   }
   return {w,h,actual_scale,level,fps,cap->fs,cap->mbps,reason};
  }
  scale*=0.995;
 }
 return {};
}
}
