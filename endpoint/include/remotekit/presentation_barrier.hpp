#pragma once
#include <cstdint>
#include <mutex>
#include <optional>

namespace remotekit {
// The mutex is held through the actual encoded publication. No caller may
// acquire this gate from an SDK encoder callback invoked by that publication.
class PresentationBarrier {
 public:
  struct Key {
    uint64_t barrier=0,generation=0,epoch=0;
    bool operator==(const Key&) const = default;
  };
  void Bind(uint64_t peer) {
    std::lock_guard lock(mutex_);peer_=peer;video_=false;waiting_=false;
    key_={};needs_keyframe_=false;
  }
  std::optional<Key> Video(uint64_t peer,bool restart=false) {
    std::lock_guard lock(mutex_);
    if(!peer || peer!=peer_)return {};
    if(!video_ || restart) {key_.barrier=++serial_;waiting_=true;needs_keyframe_=true;}
    video_=true;
    return waiting_?std::optional<Key>(key_):std::nullopt;
  }
  std::optional<Key> Layout(uint64_t generation,uint64_t epoch) {
    std::lock_guard lock(mutex_);
    if(epoch<key_.epoch)return {};
    const bool changed=epoch!=key_.epoch || generation!=key_.generation;
    if(changed) {
      key_.generation=generation;key_.epoch=epoch;
      if(video_) {key_.barrier=++serial_;waiting_=true;needs_keyframe_=true;}
    }
    return video_&&changed?std::optional<Key>(key_):std::nullopt;
  }
  bool Ready(uint64_t peer,Key key) {
    std::lock_guard lock(mutex_);
    if(!peer || peer!=peer_ || !video_ || !waiting_ || key!=key_)return false;
    waiting_=false;return true;
  }
  std::optional<Key> RefreshKey(uint64_t peer,uint64_t epoch) {
    std::lock_guard lock(mutex_);
    if(!peer || peer!=peer_ || !video_ || waiting_ || !key_.generation || !epoch || epoch!=key_.epoch)return {};
    return key_;
  }
  template<class Publish> bool Send(uint64_t peer,uint64_t epoch,bool keyframe,Publish publish) {
    std::lock_guard lock(mutex_);
    if(!peer || peer!=peer_ || !video_ || waiting_ || !key_.generation || !epoch || epoch!=key_.epoch)return false;
    if(needs_keyframe_ && !keyframe)return false;
    if(publish() && keyframe)needs_keyframe_=false;
    return true;
  }
 private:
  std::mutex mutex_;
  uint64_t peer_=0,serial_=0;
  Key key_;
  bool video_=false,waiting_=false,needs_keyframe_=false;
};
}
