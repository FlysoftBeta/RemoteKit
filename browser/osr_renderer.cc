#include "remotekit/browser/osr_renderer.h"
#include "remotekit/browser/osr/generation.h"

namespace remotekit::browser {

OsrRenderer::OsrRenderer(uint32_t width, uint32_t height, uint64_t generation)
    : state_(std::make_shared<osr::Generation>(width, height, generation)) {
  state_->Start();
}
OsrRenderer::~OsrRenderer() {
  state_->Stop();
}
bool OsrRenderer::IsGpuFaultSealed() {
  return osr::gpu_fault_sealed;
}
void OsrRenderer::SetViews(std::vector<View> views) {
  state_->SetViews(std::move(views));
}
void OsrRenderer::StopView(uint64_t id) {
  state_->StopView(id);
}
base::DictValue OsrRenderer::DescribeForConsumer(uint32_t pid) {
  return state_->Describe(pid);
}
mojo::ScopedMessagePipeHandle OsrRenderer::TakeRenderEndpoint(std::string_view token,
                                                              uint32_t pid) {
  return state_->TakeRenderEndpoint(token, pid);
}
base::DictValue OsrRenderer::Status() const {
  return state_->Status();
}
base::DictValue OsrRenderer::RenderStatus(uint64_t id) const {
  return state_->RenderStatus(id);
}
void OsrRenderer::TraceInput(const char* stage, const InputEvent& input, int status) {
  state_->TraceInput(stage, input, status);
}
void OsrRenderer::Stop() {
  state_->Stop();
}
}  // namespace remotekit::browser
