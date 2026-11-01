#include "media/atlas_pool.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

using remotekit::SharedAtlasStatus;
using remotekit::media::AtlasPool;
void Require(bool value){if(!value)throw std::runtime_error("atlas publication test failed");}
int main() {
 try {
  remotekit_sdk_atlas_setup setup{};setup.generation=7;setup.width=1936;setup.height=1088;
  remotekit::SharedAtlasMapping mapping{};
  remotekit::SharedAtlasFrame frame{};
  std::string error="old error";
  auto read=[&]{return AtlasPool::ReadPublication(mapping,setup,frame,error);};
  // A writer in progress cannot trigger recovery from an incomplete status.
  mapping.publication_sequence=1;
  mapping.frame.status=SharedAtlasStatus::kReconfigureNeeded;
  frame.generation=7;frame.ready_fence_value=99; // Caller output must not survive an unstable read.
  Require(read()==AtlasPool::Result::idle && error.empty());
  Require(frame.generation==0 && frame.ready_fence_value==0);
  mapping.publication_sequence=2;
  // The edge must survive stale/empty payload fields: it asks for a new setup,
  // and must never be diagnosed as a mismatched frame or inferred from text.
  Require(read()==AtlasPool::Result::reconfigure && error.empty());
  for(auto status:{SharedAtlasStatus::kStopped,SharedAtlasStatus::kDeviceLost,SharedAtlasStatus::kFailed,
                   static_cast<SharedAtlasStatus>(99)}) {
   mapping.frame.status=status;
   Require(read()==AtlasPool::Result::error && !error.empty());
  }
  mapping.frame.status=SharedAtlasStatus::kStarting;
  Require(read()==AtlasPool::Result::idle && error.empty());
  mapping.frame.status=SharedAtlasStatus::kRunning;
  Require(read()==AtlasPool::Result::error); // Running still requires valid metadata.
  mapping.frame.generation=7;mapping.frame.width_pixels=1936;mapping.frame.height_pixels=1088;
  mapping.frame.frame_id=1;mapping.frame.ready_fence_value=1;
  mapping.frame.view_count=1;
  auto& view=mapping.frame.views[0];view.x_pixels=8;view.y_pixels=4;
  view.width_pixels=1920;view.height_pixels=1080;
  view.atlas_pixels_per_dip=1;view.page_device_scale_factor=1;
  Require(read()==AtlasPool::Result::ready && error.empty());
  view.atlas_pixels_per_dip=std::numeric_limits<float>::quiet_NaN();
  Require(read()==AtlasPool::Result::error);
  view.atlas_pixels_per_dip=1;
  mapping.frame.generation=8;
  Require(read()==AtlasPool::Result::error); // A spontaneous new generation is not reconfigure.
  mapping.frame.status=SharedAtlasStatus::kReconfigureNeeded;
  Require(read()==AtlasPool::Result::reconfigure && error.empty());
  // Terminal snapshots require a frozen matching producer and cannot regress
  // beyond a previously borrowed/copied fence, even on a typed edge.
  mapping.frame.generation=7;mapping.frame.ready_fence_value=12;
  Require(AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error));
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,8,10,error));
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,13,error));
  mapping.frame.status=SharedAtlasStatus::kRunning;
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error));
  Require(AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error,true));
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,8,10,error,true));
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,13,error,true));
  mapping.frame.ready_fence_value=UINT64_MAX;
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error,true));
  mapping.frame.ready_fence_value=12;
  mapping.frame.status=static_cast<SharedAtlasStatus>(99);
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error,true));
  mapping.frame.status=SharedAtlasStatus::kStopped;
  Require(AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error));
  mapping.frame.ready_fence_value=UINT64_MAX;
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,10,error));
  mapping.frame.ready_fence_value=0;mapping.frame.frame_id=0;
  Require(AtlasPool::ValidateTerminalPublication(mapping.frame,7,0,error));
  Require(!AtlasPool::ValidateTerminalPublication(mapping.frame,7,1,error));
  std::cout<<"atlas publication typed recovery passed\n";return 0;
 }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
