#include "remotekit/photo_processing.hpp"

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

void Require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

void Check(HRESULT result) {
  Require(SUCCEEDED(result), "WIC fixture setup or readback failed");
}

template <typename F>
void RequireError(F operation, std::string_view expected) {
  try {
    operation();
  } catch (const std::runtime_error& error) {
    if (expected == error.what())
      return;
    std::cerr << "Expected " << expected << ", got " << error.what() << '\n';
    throw;
  }
  throw std::runtime_error("expected an error");
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
    const auto desired = image.channels() == 4 ? GUID_WICPixelFormat32bppBGRA
                                               : GUID_WICPixelFormat24bppBGR;
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
    Check(converter->Initialize(frame.Get(), GUID_WICPixelFormat24bppBGR,
                                 WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
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
    cv::putText(image, "RemoteKit photo quality", {24, y}, cv::FONT_HERSHEY_SIMPLEX,
                1.1, ink, 2, cv::LINE_AA);
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
    const auto result = analyzer.Observe("first", bytes, {"first"});
    Require(!result.stop, "one sample must not certify stable quality");
    return result.candidates.front().score;
  };
  const auto clear_score = analyze(clear_bytes);
  Require(clear_score > analyze(blur_bytes) + 0.16 &&
              clear_score > analyze(dark_bytes) + 0.16 &&
              clear_score > analyze(noise_bytes) + 0.16,
          "512 px quality must separate clear detail from blur, dark detail and random noise");
  scores.Observe("blur", blur_bytes, {"blur"});
  const auto good = scores.Observe("clear", clear_bytes, {"blur", "clear"});
  Require(good.selected_frame_id == "clear" && !good.stop && !good.uncertain,
          "a single sharp frame can displace blur without certifying stable quality");
  cv::Mat similar;
  sharp.convertTo(similar, -1, 1, 4);
  const auto near_bytes = jpeg("burst-near.jpg", similar);
  const auto stop = scores.Observe("near", near_bytes, {"clear", "near"});
  Require(stop.stop && stop.candidates.size() == 1 && stop.keep_frame_ids.size() == 1 &&
              !stop.uncertain,
          "two clear, equivalent frames should stop early with one retained candidate");
  Require(scores.Finish(stop.keep_frame_ids).selected_frame_id == stop.selected_frame_id,
          "finish must select the acknowledged retained frame");
  RequireError([&] { scores.Finish({"unseen"}); }, "invalid-photo-count");

  cv::Mat blue, orange;
  cv::resize(DetailFixture({255, 174, 193}, {92, 25, 31}), blue, sharp.size());
  cv::resize(DetailFixture({94, 184, 235}, {0, 19, 69}), orange, sharp.size());
  const auto blue_bytes = jpeg("burst-blue.jpg", blue);
  const auto orange_bytes = jpeg("burst-orange.jpg", orange);
  PhotoBurstAnalyzer distinct;
  distinct.Observe("blue", blue_bytes, {"blue"});
  const auto choice = distinct.Observe("orange", orange_bytes, {"blue", "orange"});
  Require(!choice.stop && choice.uncertain && choice.keep_frame_ids.size() == 2 &&
              choice.candidates.size() == 2,
          "distinct close-quality scenes should retain both original frame IDs");
  Require(distinct.Finish({"orange"}).selected_frame_id == "orange",
          "finish must not select an evicted winner");
  RequireError([&] { distinct.Observe("blue", blue_bytes, {"blue"}); }, "invalid-photo-frame");
  RequireError([&] { distinct.Observe("missing", clear_bytes, {"orange"}); }, "invalid-photo-frame");
  const cv::Mat wide(64, 513, CV_8UC3, cv::Scalar::all(160));
  RequireError([&] { distinct.Observe("wide", jpeg("burst-wide.jpg", wide),
                                      {"wide"}); }, "photo-too-large");
  RequireError([&] { distinct.Observe("big", std::vector<std::uint8_t>(44 * 1024 + 1), {"big"}); },
               "photo-too-large");
  RequireError([&] { distinct.Observe("cancelled", clear_bytes, {"cancelled"}, [] { return true; }); },
               "cancelled");
}

void CheckRank(Fixtures& fixtures) {
  const auto sharp = DetailFixture({184, 188, 192}, {28, 31, 34});
  const auto crisp = fixtures.Png("crisp.png", sharp);
  cv::Mat blur;
  cv::GaussianBlur(sharp, blur, {23, 5}, 6.5, 1.2);
  const auto blurred = fixtures.Png("blurred.png", blur);
  cv::Mat noisy(sharp.size(), CV_8UC3);
  cv::RNG random(12345);
  random.fill(noisy, cv::RNG::NORMAL, cv::Scalar::all(128), cv::Scalar::all(37));
  const auto noise = fixtures.Png("noise.png", noisy);
  const auto ranked = RankPhotos(std::array{blurred, noise, crisp});
  Require(ranked.selected_index == 2 && !ranked.uncertain && ranked.reason == "clear-winner",
          "clear structured detail must beat blur and random noise");
  const auto similar = RankPhotos(std::array{crisp, crisp});
  Require(similar.selected_index == 0 && !similar.uncertain &&
              similar.reason == "near-identical" && similar.candidates.size() == 1,
          "equivalent frames should choose a stable winner");

  // Approximately equal luminance contrast, very different chroma.
  const auto blue = fixtures.Png("blue.png", DetailFixture({255, 174, 193}, {92, 25, 31}));
  const auto orange = fixtures.Png("orange.png", DetailFixture({94, 184, 235}, {0, 19, 69}));
  const auto distinct = RankPhotos(std::array{blue, orange, orange, blue});
  Require(distinct.uncertain && distinct.reason == "close-quality" &&
              distinct.candidates.size() == 2,
          "close but distinct frames should expose deduplicated alternatives");

  const auto dark = fixtures.Png("dark.png", cv::Mat(sharp.size(), CV_8UC3, cv::Scalar::all(0)));
  const auto white = fixtures.Png("white.png", cv::Mat(sharp.size(), CV_8UC3, cv::Scalar::all(255)));
  const auto low = RankPhotos(std::array{dark, white});
  Require(low.reason == "low-quality" && !low.uncertain && low.candidates.size() == 1,
          "poor frames should warn without forced alternatives");
  RequireError([&] { RankPhotos(std::array{crisp}, [] { return true; }); }, "cancelled");
  RequireError([&] { RankPhotos(std::array{crisp, crisp, crisp, crisp, crisp, crisp, crisp}); },
               "invalid-photo-count");
}

void CheckDocuments(Fixtures& fixtures) {
  const cv::Size size{640, 480};
  const std::vector<cv::Point> quad{{103, 71}, {543, 92}, {567, 405}, {79, 426}};
  cv::Mat page(size, CV_8UC3, cv::Scalar::all(28));
  cv::Mat mask(size, CV_8UC1, cv::Scalar::all(0));
  cv::fillConvexPoly(mask, quad, cv::Scalar::all(255));
  for (int x = 0; x < page.cols; ++x)
    page.col(x).setTo(cv::Scalar(105 + x / 5, 109 + x / 5, 118 + x / 5), mask.col(x));
  for (int y = 132; y <= 362; y += 27)
    cv::line(page, {131, y}, {482, y}, {22, 22, 22}, 3);
  const auto input = fixtures.Png("document.png", page);
  const auto rectified = fixtures.dir / "rectified.temp";
  const auto scanned = fixtures.dir / "scanned.temp";
  const auto corrected = ProcessPhoto(input, rectified, PhotoMode::kRectify);
  Require(corrected.width >= 470 && corrected.width <= 500 &&
              corrected.height >= 342 && corrected.height <= 370,
          "auto detection should use the complete perspective boundary");
  const auto rectified_png = fixtures.Read(rectified, GUID_ContainerFormatPng);
  Require(rectified_png.cols == corrected.width && rectified_png.rows == corrected.height &&
              rectified_png.at<cv::Vec3b>(70, 22)[0] > 95 && corrected.geometry == "perspective",
          "rectified PNG should match dimensions and contain the document");

  std::array<PhotoPoint, 4> manual;
  for (std::size_t i = 0; i < manual.size(); ++i)
    manual[i] = {quad[i].x / 639.0, quad[i].y / 479.0};
  const auto clean = ProcessPhoto(input, scanned, PhotoMode::kScan, manual);
  const auto scan = fixtures.Read(scanned, GUID_ContainerFormatPng);
  Require(scan.cols == clean.width && scan.rows == clean.height && clean.width >= 480 &&
              clean.geometry == "perspective",
          "manual crop should use the exact supplied perspective boundary");
  const auto left = cv::mean(scan(cv::Rect{10, 12, 30, 18}))[0];
  const auto right = cv::mean(scan(cv::Rect{scan.cols - 40, 12, 30, 18}))[0];
  cv::Mat gray;
  cv::cvtColor(scan, gray, cv::COLOR_BGR2GRAY);
  Require(left > 170 && right > 170 && std::abs(left - right) < 15 &&
              cv::countNonZero(gray < 55) > 1000,
          "scan should normalize uneven paper and preserve dark lines");
  Require(ProcessPhoto(input, scanned, PhotoMode::kScan).geometry == "perspective",
          "clear complete page should support automatic perspective in scan mode");
  Require(RankPhotos(std::array{input}).candidates.size() == 1,
          "processing should preserve the original asset");
  std::swap(manual[1], manual[2]);
  const auto invalid = fixtures.dir / "invalid.temp";
  RequireError([&] { ProcessPhoto(input, invalid, PhotoMode::kScan, manual); }, "invalid-corners");
  const auto flat = fixtures.Png("flat.png", cv::Mat(size, CV_8UC3, cv::Scalar::all(170)));
  RequireError([&] { ProcessPhoto(flat, invalid, PhotoMode::kRectify); }, "no-document");
  Require(!std::filesystem::exists(invalid), "rejected crop must produce no output");

  cv::Mat two(size, CV_8UC3, cv::Scalar::all(28));
  cv::rectangle(two, {24, 70}, {300, 420}, cv::Scalar::all(225), cv::FILLED);
  cv::rectangle(two, {340, 70}, {616, 420}, cv::Scalar::all(225), cv::FILLED);
  const auto ambiguous = fixtures.Png("two-documents.png", two);
  RequireError([&] { ProcessPhoto(ambiguous, invalid, PhotoMode::kRectify); }, "no-document");
  const auto oversized = fixtures.Png(
      "oversized.png", cv::Mat(2897, 2897, CV_8UC3, cv::Scalar::all(165)));
  RequireError([&] { RankPhotos(std::array{oversized}); }, "photo-too-large");
  const auto broken = fixtures.dir / "broken.png";
  std::ofstream(broken, std::ios::binary) << "not an image";
  RequireError([&] { RankPhotos(std::array{broken}); }, "invalid-photo");
}

void CheckPartialDocuments(Fixtures& fixtures) {
  cv::Mat page(650, 920, CV_8UC3);
  for (int x = 0; x < page.cols; ++x)
    page.col(x).setTo(cv::Scalar(127 + x / 10, 129 + x / 10, 131 + x / 10));
  for (int y = 46; y < page.rows - 30; y += 42)
    cv::putText(page, "Crop shows a portion of a long document", {14, y},
                cv::FONT_HERSHEY_SIMPLEX, 0.94, {36, 39, 41}, 2, cv::LINE_AA);
  cv::rectangle(page, {24, 570}, {99, 592}, {27, 36, 186}, cv::FILLED);
  cv::rectangle(page, {500, 566}, {530, 573}, {162, 164, 166}, cv::FILLED);
  const auto full = fixtures.Png("partial-flat.png", page);
  const auto output = fixtures.dir / "partial-scan.temp";
  const auto flat = ProcessPhoto(full, output, PhotoMode::kScan);
  Require(flat.geometry == "unchanged" && flat.width == page.cols && flat.height == page.rows,
          "aligned partial page should keep its whole view");
  const auto scanned = fixtures.Read(output, GUID_ContainerFormatPng);
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
    cv::rectangle(angled, {angled.cols - 15, 292}, {angled.cols - 1, 310},
                  {34, 170, 35}, cv::FILLED);
    const auto rotated = fixtures.Png(tilt > 0 ? "plus.png" : "minus.png", angled);
    const auto deskewed = ProcessPhoto(rotated, output, PhotoMode::kScan);
    Require(deskewed.geometry == "deskew" && deskewed.width > page.cols &&
                deskewed.height > page.rows,
            "partial page with consistent slanted text should be deskewed with expanded canvas");
    const auto pixels = fixtures.Read(output, GUID_ContainerFormatPng);
    const cv::Point2f target_center{(pixels.cols - 1) * 0.5f, (pixels.rows - 1) * 0.5f};
    auto transform = cv::getRotationMatrix2D(
        {(angled.cols - 1) * 0.5f, (angled.rows - 1) * 0.5f}, -tilt, 1);
    transform.at<double>(0, 2) += target_center.x - (angled.cols - 1) * 0.5;
    transform.at<double>(1, 2) += target_center.y - (angled.rows - 1) * 0.5;
    std::vector<cv::Point2f> marker_locations{{7, 301}, {angled.cols - 8.0f, 301}};
    cv::transform(marker_locations, marker_locations, transform);
    const auto left = pixels.at<cv::Vec3b>(cvRound(marker_locations[0].y),
                                           cvRound(marker_locations[0].x));
    const auto right = pixels.at<cv::Vec3b>(cvRound(marker_locations[1].y),
                                            cvRound(marker_locations[1].x));
    Require(left[0] - left[1] > 125 && right[1] - right[0] > 100,
            "deskew angle must preserve both known edge markers near their expected positions");
  }

  cv::Mat ambiguous(410, 630, CV_8UC3, cv::Scalar::all(225));
  cv::rectangle(ambiguous, {67, 62}, {540, 338}, {45, 54, 63}, 3);
  for (int y = 110; y < 340; y += 43)
    cv::line(ambiguous, {67, y}, {540, y}, {45, 54, 63}, 2);
  const auto table = fixtures.Png("table-without-page-boundary.png", ambiguous);
  const auto kept = ProcessPhoto(table, output, PhotoMode::kScan);
  Require(kept.geometry == "unchanged" && kept.width == ambiguous.cols &&
              kept.height == ambiguous.rows,
          "an internal table border must not be used as a page boundary");
}

void CheckThumbnails(Fixtures& fixtures) {
  const auto big = fixtures.Png("large-preview.png", cv::Mat(1800, 2800, CV_8UC3,
                                                              cv::Scalar(130, 205, 165)));
  const auto output = fixtures.dir / "thumb.temp";
  const auto result = CreatePhotoThumbnail(big, output);
  Require(result.width == 320 && result.height == 206 &&
              std::filesystem::file_size(output) <= 64 * 1024,
          "thumbnail must resize large sources proportionally within the byte limit");
  Require(fixtures.Read(output).size() == cv::Size{320, 206}, "thumbnail JPEG dimensions");
  Require(RankPhotos(std::array{big}).selected_index == 0, "8 Mi-pixel budget accepts 5 MP input");

  cv::Mat transparent(20, 28, CV_8UC4, cv::Scalar(0, 0, 0, 0));
  cv::rectangle(transparent, {9, 5}, {18, 14}, {0, 0, 220, 255}, cv::FILLED);
  const auto alpha = fixtures.Png("transparent.png", transparent);
  const auto tiny = CreatePhotoThumbnail(alpha, output);
  const auto flattened = fixtures.Read(output);
  Require(tiny.width == 28 && tiny.height == 20 &&
              flattened.at<cv::Vec3b>(1, 1)[0] > 245 &&
              flattened.at<cv::Vec3b>(10, 13)[2] > 190 &&
              flattened.at<cv::Vec3b>(10, 13)[0] < 40,
          "small PNG stays at native size and transparent area becomes white");

  cv::Mat landscape(160, 480, CV_8UC3, cv::Scalar::all(230));
  landscape(cv::Rect{0, 0, 140, 160}).setTo(cv::Scalar::all(35));
  const auto raw = fixtures.Encode("orientation-source.jpg", landscape, GUID_ContainerFormatJpeg);
  std::ifstream jpeg_file(raw, std::ios::binary);
  const std::vector<char> jpeg_bytes((std::istreambuf_iterator<char>(jpeg_file)), {});
  Require(jpeg_bytes.size() > 2, "fixture JPEG bytes");
  // APP1 Exif, little-endian IFD0 with orientation 6 (clockwise rotation).
  constexpr std::array<unsigned char, 36> app1{
      0xff, 0xe1, 0x00, 0x22, 'E', 'x', 'i', 'f', 0, 0,
      'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0};
  const auto oriented = fixtures.dir / "orientation.jpg";
  std::ofstream tagged(oriented, std::ios::binary);
  tagged.write(jpeg_bytes.data(), 2);
  tagged.write(reinterpret_cast<const char*>(app1.data()), app1.size());
  tagged.write(jpeg_bytes.data() + 2, jpeg_bytes.size() - 2);
  tagged.close();
  const auto rotated = CreatePhotoThumbnail(oriented, output);
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
  CreatePhotoThumbnail(noisy, output);
  Require(std::filesystem::file_size(output) <= 64 * 1024, "busy thumbnails obey byte limit");
  const auto too_wide = fixtures.Png("too-wide.png", cv::Mat(1, 16385, CV_8UC3, cv::Scalar::all(120)));
  const auto absent = fixtures.dir / "absent.temp";
  RequireError([&] { CreatePhotoThumbnail(too_wide, absent); }, "photo_too_large");
  RequireError([&] { CreatePhotoThumbnail(fixtures.dir / "broken.png", absent); }, "invalid_photo");
  RequireError([&] { CreatePhotoThumbnail(big, absent, [] { return true; }); }, "cancelled");
  RequireError([&] { CreatePhotoThumbnail(big, big); }, "photo_output_failed");
  Require(!std::filesystem::exists(absent), "rejected thumbnails must create no output");
}

}  // namespace

int main() {
  try {
    Fixtures fixtures;
    CheckRank(fixtures);
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
