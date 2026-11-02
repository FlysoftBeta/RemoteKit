#pragma once
#include <memory>
#include <string>
#include <cstdint>
namespace media { class AudioManager; class AudioLogFactory; }
namespace remotekit::browser {
std::unique_ptr<media::AudioManager> CreateAudioTarget(media::AudioLogFactory* log);
// Control/UI thread. The audio thread takes ownership of the mapped view.
bool OpenAudioTarget(const std::string& name, uint64_t generation, uint64_t session);
void CloseAudioTarget();
}
