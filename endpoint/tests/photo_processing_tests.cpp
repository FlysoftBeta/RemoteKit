#include "files/photo_processing.hpp"
#include "files/photo_scan.hpp"
#include "files/photo_geometry.hpp"
#include <webp/decode.h>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <chrono>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string_view>

namespace {

using namespace remotekit;
using Microsoft::WRL::ComPtr;

void Require(bool condition, const std::string& message) {
  if (!condition)
    throw std::runtime_error(message);
}

void Check(HRESULT result) {
  Require(SUCCEEDED(result), "WIC fixture setup or readback failed");
}

template <typename F>
void RequireError(F operation, remotekit::ErrorCode expected) {
  auto result = operation();
  Require(!result && result.error().code == expected, "unexpected result error");
}

template <class T>
T Take(remotekit::Result<T> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
  return std::move(result).value();
}
inline void Take(remotekit::Result<void> result) {
  if (!result) {
    std::cerr << result.error().message << '\n';
    std::exit(1);
  }
}

class Fixtures {
 public:
  Fixtures() {
    Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                           IID_PPV_ARGS(&factory_)));
    dir = std::filesystem::temp_directory_path() /
          ("remotekit-photo-tests-" + std::to_string(GetCurrentProcessId()) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(dir);
  }
  ~Fixtures() {
    factory_.Reset();
    CoUninitialize();
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
  }

  std::filesystem::path Encode(const char* name, const cv::Mat& image, const GUID& container) {
    auto path = dir / name;
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> properties;
    Check(factory_->CreateStream(&stream));
    Check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE));
    Check(factory_->CreateEncoder(container, nullptr, &encoder));
    Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
    Check(encoder->CreateNewFrame(&frame, &properties));
    if (container == GUID_ContainerFormatJpeg) {
      wchar_t name[] = L"ImageQuality";
      PROPBAG2 option{};
      option.pstrName = name;
      VARIANT quality{};
      quality.vt = VT_R4;
      quality.fltVal = 0.70f;
      Check(properties->Write(1, &option, &quality));
    }
    Check(frame->Initialize(properties.Get()));
    Check(frame->SetSize(image.cols, image.rows));
    const auto desired =
        image.channels() == 4 ? GUID_WICPixelFormat32bppBGRA : GUID_WICPixelFormat24bppBGR;
    auto format = desired;
    Check(frame->SetPixelFormat(&format));
    Require(format == desired, "fixture encoder changed pixel format");
    Check(frame->WritePixels(image.rows, static_cast<UINT>(image.step),
                             static_cast<UINT>(image.total() * image.elemSize()), image.data));
    Check(frame->Commit());
    Check(encoder->Commit());
    return path;
  }

  std::filesystem::path Png(const char* name, const cv::Mat& image) {
    return Encode(name, image, GUID_ContainerFormatPng);
  }

  cv::Mat Read(const std::filesystem::path& path, const GUID& expected = GUID_ContainerFormatJpeg) {
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    ComPtr<IWICFormatConverter> converter;
    Check(factory_->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ,
                                              WICDecodeMetadataCacheOnDemand, &decoder));
    GUID container{};
    Check(decoder->GetContainerFormat(&container));
    Require(container == expected, "unexpected output image container");
    Check(decoder->GetFrame(0, &frame));
    UINT width = 0, height = 0;
    Check(frame->GetSize(&width, &height));
    Check(factory_->CreateFormatConverter(&converter));
    Check(converter->Initialize(frame.Get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone,
                                nullptr, 0, WICBitmapPaletteTypeCustom));
    cv::Mat image(static_cast<int>(height), static_cast<int>(width), CV_8UC3);
    Check(converter->CopyPixels(nullptr, static_cast<UINT>(image.step),
                                static_cast<UINT>(image.total() * image.elemSize()), image.data));
    return image;
  }

  std::filesystem::path dir;

 private:
  ComPtr<IWICImagingFactory> factory_;
};

cv::Mat DetailFixture(cv::Scalar background, cv::Scalar ink) {
  cv::Mat image(400, 520, CV_8UC3, background);
  for (int y = 42; y < image.rows; y += 31)
    cv::putText(image, "RemoteKit photo quality", {24, y}, cv::FONT_HERSHEY_SIMPLEX, 1.1, ink, 2,
                cv::LINE_AA);
  return image;
}

void CheckBurst(Fixtures& fixtures) {
  auto jpeg = [&](const char* name, const cv::Mat& image) {
    const auto path = fixtures.Encode(name, image, GUID_ContainerFormatJpeg);
    std::ifstream file(path, std::ios::binary);
    return std::vector<std::uint8_t>(std::istreambuf_iterator<char>(file), {});
  };
  cv::Mat sharp;
  cv::resize(DetailFixture({184, 188, 192}, {28, 31, 34}), sharp, {512, 394});
  cv::Mat blur, dark, noise;
  cv::GaussianBlur(sharp, blur, {23, 5}, 6.5, 1.2);
  sharp.convertTo(dark, -1, 0.21);
  cv::RNG random(4412);
  noise.create(sharp.size(), CV_8UC3);
  random.fill(noise, cv::RNG::NORMAL, cv::Scalar::all(128), cv::Scalar::all(15));
  const auto clear_bytes = jpeg("burst-clear.jpg", sharp);
  const auto blur_bytes = jpeg("burst-blur.jpg", blur);
  const auto dark_bytes = jpeg("burst-dark.jpg", dark);
  const auto noise_bytes = jpeg("burst-noise.jpg", noise);
  PhotoBurstAnalyzer scores;
  auto analyze = [](const auto& bytes) {
    PhotoBurstAnalyzer analyzer;
    const auto result = Take(analyzer.Observe("first", bytes, {"first"}));
    Require(!result.stop, "one sample must not certify stable quality");
    return result.candidates.front().score;
  };
  const auto clear_score = analyze(clear_bytes);
  Require(clear_score > analyze(blur_bytes) + 0.16 && clear_score > analyze(dark_bytes) + 0.16 &&
              clear_score > analyze(noise_bytes) + 0.16,
          "512 px quality must separate clear detail from blur, dark detail and random noise");
  Take(scores.Observe("blur", blur_bytes, {"blur"}));
  const auto good = Take(scores.Observe("clear", clear_bytes, {"blur", "clear"}));
  Require(good.selected_frame_id == "clear" && !good.stop && !good.uncertain,
          "a single sharp frame can displace blur without certifying stable quality");
  cv::Mat similar;
  sharp.convertTo(similar, -1, 1, 4);
  const auto near_bytes = jpeg("burst-near.jpg", similar);
  const auto stop = Take(scores.Observe("near", near_bytes, {"clear", "near"}));
  Require(stop.stop && stop.candidates.size() == 1 && stop.keep_frame_ids.size() == 1 &&
              !stop.uncertain,
          "two clear, equivalent frames should stop early with one retained candidate");
  Require(Take(scores.Finish(stop.keep_frame_ids)).selected_frame_id == stop.selected_frame_id,
          "finish must select the acknowledged retained frame");
  RequireError([&] { return scores.Finish({"unseen"}); }, remotekit::ErrorCode::kInvalidRequest);

  cv::Mat blue, orange;
  cv::resize(DetailFixture({255, 174, 193}, {92, 25, 31}), blue, sharp.size());
  cv::resize(DetailFixture({94, 184, 235}, {0, 19, 69}), orange, sharp.size());
  const auto blue_bytes = jpeg("burst-blue.jpg", blue);
  const auto orange_bytes = jpeg("burst-orange.jpg", orange);
  PhotoBurstAnalyzer distinct;
  Take(distinct.Observe("blue", blue_bytes, {"blue"}));
  const auto choice = Take(distinct.Observe("orange", orange_bytes, {"blue", "orange"}));
  Require(!choice.stop && choice.uncertain && choice.keep_frame_ids.size() == 2 &&
              choice.candidates.size() == 2,
          "distinct close-quality scenes should retain both original frame IDs");
  Require(Take(distinct.Finish({"orange"})).selected_frame_id == "orange",
          "finish must not select an evicted winner");
  RequireError([&] { return distinct.Observe("blue", blue_bytes, {"blue"}); },
               remotekit::ErrorCode::kInvalidRequest);
  RequireError([&] { return distinct.Observe("missing", clear_bytes, {"orange"}); },
               remotekit::ErrorCode::kInvalidRequest);
  const cv::Mat wide(64, 513, CV_8UC3, cv::Scalar::all(160));
  RequireError([&] { return distinct.Observe("wide", jpeg("burst-wide.jpg", wide), {"wide"}); },
               remotekit::ErrorCode::kLimitExceeded);
  RequireError(
      [&] { return distinct.Observe("big", std::vector<std::uint8_t>(44 * 1024 + 1), {"big"}); },
      remotekit::ErrorCode::kLimitExceeded);
  RequireError(
      [&] {
        return distinct.Observe("cancelled", clear_bytes, {"cancelled"}, [] { return true; });
      },
      remotekit::ErrorCode::kCanceled);
}

cv::Mat ReadWebp(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  const std::vector<std::uint8_t> bytes(std::istreambuf_iterator<char>(file), {});
  int width = 0;
  int height = 0;
  Require(WebPGetInfo(bytes.data(), bytes.size(), &width, &height), "WebP bitstream required");
  cv::Mat pixels(height, width, CV_8UC3);
  Require(
      WebPDecodeBGRInto(bytes.data(), bytes.size(), pixels.data, pixels.total() * pixels.elemSize(),
                        static_cast<int>(pixels.step)) != nullptr,
      "WebP readback failed");
  return pixels;
}

void CheckDocuments(Fixtures& fixtures) {
  cv::Mat flat(1200, 900, CV_8UC3, cv::Scalar::all(225));
  for (int y = 90; y < 1140; y += 45)
    cv::putText(flat, "Printed document text and retained notes", {45, y}, cv::FONT_HERSHEY_SIMPLEX,
                .8, {35, 35, 35}, 2, cv::LINE_AA);
  const std::array<cv::Point2f, 4> source{{{0, 0}, {899, 0}, {899, 1199}, {0, 1199}}};
  const double yaw = 20 * CV_PI / 180, pitch = 15 * CV_PI / 180, roll = 8 * CV_PI / 180;
  const cv::Matx33d rx(1, 0, 0, 0, std::cos(pitch), -std::sin(pitch), 0, std::sin(pitch),
                       std::cos(pitch));
  const cv::Matx33d ry(std::cos(yaw), 0, std::sin(yaw), 0, 1, 0, -std::sin(yaw), 0, std::cos(yaw));
  const cv::Matx33d rz(std::cos(roll), -std::sin(roll), 0, std::sin(roll), std::cos(roll), 0, 0, 0,
                       1);
  std::array<cv::Point2f, 4> target;
  for (int i = 0; i < 4; ++i) {
    const auto point = rz * ry * rx * cv::Vec3d(source[i].x - 450, source[i].y - 600, 0);
    target[i] = {float(600 + 1700 * point[0] / (point[2] + 2200)),
                 float(700 + 1700 * point[1] / (point[2] + 2200))};
  }
  const auto camera = cv::getPerspectiveTransform(source.data(), target.data());
  cv::Mat page;
  cv::warpPerspective(flat, page, camera, {1200, 1400}, cv::INTER_LINEAR, cv::BORDER_CONSTANT,
                      cv::Scalar(150, 40, 20));
  const auto detected = Take(photo::AnalyzeGeometry(page, {}));
  Require(detected.kind == "perspective", "perspective text page must be rectified");
  Require(!detected.has_flow, "planar text must not require residual flow");
  const auto scale = cv::Matx33d(detected.scale, 0, 0, 0, detected.scale, 0, 0, 0, 1);
  const cv::Mat corrected = cv::Mat(scale.inv() * detected.matrix * scale) * camera;
  std::vector<cv::Point2f> baseline{{80, 300}, {780, 300}, {80, 900}, {780, 900}};
  cv::perspectiveTransform(baseline, baseline, corrected);
  for (int i : {0, 2}) {
    const auto direction = baseline[i + 1] - baseline[i];
    Require(std::abs(std::atan2(direction.y, direction.x) * 180 / CV_PI) < 1,
            "rectified synthetic baselines must be horizontal");
  }
  const auto input = fixtures.Png("document.png", page);
  const auto output = fixtures.dir / "scan.webp";
  const auto scanned = Take(ProcessPhoto(input, output, PhotoMode::kScan, 0));
  Require(scanned.geometry == "perspective", "scan must apply the detected perspective");
  const auto pixels = ReadWebp(output);
  Require(pixels.cols == scanned.width && pixels.rows == scanned.height,
          "WebP dimensions match response");
  const auto invalid = fixtures.dir / "absent.webp";
  RequireError([&] { return ProcessPhoto(input, invalid, PhotoMode::kPhoto, 4); },
               ErrorCode::kInvalidRequest);
  RequireError([&] { return ProcessPhoto(input, input, PhotoMode::kScan, 0); },
               ErrorCode::kInvalidRequest);
  RequireError(
      [&] { return ProcessPhoto(input, invalid, PhotoMode::kScan, 0, [] { return true; }); },
      ErrorCode::kCanceled);
  const auto oversized =
      fixtures.Png("oversized.png", cv::Mat(2897, 2897, CV_8UC3, cv::Scalar::all(165)));
  RequireError([&] { return ProcessPhoto(oversized, invalid, PhotoMode::kPhoto, 0); },
               ErrorCode::kLimitExceeded);
  const auto broken = fixtures.dir / "broken.png";
  std::ofstream(broken, std::ios::binary) << "not an image";
  RequireError([&] { return ProcessPhoto(broken, invalid, PhotoMode::kPhoto, 0); },
               ErrorCode::kRejected);
  Require(!std::filesystem::exists(invalid), "rejected processing must not create output");

  cv::Mat nontext(600, 800, CV_8UC3, cv::Scalar(140, 45, 15));
  cv::circle(nontext, {400, 300}, 150, cv::Scalar(40, 80, 220), cv::FILLED);
  const auto untouched = Take(photo::AnalyzeGeometry(nontext, {}));
  Require(untouched.kind == "unchanged" && untouched.crops.empty(),
          "non-text images must receive neither warp nor crop");
  Require(cv::norm(Take(photo::ApplyGeometry(nontext, untouched, {248, 248, 248}, {})), nontext,
                   cv::NORM_INF) == 0,
          "non-text geometry must preserve every pixel");
}

void CheckOrientation(Fixtures& fixtures) {
  cv::Mat latin(1400, 1000, CV_8UC3, cv::Scalar::all(245));
  int index = 0;
  for (int y = 100; y < 1320; y += 48, ++index) {
    const char* text = index % 2 ? "The quick brown fox jumps over the lazy dog."
                                 : "Document scan preserves text and blue notes.";
    cv::putText(latin, text, {35, y}, cv::FONT_HERSHEY_SIMPLEX, 0.85,
                index % 5 ? cv::Scalar(30, 35, 40) : cv::Scalar(170, 60, 30), 2, cv::LINE_AA);
  }
  const auto cjk = fixtures.Read(std::filesystem::path(RK_PHOTO_TEST_DATA) / "photo_cjk.png",
                                 GUID_ContainerFormatPng);
  const auto output = fixtures.dir / "orientation.webp";
  for (const auto& upright : {latin, cjk}) {
    for (unsigned turns = 0; turns < 4; ++turns) {
      cv::Mat rotated = upright.clone();
      if (turns)
        cv::rotate(rotated, rotated,
                   turns == 1   ? cv::ROTATE_90_CLOCKWISE
                   : turns == 2 ? cv::ROTATE_180
                                : cv::ROTATE_90_COUNTERCLOCKWISE);
      const auto input = fixtures.Png("text.png", rotated);
      const auto result = Take(ProcessPhoto(input, output, PhotoMode::kPhoto));
      Require(result.quarter_turns == (4 - turns) % 4 && result.orientation == "text" &&
                  result.geometry == "unchanged",
              "text orientation must correct all four directions");
      Require(ReadWebp(output).size() == upright.size(), "orientation restores native dimensions");
    }
  }
  cv::Mat nontext(240, 480, CV_8UC3, cv::Scalar(140, 80, 40));
  cv::circle(nontext, {80, 80}, 40, {0, 0, 220}, cv::FILLED);
  const auto input = fixtures.Png("nontext.png", nontext);
  const auto unchanged = Take(ProcessPhoto(input, output, PhotoMode::kPhoto));
  Require(unchanged.quarter_turns == 0 && unchanged.orientation == "none",
          "non-text photo stays upright");
  for (unsigned turns = 0; turns < 4; ++turns) {
    const auto result = Take(ProcessPhoto(input, output, PhotoMode::kPhoto, turns));
    cv::Mat expected = nontext.clone();
    if (turns)
      cv::rotate(expected, expected,
                 turns == 1   ? cv::ROTATE_90_CLOCKWISE
                 : turns == 2 ? cv::ROTATE_180
                              : cv::ROTATE_90_COUNTERCLOCKWISE);
    Require(result.quarter_turns == turns && result.orientation == "manual" &&
                ReadWebp(output).size() == expected.size(),
            "manual turns apply exactly");
    Require(cv::norm(ReadWebp(output), expected, cv::NORM_L1) / expected.total() < 12,
            "manual rotation must preserve the expected pixel arrangement");
    const auto rotated_nontext = fixtures.Png("rotated-nontext.png", expected);
    const auto automatic = Take(ProcessPhoto(rotated_nontext, output, PhotoMode::kPhoto));
    Require(automatic.quarter_turns == 0 && automatic.orientation == "none",
            "non-text inputs must remain unchanged at every quarter turn");
  }
  const auto webp = fixtures.dir / "source.webp";
  Take(ProcessPhoto(input, webp, PhotoMode::kPhoto, 0));
  Require(Take(ProcessPhoto(webp, output, PhotoMode::kPhoto, 1)).width == 240,
          "WebP inputs must decode for re-derivation");
  const auto thumb = fixtures.dir / "webp-thumb.jpg";
  const auto thumbnail = Take(CreatePhotoThumbnail(webp, thumb));
  Require(thumbnail.width == 320 && thumbnail.height == 160, "WebP thumbnails preserve aspect");
  for (const auto format : {PhotoTranscode::kJpeg, PhotoTranscode::kPng}) {
    Take(TranscodePhoto(webp, output, format));
    Require(fixtures.Read(output, format == PhotoTranscode::kJpeg ? GUID_ContainerFormatJpeg
                                                                  : GUID_ContainerFormatPng)
                    .size() == nontext.size(),
            "selection transcodes preserve source dimensions");
  }
}

void CheckPaperMask() {
  cv::Mat colors(256, 256, CV_8UC3), reference_lab;
  cv::RNG random(701);
  random.fill(colors, cv::RNG::UNIFORM, 0, 256);
  cv::cvtColor(colors, reference_lab, cv::COLOR_BGR2Lab);
  Require(cv::norm(photo::AnalysisLab(colors), reference_lab, cv::NORM_INF) <= 2,
          "analysis Lab lookup must match OpenCV within two quantization levels");
  cv::Mat image(600, 800, CV_8UC3, cv::Scalar(190, 190, 195));
  image(cv::Rect{600, 0, 200, 600}).setTo(cv::Scalar(155, 35, 15));
  for (int y = 50; y < 580; y += 40)
    cv::putText(image, "Faint document print", {20, y}, cv::FONT_HERSHEY_SIMPLEX, 0.8,
                {100, 100, 105}, 1, cv::LINE_AA);
  const auto before = image.clone();
  const auto paper = Take(photo::AnalyzePaper(image, {}));
  Take(photo::EnhanceScan(image, paper, {}));
  const cv::Rect background{680, 50, 100, 500};
  Require(cv::norm(image(background), before(background), cv::NORM_INF) == 0,
          "non-paper pixels must remain unchanged before lossy encoding");
  Require(cv::mean(image(cv::Rect{50, 15, 100, 15}))[0] > 230,
          "paper normalization must remove the grey cast");

  cv::Mat shadowed(600, 800, CV_8UC3);
  for (int y = 0; y < shadowed.rows; ++y) {
    auto* row = shadowed.ptr<cv::Vec3b>(y);
    for (int x = 0; x < shadowed.cols; ++x) {
      const double shadow = std::max(0.0, 1 - std::hypot(x - 210.0, y - 599.0) / 400);
      const auto value = cv::saturate_cast<std::uint8_t>(220 - 120 * shadow);
      row[x] = cv::Vec3b::all(value);
    }
  }
  shadowed.colRange(0, 65).setTo(cv::Scalar::all(90));
  const auto original = shadowed.clone();
  const auto shadow_paper = Take(photo::AnalyzePaper(shadowed, {}));
  Take(photo::EnhanceScan(shadowed, shadow_paper, {}));
  Require(cv::mean(shadowed(cv::Rect{185, 565, 50, 25}))[0] > 190,
          "connected neutral paper shadows must be normalized");
  Require(cv::norm(shadowed(cv::Rect{10, 80, 25, 440}), original(cv::Rect{10, 80, 25, 440}),
                   cv::NORM_INF) == 0,
          "a neutral dark table beyond a sharp transition must remain untouched");
}

void CheckSideCrop() {
  cv::Mat page(1200, 1000, CV_8UC3, cv::Scalar::all(230));
  page.colRange(800, 1000).setTo(cv::Scalar(160, 40, 20));
  for (int y = 80; y < 1160; y += 45)
    cv::putText(page, "Printed text stays inside the page", {45, y}, cv::FONT_HERSHEY_SIMPLEX, .8,
                {30, 30, 30}, 2, cv::LINE_AA);
  auto geometry = Take(photo::AnalyzeGeometry(page, {}));
  Require(geometry.kind == "unchanged" && !geometry.crops.empty(),
          "a clear side transition must crop without reporting a warp");
  const auto cropped = Take(photo::ApplyGeometry(page, geometry, {230, 230, 230}, {}));
  Require(cropped.cols >= 790 && cropped.cols < 820 && cropped.rows >= page.rows,
          "side crop must remove the blue background and retain the page");
  cv::Mat before, after;
  cv::inRange(page, cv::Scalar::all(0), cv::Scalar::all(80), before);
  cv::inRange(cropped, cv::Scalar::all(0), cv::Scalar::all(80), after);
  Require(
      std::abs(cv::countNonZero(before) - cv::countNonZero(after)) < .03 * cv::countNonZero(before),
      "side cropping must retain all printed ink");
  cv::putText(page, "Retained text crosses the edge", {580, 1180}, cv::FONT_HERSHEY_SIMPLEX, .7,
              {25, 25, 25}, 2, cv::LINE_AA);
  geometry = Take(photo::AnalyzeGeometry(page, {}));
  Require(geometry.crops.empty(), "a side crop must be vetoed by main-page text beyond the edge");

  cv::Mat upright(1200, 900, CV_8UC3, cv::Scalar::all(230));
  for (int y = 80; y < 1160; y += 45)
    cv::putText(upright, "Upright synthetic document stays intact", {35, y},
                cv::FONT_HERSHEY_SIMPLEX, .8, {30, 30, 30}, 2, cv::LINE_AA);
  geometry = Take(photo::AnalyzeGeometry(upright, {}));
  Require(geometry.kind == "unchanged" && geometry.crops.empty(),
          "upright synthetic text must receive no warp and no crop");
}

void CheckPartialDocuments(Fixtures& fixtures) {
  cv::Mat page(650, 920, CV_8UC3);
  for (int x = 0; x < page.cols; ++x)
    page.col(x).setTo(cv::Scalar(127 + x / 10, 129 + x / 10, 131 + x / 10));
  for (int y = 46; y < page.rows - 30; y += 42)
    cv::putText(page, "Crop shows a portion of a long document", {14, y}, cv::FONT_HERSHEY_SIMPLEX,
                0.94, {36, 39, 41}, 2, cv::LINE_AA);
  cv::rectangle(page, {24, 570}, {99, 592}, {27, 36, 186}, cv::FILLED);
  cv::rectangle(page, {500, 566}, {530, 573}, {162, 164, 166}, cv::FILLED);
  const auto full = fixtures.Png("partial-flat.png", page);
  const auto output = fixtures.dir / "partial-scan.temp";
  const auto flat = Take(ProcessPhoto(full, output, PhotoMode::kScan, 0));
  Require(flat.geometry == "unchanged" && flat.width == page.cols && flat.height == page.rows,
          "aligned partial page should keep its whole view");
  const auto scanned = ReadWebp(output);
  Require(scanned.at<cv::Vec3b>(580, 60)[2] - scanned.at<cv::Vec3b>(580, 60)[0] > 135,
          "red stamp should retain its color");
  const auto weak = scanned.at<cv::Vec3b>(569, 515)[0];
  Require(scanned.at<cv::Vec3b>(559, 515)[0] - weak >= 8,
          "weak pencil stroke should remain distinguishable");
  const auto before_range = page.at<cv::Vec3b>(615, 850)[0] - page.at<cv::Vec3b>(615, 120)[0];
  const auto after_range = scanned.at<cv::Vec3b>(615, 850)[0] - scanned.at<cv::Vec3b>(615, 120)[0];
  Require(after_range < before_range * 0.6, "scan should reduce gradual illumination variation");
  Require(cv::norm(fixtures.Read(full, GUID_ContainerFormatPng), page, cv::NORM_INF) == 0,
          "source PNG must remain pixel-identical");

  for (const double tilt : {-7.5, 7.5}) {
    cv::Mat angled;
    const cv::Point2f center{page.cols * 0.5f, page.rows * 0.5f};
    cv::warpAffine(page, angled, cv::getRotationMatrix2D(center, tilt, 1), page.size(),
                   cv::INTER_LINEAR, cv::BORDER_REPLICATE);
    // These markers are captured at the extreme edges of the tilted frame.
    cv::rectangle(angled, {0, 292}, {14, 310}, {220, 48, 29}, cv::FILLED);
    cv::rectangle(angled, {angled.cols - 15, 292}, {angled.cols - 1, 310}, {34, 170, 35},
                  cv::FILLED);
    const auto rotated = fixtures.Png(tilt > 0 ? "plus.png" : "minus.png", angled);
    const auto deskewed = Take(ProcessPhoto(rotated, output, PhotoMode::kScan, 0));
    Require(
        deskewed.geometry == "deskew" && deskewed.width > page.cols && deskewed.height > page.rows,
        "partial page with consistent slanted text should be deskewed with expanded canvas: " +
            deskewed.geometry + " " + std::to_string(deskewed.width) + "x" +
            std::to_string(deskewed.height));
    const auto pixels = ReadWebp(output);
    const cv::Point2f target_center{(pixels.cols - 1) * 0.5f, (pixels.rows - 1) * 0.5f};
    auto transform =
        cv::getRotationMatrix2D({(angled.cols - 1) * 0.5f, (angled.rows - 1) * 0.5f}, -tilt, 1);
    transform.at<double>(0, 2) += target_center.x - (angled.cols - 1) * 0.5;
    transform.at<double>(1, 2) += target_center.y - (angled.rows - 1) * 0.5;
    std::vector<cv::Point2f> marker_locations{{7, 301}, {angled.cols - 8.0f, 301}};
    cv::transform(marker_locations, marker_locations, transform);
    const auto left =
        pixels.at<cv::Vec3b>(cvRound(marker_locations[0].y), cvRound(marker_locations[0].x));
    const auto right =
        pixels.at<cv::Vec3b>(cvRound(marker_locations[1].y), cvRound(marker_locations[1].x));
    Require(left[0] - left[1] > 125 && right[1] - right[0] > 80,
            "deskew angle must preserve both known edge markers near their expected positions");
  }

  cv::Mat ambiguous(410, 630, CV_8UC3, cv::Scalar::all(225));
  cv::rectangle(ambiguous, {67, 62}, {540, 338}, {45, 54, 63}, 3);
  for (int y = 110; y < 340; y += 43)
    cv::line(ambiguous, {67, y}, {540, y}, {45, 54, 63}, 2);
  const auto table = fixtures.Png("table-without-page-boundary.png", ambiguous);
  const auto kept = Take(ProcessPhoto(table, output, PhotoMode::kScan, 0));
  Require(
      kept.geometry == "unchanged" && kept.width == ambiguous.cols && kept.height == ambiguous.rows,
      "an internal table border must not be used as a page boundary");
}

void CheckThumbnails(Fixtures& fixtures) {
  const auto big =
      fixtures.Png("large-preview.png", cv::Mat(1800, 2800, CV_8UC3, cv::Scalar(130, 205, 165)));
  const auto output = fixtures.dir / "thumb.temp";
  const auto result = Take(CreatePhotoThumbnail(big, output));
  Require(result.width == 320 && result.height == 206 &&
              std::filesystem::file_size(output) <= 64 * 1024,
          "thumbnail must resize large sources proportionally within the byte limit");
  Require(fixtures.Read(output).size() == cv::Size{320, 206}, "thumbnail JPEG dimensions");
  Require(Take(ProcessPhoto(big, fixtures.dir / "large.webp", PhotoMode::kPhoto, 0)).width == 2800,
          "photo mode keeps native resolution within the pixel budget");
  Require(Take(ProcessPhoto(big, fixtures.dir / "capped.webp", PhotoMode::kScan, 0)).width == 2480,
          "scan mode caps the long side without upscaling");

  cv::Mat transparent(20, 28, CV_8UC4, cv::Scalar(0, 0, 0, 0));
  cv::rectangle(transparent, {9, 5}, {18, 14}, {0, 0, 220, 255}, cv::FILLED);
  const auto alpha = fixtures.Png("transparent.png", transparent);
  const auto tiny = Take(CreatePhotoThumbnail(alpha, output));
  const auto flattened = fixtures.Read(output);
  Require(tiny.width == 28 && tiny.height == 20 && flattened.at<cv::Vec3b>(1, 1)[0] > 245 &&
              flattened.at<cv::Vec3b>(10, 13)[2] > 190 && flattened.at<cv::Vec3b>(10, 13)[0] < 40,
          "small PNG stays at native size and transparent area becomes white");

  cv::Mat landscape(160, 480, CV_8UC3, cv::Scalar::all(230));
  landscape(cv::Rect{0, 0, 140, 160}).setTo(cv::Scalar::all(35));
  const auto raw = fixtures.Encode("orientation-source.jpg", landscape, GUID_ContainerFormatJpeg);
  std::ifstream jpeg_file(raw, std::ios::binary);
  const std::vector<char> jpeg_bytes((std::istreambuf_iterator<char>(jpeg_file)), {});
  Require(jpeg_bytes.size() > 2, "fixture JPEG bytes");
  // APP1 Exif, little-endian IFD0 with orientation 6 (clockwise rotation).
  constexpr std::array<unsigned char, 36> app1{
      0xff, 0xe1, 0x00, 0x22, 'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0,
      1,    0,    0x12, 0x01, 3,   0,   1,   0,   0, 0, 6,   0,   0,  0, 0, 0, 0, 0};
  const auto oriented = fixtures.dir / "orientation.jpg";
  std::ofstream tagged(oriented, std::ios::binary);
  tagged.write(jpeg_bytes.data(), 2);
  tagged.write(reinterpret_cast<const char*>(app1.data()), app1.size());
  tagged.write(jpeg_bytes.data() + 2, jpeg_bytes.size() - 2);
  tagged.close();
  const auto rotated = Take(CreatePhotoThumbnail(oriented, output));
  const auto rotated_jpeg = fixtures.Read(output);
  Require(rotated.width == 107 && rotated.height == 320 &&
              rotated_jpeg.at<cv::Vec3b>(30, 45)[0] < 60 &&
              rotated_jpeg.at<cv::Vec3b>(290, 45)[0] > 205,
          "thumbnail pixels and aspect should reflect JPEG EXIF orientation");

  const auto noisy = fixtures.dir / "noisy.png";
  cv::Mat random_image(320, 320, CV_8UC3);
  cv::RNG random(4412);
  random.fill(random_image, cv::RNG::UNIFORM, 0, 256);
  fixtures.Png("noisy.png", random_image);
  Take(CreatePhotoThumbnail(noisy, output));
  Require(std::filesystem::file_size(output) <= 64 * 1024, "busy thumbnails obey byte limit");
  const auto too_wide =
      fixtures.Png("too-wide.png", cv::Mat(1, 16385, CV_8UC3, cv::Scalar::all(120)));
  const auto absent = fixtures.dir / "absent.temp";
  RequireError([&] { return CreatePhotoThumbnail(too_wide, absent); },
               remotekit::ErrorCode::kLimitExceeded);
  RequireError([&] { return CreatePhotoThumbnail(fixtures.dir / "broken.png", absent); },
               remotekit::ErrorCode::kRejected);
  RequireError([&] { return CreatePhotoThumbnail(big, absent, [] { return true; }); },
               remotekit::ErrorCode::kCanceled);
  RequireError([&] { return CreatePhotoThumbnail(big, big); }, remotekit::ErrorCode::kInternal);
  Require(!std::filesystem::exists(absent), "rejected thumbnails must create no output");
}

}  // namespace

int main() {
  try {
    Fixtures fixtures;
    CheckOrientation(fixtures);
    CheckPaperMask();
    CheckSideCrop();
    CheckBurst(fixtures);
    CheckDocuments(fixtures);
    CheckPartialDocuments(fixtures);
    CheckThumbnails(fixtures);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
