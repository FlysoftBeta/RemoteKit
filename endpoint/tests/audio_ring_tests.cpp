#include "../src/media/audio_ring.hpp"
#include "protocol/audio_timeline.h"
#include <atomic>
#include <barrier>
#include <iostream>
#include <memory>
#include <thread>
#include <stdexcept>
#include <source_location>
using namespace remotekit;
void Require(bool condition,
             const std::source_location location = std::source_location::current()) {
  if (!condition)
    throw std::runtime_error("audio ring assertion at line " + std::to_string(location.line()));
}
AudioPacket Packet(uint64_t sequence) {
  AudioPacket packet{};
  packet.sequence = sequence;
  packet.sample_index = sequence * 480;
  packet.first_sample_qpc = static_cast<int64_t>(sequence * 1000);
  for (auto& sample : packet.pcm)
    sample = static_cast<int16_t>(sequence % 30000);
  return packet;
}
void Check(const AudioPacket& packet) {
  Require(packet.sample_index == packet.sequence * 480);
  Require(packet.first_sample_qpc == static_cast<int64_t>(packet.sequence * 1000));
  for (const auto sample : packet.pcm)
    Require(sample == static_cast<int16_t>(packet.sequence % 30000));
}
uint64_t CheckConcurrentReads() {
  auto ring = std::make_unique<SharedAudio>();
  AudioPacket copy{};
  // Concurrent writer is deliberately much faster than a media clock. A
  // reader may miss blocks but must never accept a torn payload/header.
  std::atomic<bool> done{false};
  std::barrier first_read(2);
  std::jthread producer([&] {
    PublishAudio(ring.get(), Packet(10));
    first_read.arrive_and_wait();
    for (uint64_t i = 11; i < 100000; ++i)
      PublishAudio(ring.get(), Packet(i));
    done = true;
  });
  uint64_t reads = 0;
  while (!ReadAudio(ring.get(), 10, copy))
    std::this_thread::yield();
  first_read.arrive_and_wait();
  Check(copy);
  ++reads;
  while (!done.load()) {
    const auto sequence = AudioPublished(ring.get());
    if (ReadAudio(ring.get(), sequence, copy)) {
      Check(copy);
      ++reads;
    }
  }
  producer.join();
  Require(reads > 0);
  return reads;
}
int main() try {
  const auto reads = CheckConcurrentReads();
  AudioTimeline timeline;
  Require(timeline.Plan(1, 1, 0, 1000, true).step == AudioStep::start);
  timeline.Commit(1, 1, 0, 1000);
  Require(timeline.Plan(1, 2, 480, 2000, false).step == AudioStep::continuous);
  auto short_gap = timeline.Plan(1, 3, 480 * 9, 10000, true);
  Require(short_gap.step == AudioStep::pad && short_gap.silence_blocks == 8);
  Require(timeline.Plan(1, 3, 480 * 10, 11000, true).step == AudioStep::restart_gap);
  Require(timeline.Plan(1, 2, 1, 2000, false).step == AudioStep::reject);
  Require(timeline.Plan(1, 1, 480, 2000, false).step == AudioStep::reject);
  timeline.Commit(1, 3, 480 * 9, 10000);
  Require(timeline.Plan(1, 4, 480, 11000, true).step == AudioStep::reject);
  Require(timeline.Plan(2, 1, 0, 11000, true).step == AudioStep::restart_epoch);
  timeline.Commit(2, 1, 0, 11000);
  Require(timeline.Plan(1, 4, 480 * 10, 12000, true).step == AudioStep::reject);
  Require(timeline.Plan(2, 2, 480, 12000, true).step == AudioStep::restart_discontinuity);
  Require(timeline.Plan(2, 2, 480, 10000, false).step == AudioStep::reject);
  auto ring = std::make_unique<SharedAudio>();
  AudioPacket copy{};
  Require(!ReadAudio(ring.get(), 0, copy));
  PublishAudio(ring.get(), Packet(1));
  Require(AudioPublished(ring.get()) == 1 && ReadAudio(ring.get(), 1, copy));
  Check(copy);
  PublishAudio(ring.get(), Packet(9));
  Require(!ReadAudio(ring.get(), 1, copy));
  Require(ReadAudio(ring.get(), 9, copy));
  Check(copy);
  const auto name = "Local\\RemoteKit.audio.test." + std::to_string(GetCurrentProcessId());
  media::AudioRing reader;
  reader.Open(name, 11, 22);
  HANDLE handle = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name.c_str());
  Require(handle != nullptr);
  auto* writer = static_cast<SharedAudio*>(
      MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedAudio)));
  Require(writer != nullptr);
  Require(writer->generation == 11 && writer->session_id == 22);
  for (uint64_t i = 1; i <= 20; ++i)
    PublishAudio(writer, Packet(i));
  uint64_t gaps = 0;
  Require(reader.Poll(copy, gaps));
  Require(copy.sequence == 20 && gaps == 19);
  Check(copy);
  Require(!reader.Poll(copy, gaps));
  reader.Close();
  // Producer's mapping reference remains valid after Endpoint close.
  PublishAudio(writer, Packet(21));
  UnmapViewOfFile(writer);
  CloseHandle(handle);
  reader.Open(name, 33, 44);
  Require(!reader.Poll(copy, gaps));
  std::cout << "audio ring passed, concurrent reads=" << reads << '\n';
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
