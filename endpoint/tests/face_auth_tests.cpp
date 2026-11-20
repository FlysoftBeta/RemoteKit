#include "auth/face_auth.hpp"
#include "auth/face_engine.hpp"
#include "auth/face_policy.hpp"
#include "auth/face_wire.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

namespace {
using namespace rk::auth;
using namespace std::chrono_literals;
void Require(bool condition, const char* name) {
  if (!condition)
    throw std::runtime_error(name);
}

FaceTemplate Vector(float score = 1, size_t component = 1) {
  FaceTemplate value{};
  value[0] = score;
  value[component] = std::sqrt(1 - score * score);
  return value;
}

FaceInference Inference(FaceTemplate feature = Vector(), float live1 = 1, float live2 = 1) {
  FaceInference result;
  result.feature = feature;
  result.live_v1se = live1;
  result.live_v2 = live2;
  result.quality.inter_ocular = 45;
  result.quality.sharpness = 100;
  result.quality.mean_luma = 120;
  result.quality.contrast = 30;
  result.quality.pitch = 0.5f;
  return result;
}

FaceDetection Detection(float x = 100,
                        float y = 100,
                        float width = 64,
                        float height = 64,
                        float score = kDetectScore) {
  return {x,
          y,
          width,
          height,
          x + width * 0.3f,
          y + height * 0.35f,
          x + width * 0.7f,
          y + height * 0.35f,
          x + width * 0.5f,
          y + height * 0.55f,
          x + width * 0.35f,
          y + height * 0.75f,
          x + width * 0.65f,
          y + height * 0.75f,
          score};
}

void DetectionTests() {
  const auto valid = Detection();
  std::vector<FaceDetection> candidates{valid, Detection(200, 200, 100, 100, kDetectScore - 0.001f),
                                        Detection(200, 200, kMinFace - 0.01f),
                                        Detection(200, 200, 64, kMinFace - 0.01f)};
  auto selected = SelectFace(candidates, 640, 480);
  Require(selected.gate == FaceGate::none && selected.qualified == 1, "candidate filtering");
  candidates = {Detection(100, 100, 100, 100), Detection(250, 100, 50, 100)};
  selected = SelectFace(candidates, 640, 480);
  Require(selected.gate == FaceGate::none && selected.qualified == 2 && selected.face[2] == 100,
          "half-area bystander is ignored");
  std::reverse(candidates.begin(), candidates.end());
  Require(SelectFace(candidates, 640, 480).face[2] == 100,
          "largest selection is order independent");
  candidates[0][2] = 50.01f;
  Require(SelectFace(candidates, 640, 480).gate == FaceGate::multiple_faces,
          "large second face rejects");
  Require(SelectFace({}, 640, 480).gate == FaceGate::no_qualified_face, "empty detection");
  auto edge = Detection(-20, -10, 100, 100);
  selected = SelectFace(std::span(&edge, 1), 640, 480);
  Require(selected.gate == FaceGate::none && selected.face[0] == 0 && selected.face[2] == 80,
          "outside box accepts with inside landmarks and clamps crop");
  for (int i = 4; i < 14; ++i) {
    auto invalid = valid;
    invalid[i] = 1.99f;
    Require(SelectFace(std::span(&invalid, 1), 640, 480).gate == FaceGate::boundary,
            "all five landmarks need margin");
    invalid[i] = std::numeric_limits<float>::quiet_NaN();
    Require(SelectFace(std::span(&invalid, 1), 640, 480).gate == FaceGate::nonfinite,
            "nonfinite landmark rejects");
  }
}

void WireTests() {
  using remotekit::Json;
  const FaceGallery gallery{Vector()};
  const Json request{{"templates", gallery}};
  for (const auto purpose : {FacePurpose::verify, FacePurpose::presence}) {
    Require(bool(ReadFaceGallery(request, purpose)), "normalized gallery accepts");
    for (const Json invalid :
         {Json::object(), Json{{"templates", Json::array()}},
          Json{{"templates", FaceGallery(10, Vector())}}, Json{{"templates", {1}}},
          Json{{"templates", {{1}}}}, Json{{"templates", nullptr}}, Json{{"templates", "bad"}}})
      Require(!ReadFaceGallery(invalid, purpose), "invalid gallery rejects");
    Require(bool(ReadFaceGallery(Json{{"templates", FaceGallery(9, Vector())}}, purpose)),
            "nine templates accept");
    for (const double value : {0.0, 0.999, 1.001, 1e300, std::numeric_limits<double>::infinity(),
                               std::numeric_limits<double>::quiet_NaN()}) {
      Json invalid = request;
      invalid["templates"][0][0] = value;
      Require(!ReadFaceGallery(invalid, purpose), "invalid vector norm or component rejects");
    }
    Json invalid = request;
    invalid["templates"][0][1] = true;
    Require(!ReadFaceGallery(invalid, purpose), "boolean component rejects");
  }
  Require(bool(ReadFaceGallery(Json::object(), FacePurpose::enroll)), "enrollment has no gallery");
  Require(!ReadFaceGallery(request, FacePurpose::enroll), "enrollment forbids gallery");
  Require(!ReadFaceGallery(Json{{"templates", Json::array()}}, FacePurpose::enroll),
          "even empty enrollment gallery rejects");
  Require(!ValidateFaceFields("auth.face.begin", Json{{"template", Vector()}}),
          "removed field is unknown");
  Require(!ValidateFaceFields("auth.face.begin", Json{{"unknown", true}}), "unknown field rejects");
  Require(!ValidateFaceFields("auth.face.status", request), "status forbids begin fields");
  Require(!ValidateFaceFields("auth.face.begin", Json::array()), "object required");
  FacePolicy enrollment(FacePurpose::enroll);
  auto reply = FaceStatusJson(enrollment.Result(), "challenge");
  Require(reply.at("progress") == 0 && reply.at("status") == "pending" && !reply.contains("hint"),
          "initial enrollment has progress");
  FaceResult enrolled;
  enrolled.state = FaceState::enrolled;
  enrolled.templates = FaceGallery(3, Vector());
  reply = FaceStatusJson(enrolled, "challenge");
  Require(reply.at("templates").size() == 3 && !reply.contains("template") &&
              !reply.contains("progress"),
          "enrollment serializes gallery");
}

void FramePolicyTests() {
  const auto epoch = FacePolicy::Clock::time_point{};
  const auto good = Inference();
  auto missed = good;
  missed.gate = FaceGate::no_qualified_face;
  FacePolicy policy(FacePurpose::verify, {Vector()});
  const auto observe = [&](int ms, const FaceInference& inference, uint64_t hash) {
    return policy.Observe(epoch + std::chrono::milliseconds(ms), inference, hash);
  };
  observe(0, good, 1);
  observe(200, Inference(Vector(0)), 2);
  observe(400, good, 3);
  observe(600, missed, 4);
  observe(800, good, 5);
  Require(policy.Result().state == FaceState::matched, "three among five accepts");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, good, 1);
  observe(200, missed, 2);
  observe(400, good, 3);
  observe(600, missed, 4);
  observe(800, missed, 5);
  observe(1000, good, 6);
  Require(policy.Result().state == FaceState::pending, "sixth observation evicts first");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, good, 1);
  observe(100, good, 2);
  observe(399, good, 3);
  Require(policy.Result().state == FaceState::pending, "minimum span");
  observe(400, good, 3);
  Require(policy.Result().state == FaceState::matched, "span inclusive");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, good, 1);
  observe(200, good, 1);
  observe(400, good, 2);
  Require(policy.Result().state == FaceState::pending, "distinct hashes required");
  observe(600, good, 3);
  Require(policy.Result().state == FaceState::matched, "third distinct hash");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, good, 1);
  observe(200, good, 2);
  observe(1001, good, 3);
  Require(policy.Result().state == FaceState::pending, "time eviction");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, good, 1);
  observe(200, good, 2);
  observe(1000, good, 3);
  Require(policy.Result().state == FaceState::matched, "window end is inclusive");
  policy = FacePolicy(FacePurpose::verify, {Vector(0), Vector()});
  observe(0, good, 1);
  observe(200, good, 2);
  observe(400, good, 3);
  Require(policy.Result().state == FaceState::matched, "max over gallery");

  for (const auto& live :
       {std::pair(0.69f, 1.0f), std::pair(1.0f, 0.69f), std::pair(0.85f, 0.9f)}) {
    policy = FacePolicy(FacePurpose::verify, {Vector()});
    auto sample = Inference(Vector(), live.first, live.second);
    observe(0, sample, 1);
    observe(200, sample, 2);
    const auto outcome = observe(400, sample, 3);
    Require(policy.Result().state == FaceState::pending && outcome.gate != FaceGate::none,
            "set liveness thresholds reject");
  }
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  observe(0, Inference(Vector(), 0.5f, 1), 1);
  observe(200, good, 2);
  observe(400, good, 3);
  Require(policy.Result().state == FaceState::matched,
          "aggregate liveness accepts lower individual score");
  Require(QualityGate(Inference(Vector(), 0.499f, 1)) == FaceGate::live_v1se,
          "per-frame liveness floor");
  for (int gate = int(FaceGate::too_far); gate <= int(FaceGate::blurry); ++gate) {
    auto sample = good;
    if (gate == int(FaceGate::too_far))
      sample.quality.inter_ocular = kMinInterOcular - 1;
    if (gate == int(FaceGate::too_dark))
      sample.quality.mean_luma = kMinLuma - 1;
    if (gate == int(FaceGate::too_bright))
      sample.quality.mean_luma = kMaxLuma + 1;
    if (gate == int(FaceGate::backlit)) {
      sample.quality.mean_luma = 18;
      sample.quality.backlight = 130;
    }
    if (gate == int(FaceGate::blurry))
      sample.quality.sharpness = kMinSharpness - 1;
    Require(QualityGate(sample) == FaceGate(gate), "quality gate accounting");
  }
}

void EnrollmentTests() {
  const auto epoch = FacePolicy::Clock::time_point{};
  FacePolicy policy(FacePurpose::enroll);
  uint64_t hash = 0;
  auto cluster = [&](int start, FaceInference sample) {
    for (int frame = 0; frame < 3; ++frame)
      policy.Observe(epoch + std::chrono::milliseconds(start + frame * 200), sample, ++hash);
  };
  cluster(0, Inference());
  cluster(600, Inference());
  Require(policy.Result().templates.size() == 1 && policy.Result().hint == "turn_head" &&
              policy.Result().progress == 0.2f,
          "duplicate pose prompts diversity");
  cluster(1200, Inference(Vector(0.8f, 2)));
  cluster(1800, Inference(Vector(0.8f, 3)));
  Require(policy.Result().templates.size() == 3 && policy.Result().state == FaceState::pending,
          "three diverse templates wait six seconds");
  policy.Advance(epoch + 6400ms);
  Require(policy.Result().state == FaceState::enrolled && policy.Result().templates.size() == 3,
          "three templates complete after six seconds");
  for (const auto& value : policy.Result().templates)
    Require(ValidTemplate(value), "normalized enrolled mean");
  policy = FacePolicy(FacePurpose::enroll);
  for (int i = 0; i < 5; ++i) {
    auto sample = Inference();
    sample.quality.yaw = float(i) * 0.2f;
    cluster(i * 600, sample);
  }
  Require(policy.Result().state == FaceState::enrolled && policy.Result().templates.size() == 5,
          "new pose bins allow five templates");
  policy = FacePolicy(FacePurpose::enroll);
  cluster(0, Inference());
  cluster(600, Inference(Vector(0)));
  Require(policy.Result().templates.size() == 1, "medoid rejects another identity");
  policy = FacePolicy(FacePurpose::enroll);
  policy.Observe(epoch, Inference(Vector()), ++hash);
  policy.Observe(epoch + 200ms, Inference(Vector(std::cos(0.8f))), ++hash);
  policy.Observe(epoch + 400ms, Inference(Vector(std::cos(0.8f))), ++hash);
  cluster(600, Inference(Vector(std::cos(1.85f))));
  auto repeated_pose = Inference(Vector(std::cos(1.85f)));
  repeated_pose.quality.yaw = 0.3f;
  cluster(1200, repeated_pose);
  Require(policy.Result().templates.size() == 3, "consistent medoid fixture collected");
  cluster(1800, Inference(Vector(std::cos(2.4f))));
  Require(policy.Result().templates.size() == 3,
          "running medoid remains consistent with every retained sample");
  policy = FacePolicy(FacePurpose::enroll);
  auto dark = Inference();
  dark.quality.mean_luma = 0;
  policy.Observe(epoch, dark, ++hash);
  policy.Observe(epoch + 200ms, dark, ++hash);
  auto bright = Inference();
  bright.quality.mean_luma = 255;
  policy.Observe(epoch + 400ms, bright, ++hash);
  Require(policy.Result().hint == "too_dark", "hint uses dominant latest-window reason");
  policy.Observe(epoch + 600ms, Inference(), ++hash);
  Require(!policy.Result().hint, "normal collection clears hint");
}

void LearningTests() {
  const auto epoch = FacePolicy::Clock::time_point{};
  for (const auto purpose : {FacePurpose::verify, FacePurpose::presence}) {
    for (float score : {kLearnFloor - 0.01f, kLearnFloor + 0.001f, kMatchThreshold - 0.01f,
                        kMatchThreshold, kNovelty}) {
      FacePolicy policy(purpose, {Vector()});
      for (int i = 0; i < 3; ++i)
        policy.Observe(epoch + i * 200ms, Inference(Vector(score)), i + 1);
      const bool should_learn =
          purpose == FacePurpose::verify && score >= kLearnFloor && score < kNovelty;
      Require(policy.Result().learn.has_value() == should_learn,
              "learning score interval and purpose");
      if (policy.Result().learn)
        Require(ValidTemplate(*policy.Result().learn), "normalized learned mean");
      if (purpose == FacePurpose::verify)
        Require((policy.Result().state == FaceState::matched) == (score >= kMatchThreshold),
                "match interval");
    }
  }
  FacePolicy policy(FacePurpose::verify, {Vector()});
  auto x = Vector(0.4f);
  auto y = x;
  y[1] *= -1;
  policy.Observe(epoch, Inference(x), 1);
  policy.Observe(epoch + 200ms, Inference(y), 2);
  policy.Observe(epoch + 400ms, Inference(x), 3);
  Require(!policy.Result().learn, "inconsistent near miss cannot learn");
  policy = FacePolicy(FacePurpose::verify, {Vector()});
  for (int i = 0; i < 3; ++i)
    policy.Observe(epoch + i * 200ms, Inference(Vector(0.4f)), i + 1);
  Require(policy.Result().learn.has_value(), "near miss is available while pending");
  for (int i = 3; i < 6; ++i)
    policy.Observe(epoch + i * 200ms, Inference(Vector(kLearnFloor + 0.001f)), i + 1);
  Require(policy.Result().learn && Similarity(*policy.Result().learn, Vector()) > 0.39f,
          "weaker candidate does not replace best near miss");
  for (int i = 6; i < 9; ++i)
    policy.Observe(epoch + i * 200ms, Inference(Vector(0.9f)), i + 1);
  Require(policy.Result().state == FaceState::matched && !policy.Result().learn,
          "familiar accepted probe clears pending learning candidate");
  for (const bool low_live : {false, true}) {
    policy = FacePolicy(FacePurpose::verify, {Vector()});
    auto rejected = Inference(Vector(0.4f), low_live ? 0.49f : 1, 1);
    if (!low_live)
      rejected.quality.sharpness = 0;
    for (int i = 0; i < 3; ++i)
      policy.Observe(epoch + i * 200ms, rejected, i + 1);
    Require(!policy.Result().learn, "learning requires quality and liveness");
  }
  FacePolicy presence(FacePurpose::presence, {Vector()});
  presence.Observe(epoch, Inference(), 1);
  presence.Observe(epoch + 200ms, Inference(), 2);
  Require(presence.Observe(epoch + 400ms, Inference(), 3).presence_match, "presence uses live set");
  Require(!presence.Observe(epoch + 600ms, Inference(), 3).presence_match,
          "presence duplicate cannot extend");
}
}  // namespace

namespace rk::auth {
struct FaceWorkerTestAccess {
  static void RestartAfterExit() {
    std::mutex mutex;
    Faces::Worker worker;
    std::atomic<unsigned> attempts{0}, failures{0};
    auto run = [&](std::stop_token) {
      ++attempts;
      throw std::runtime_error("inference failure");
    };
    auto failed = [&] { ++failures; };
    auto wait_for_exit = [&] {
      const auto deadline = std::chrono::steady_clock::now() + 2s;
      while (worker.state != Faces::Worker::State::kExited &&
             std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(1ms);
      std::lock_guard lock(mutex);
      Require(worker.state == Faces::Worker::State::kExited, "worker did not exit");
    };
    Require(worker.state == Faces::Worker::State::kNotStarted, "worker initial state");
    {
      std::lock_guard lock(mutex);
      worker.Start(mutex, run, failed);
    }
    wait_for_exit();
    Require(worker.thread.joinable(), "exited thread must still require join");
    {
      std::lock_guard lock(mutex);
      worker.Start(mutex, run, failed);
    }
    wait_for_exit();
    Require(attempts == 2 && failures == 2, "exited inference worker was not restarted");
    worker.thread.join();
  }
};
}  // namespace rk::auth

int RunTests(int argc, char** argv) {
  using namespace rk::auth;
  using namespace std::chrono_literals;
  FaceWorkerTestAccess::RestartAfterExit();
  DetectionTests();
  FramePolicyTests();
  WireTests();
  EnrollmentTests();
  LearningTests();
  if (argc != 2)
    return 1;
  const std::filesystem::path models = argv[1];
  if (Faces::Capabilities(models / "not-installed").available)
    return 2;
  const auto capabilities = Faces::Capabilities(models);
  if (!capabilities.available || capabilities.model_version.empty()) {
    std::cerr << capabilities.reason << std::endl;
    return 3;
  }

  Faces faces(models);
  if (faces.Begin({1, "invalid", FacePurpose::verify, 2000, FaceGallery{FaceTemplate{}}}))
    return 4;
  if (!faces.Begin({1, "test", FacePurpose::enroll, 2000, {}}))
    return 5;
  if (faces.Status(2, "test") || faces.Cancel(1, "wrong"))
    return 6;
  std::vector<uint8_t> rgb(320 * 240 * 3, 0);
  faces.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(500ms);
  auto status = faces.Status(1, "test");
  if (!status || status->state != FaceState::pending || !status->templates.empty())
    return 7;
  Require(faces.GateFailures()[static_cast<size_t>(FaceGate::no_qualified_face)] == 1,
          "production counts detection gate failures");
  if (!faces.Cancel(1, "test") || faces.Status(1, "test"))
    return 8;

  if (!faces.Begin({2, "expiry", FacePurpose::enroll, 1, {}}))
    return 9;
  std::this_thread::sleep_for(20ms);
  status = faces.Status(2, "expiry");
  if (!status || status->state != FaceState::expired || !status->templates.empty())
    return 10;
  FaceTemplate enrolled{};
  enrolled[0] = 1.0f;
  if (!faces.Begin({2, "presence", FacePurpose::presence, 7000, {enrolled}}))
    return 11;
  Faces no_match(models);
  if (!no_match.Begin({2, "no-match", FacePurpose::presence, 7000, {enrolled}}))
    return 12;
  std::this_thread::sleep_for(2500ms);
  no_match.SubmitRGB24(320, 240, rgb.data(), 320 * 3);
  std::this_thread::sleep_for(2600ms);
  status = faces.Status(2, "presence");
  if (!status || status->state != FaceState::absent || !status->templates.empty() ||
      status->outcome != FaceOutcome::camera_unavailable)
    return 13;
  status = no_match.Status(2, "no-match");
  if (!status || status->state != FaceState::absent || !status->templates.empty() ||
      status->outcome != FaceOutcome::no_matching_face)
    return 14;
  return 0;
}

int main(int argc, char** argv) {
  try {
    return RunTests(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 99;
  }
}
