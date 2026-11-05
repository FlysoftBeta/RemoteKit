#include "management/link.hpp"
#include "remotekit/thread.hpp"
#include <windows.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
namespace remotekit {
bool ReadServiceLine(std::istream& input, std::string& line) {
  line.clear();
  bool overflow = false, any = false;
  char c;
  while (input.get(c)) {
    any = true;
    if (c == '\n')
      break;
    if (line.size() < 1024 * 1024)
      line += c;
    else
      overflow = true;
  }
  if (overflow)
    line.resize(1024 * 1024 + 1);
  return any;
}
namespace {
class StdioLink final : public ManagementLink {
  std::mutex mutex_, output_mutex_, callback_mutex_;
  std::condition_variable wake_;
  std::deque<std::string> queue_;
  std::atomic<bool> connected_{true};
  bool stopping_ = false, eof_ = false;
  size_t queued_bytes_ = 0;
  Disconnect disconnected_;
  std::thread reader_;
  void Finish() {
    std::lock_guard callback_lock(callback_mutex_);
    Disconnect callback;
    {
      std::lock_guard lock(mutex_);
      connected_ = false;
      eof_ = true;
      callback = disconnected_;
    }
    wake_.notify_all();
    if (callback)
      callback(1);
  }
  void Read() {
    std::string line;
    while (ReadServiceLine(std::cin, line)) {
      std::unique_lock lock(mutex_);
      wake_.wait(lock, [&] {
        return stopping_ || (queue_.size() < 256 && queued_bytes_ + line.size() <= 4 * 1024 * 1024);
      });
      if (stopping_)
        break;
      queued_bytes_ += line.size();
      queue_.push_back(std::move(line));
      wake_.notify_all();
    }
    Finish();
  }

 public:
  ~StdioLink() override {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
      disconnected_ = {};
    }
    wake_.notify_all();
    if (!reader_.joinable())
      return;
    while (WaitForSingleObject(reader_.native_handle(), 20) == WAIT_TIMEOUT)
      CancelSynchronousIo(reader_.native_handle());
    reader_.join();
  }
  void OnDisconnect(Disconnect callback) override {
    std::lock_guard callback_lock(callback_mutex_);
    {
      std::lock_guard lock(mutex_);
      disconnected_ = std::move(callback);
    }
    if (!reader_.joinable())
      reader_ = std::thread(
          [this] { RunThread("management stdin", [this] { Read(); }, [this] { Finish(); }); });
  }
  bool Next(std::string& line, uint64_t& generation, bool& eof) override {
    std::unique_lock lock(mutex_);
    wake_.wait_for(lock, std::chrono::milliseconds(20), [&] { return eof_ || !queue_.empty(); });
    eof = eof_ && queue_.empty();
    if (queue_.empty())
      return false;
    generation = 1;
    line = std::move(queue_.front());
    queued_bytes_ -= line.size();
    queue_.pop_front();
    wake_.notify_all();
    return true;
  }
  bool Current(uint64_t generation) override { return generation == 1 && connected_; }
  bool SendReply(uint64_t generation, const Json& reply) override {
    if (generation != 1)
      return false;
    std::lock_guard lock(output_mutex_);
    std::cout << reply.dump() << '\n' << std::flush;
    return bool(std::cout);
  }
  bool SendEvent(const Json& event, uint64_t generation) override {
    return Current(generation) && SendReply(generation, event);
  }
};
}  // namespace
std::unique_ptr<ManagementLink> MakeStdioLink() {
  return std::make_unique<StdioLink>();
}
}  // namespace remotekit
