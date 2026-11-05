#include "gpu_device.hpp"
#include <d3d10.h>
#include <cstdio>
#include <cmath>
#include <algorithm>
namespace remotekit::media {
namespace {
bool Check(HRESULT hr, const char* name, std::string& error) {
  if (SUCCEEDED(hr))
    return true;
  char code[32];
  sprintf_s(code, "0x%08lx", static_cast<unsigned long>(hr));
  error = std::string(name) + " " + code;
  return false;
}
}  // namespace
int64_t QpcNow() {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return value.QuadPart;
}
int64_t QpcFrequency() {
  LARGE_INTEGER value{};
  QueryPerformanceFrequency(&value);
  return value.QuadPart;
}
bool CreateDevice(const LUID* luid,
                  ComPtr<ID3D11Device5>& device,
                  ComPtr<ID3D11DeviceContext4>& context,
                  std::string& error) {
  ComPtr<IDXGIFactory4> factory;
  if (!Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "DXGI factory", error))
    return false;
  ComPtr<IDXGIAdapter1> adapter;
  if (luid &&
      !Check(factory->EnumAdapterByLuid(*luid, IID_PPV_ARGS(&adapter)), "atlas adapter", error))
    return false;
  ComPtr<ID3D11Device> basic;
  ComPtr<ID3D11DeviceContext> immediate;
  D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  if (!Check(D3D11CreateDevice(adapter.Get(),
                               luid ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
                               D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                               levels, 2, D3D11_SDK_VERSION, &basic, nullptr, &immediate),
             "D3D11 hardware device", error))
    return false;
  if (!Check(basic.As(&device), "D3D11.4 device", error) ||
      !Check(immediate.As(&context), "D3D11.4 context", error))
    return false;
  ComPtr<ID3D10Multithread> protection;
  if (SUCCEEDED(basic.As(&protection)))
    protection->SetMultithreadProtected(TRUE);
  return true;
}
bool Nv12Converter::Open(ID3D11Device* device,
                         uint32_t width,
                         uint32_t height,
                         uint32_t fps,
                         std::string& error,
                         uint32_t source_width,
                         uint32_t source_height) {
  width_ = width;
  height_ = height;
  source_width_ = source_width ? source_width : width;
  source_height_ = source_height ? source_height : height;
  fps_ = fps;
  if (!Check(device->QueryInterface(IID_PPV_ARGS(&device_)), "VP device", error))
    return false;
  ComPtr<ID3D11DeviceContext> immediate;
  device_->GetImmediateContext(&immediate);
  if (!Check(immediate.As(&context_), "VP context4", error))
    return false;
  if (!Check(device_.As(&video_), "D3D11 VideoDevice", error) ||
      !Check(context_.As(&video_context_), "D3D11 VideoContext", error))
    return false;
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
  content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  content.InputFrameRate = {fps, 1};
  content.OutputFrameRate = {fps, 1};
  content.InputWidth = source_width_;
  content.InputHeight = source_height_;
  content.OutputWidth = (width + 15) & ~15u;
  content.OutputHeight = (height + 15) & ~15u;
  content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  if (!Check(video_->CreateVideoProcessorEnumerator(&content, &enumerator_), "VP enumerator",
             error))
    return false;
  UINT input = 0, output = 0;
  enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &input);
  enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &output);
  if (!(input & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) ||
      !(output & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
    error = "D3D11 VideoProcessor BGRA to NV12 unsupported";
    return false;
  }
  if (!Check(video_->CreateVideoProcessor(enumerator_.Get(), 0, &processor_), "VP create", error))
    return false;
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_color{};
  input_color.RGB_Range = 0;
  input_color.YCbCr_Matrix = 1;
  D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_color{};
  output_color.YCbCr_Matrix = 1;
  output_color.Nominal_Range = 1;
  video_context_->VideoProcessorSetStreamColorSpace(processor_.Get(), 0, &input_color);
  video_context_->VideoProcessorSetOutputColorSpace(processor_.Get(), &output_color);
  video_context_->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(), 0, FALSE);
  RECT source_rect{0, 0, static_cast<LONG>(source_width_), static_cast<LONG>(source_height_)};
  RECT rect{0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
  video_context_->VideoProcessorSetStreamSourceRect(processor_.Get(), 0, TRUE, &source_rect);
  const double sample_scale =
      std::min(double(width) / source_width_, double(height) / source_height_);
  RECT destination{
      0, 0,
      static_cast<LONG>(std::min(
          width, static_cast<uint32_t>(std::lround(source_width_ * sample_scale / 2)) * 2)),
      static_cast<LONG>(std::min(
          height, static_cast<uint32_t>(std::lround(source_height_ * sample_scale / 2)) * 2))};
  video_context_->VideoProcessorSetStreamDestRect(processor_.Get(), 0, TRUE, &destination);
  video_context_->VideoProcessorSetOutputTargetRect(processor_.Get(), TRUE, &rect);
  D3D11_VIDEO_COLOR black{};
  black.RGBA.A = 1;
  video_context_->VideoProcessorSetOutputBackgroundColor(processor_.Get(), FALSE, &black);
  return Check(device_->CreateFence(0, D3D11_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence_)),
               "VP completion fence", error);
}
bool Nv12Converter::CreateSurface(ComPtr<ID3D11Texture2D>& texture, std::string& error) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = (width_ + 15) & ~15u;
  desc.Height = (height_ + 15) & ~15u;
  desc.MipLevels = desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_NV12;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER;
  return Check(device_->CreateTexture2D(&desc, nullptr, &texture), "NV12 surface", error);
}
bool Nv12Converter::Convert(ID3D11Texture2D* bgra, ID3D11Texture2D* nv12, std::string& error) {
  D3D11_TEXTURE2D_DESC source{};
  bgra->GetDesc(&source);
  if (source.Width != source_width_ || source.Height != source_height_) {
    ComPtr<ID3D11Device> retained = device_;
    if (!Open(retained.Get(), width_, height_, fps_, error, source.Width, source.Height))
      return false;
  }
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC in{};
  in.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC out{};
  out.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11VideoProcessorInputView> input;
  ComPtr<ID3D11VideoProcessorOutputView> output;
  if (!Check(video_->CreateVideoProcessorInputView(bgra, enumerator_.Get(), &in, &input),
             "VP input", error) ||
      !Check(video_->CreateVideoProcessorOutputView(nv12, enumerator_.Get(), &out, &output),
             "VP output", error))
    return false;
  safe_to_release_ = false;
  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = input.Get();
  RK_SERVER_TRACE(trace_, "vpp_submit", trace_ids_, );
  if (!Check(video_context_->VideoProcessorBlt(processor_.Get(), output.Get(), 0, 1, &stream),
             "VP BGRA NV12", error))
    return false;
  RK_SERVER_TRACE(trace_, "vpp_blt_return", trace_ids_, );
  const uint64_t value = ++sequence_;
  if (!Check(context_->Signal(fence_.Get(), value), "VP Signal", error))
    return false;
  context_->Flush();
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!event) {
    error = "VP completion event";
    return false;
  }
  HRESULT hr = fence_->SetEventOnCompletion(value, event);
  RK_SERVER_TRACE(trace_, "vpp_wait_begin", trace_ids_, rk_record.fence = value;
                  rk_record.status = hr;);
  const DWORD wait = SUCCEEDED(hr) ? WaitForSingleObject(event, 5000) : WAIT_FAILED;
  RK_SERVER_TRACE(trace_, "vpp_wait_return", trace_ids_, rk_record.fence = value;
                  rk_record.status = static_cast<int>(wait););
  CloseHandle(event);
  if (wait != WAIT_OBJECT_0 || fence_->GetCompletedValue() == UINT64_MAX) {
    safe_to_release_ = FAILED(device_->GetDeviceRemovedReason());
    error = "VP GPU completion failed";
    return false;
  }
  safe_to_release_ = true;
  RK_SERVER_TRACE(trace_, "vpp_complete", trace_ids_, rk_record.fence = value;);
  return true;
}
}  // namespace remotekit::media
