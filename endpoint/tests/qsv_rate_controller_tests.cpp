#include "media/qsv_rate_controller.hpp"
#include "media/qsv_encoder.hpp"
#include <algorithm>
#include <cmath>
#include <thread>
#include <iostream>
#include <stdexcept>

void Require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

int main() {
  try {
    remotekit::media::EncoderSettings geometry;
    geometry.width = 1938;
    geometry.height = 1082;
    Require(bool(remotekit::media::ValidateQsvGeometry(geometry, 1952, 1088, 1938, 1082)),
            "requested aligned geometry rejected");
    for (size_t field = 0; field < 4; ++field) {
      uint32_t actual[] = {1952, 1088, 1938, 1082};
      actual[field] += 16;
      auto result = remotekit::media::ValidateQsvGeometry(geometry, actual[0], actual[1], actual[2],
                                                          actual[3]);
      Require(!result && result.error().code == remotekit::ErrorCode::kUnavailable,
              "driver geometry adjustment accepted");
      Require(result.error().message.find("requested geometry 1952x1088 crop 1938x1082") !=
                      std::string::npos &&
                  result.error().message.find("actual " + std::to_string(actual[0]) + "x" +
                                              std::to_string(actual[1]) + " crop " +
                                              std::to_string(actual[2]) + "x" +
                                              std::to_string(actual[3])) != std::string::npos,
              "geometry failure omitted requested/actual dimensions");
    }
    remotekit::media::QsvRateController model(1200000, 2400000);
    double final_error = 1;
    for (uint32_t frame = 0; frame < 100; ++frame) {
      model.Prepare(frame, {frame + 1, int64_t(frame) * 33333, false, frame == 0});
      auto chosen = model.GetFrameCtrl(frame, 0, frame == 0);
      const double complexity = frame == 0 ? 4000000 : 1000000;
      auto bytes = uint32_t(std::ceil(complexity / model.Qstep(chosen.qp) / 8));
      auto result = model.Update(frame, 0, bytes);
      if (result.recode) {
        chosen = model.GetFrameCtrl(frame, 1, frame == 0);
        bytes = uint32_t(std::ceil(complexity / model.Qstep(chosen.qp) / 8));
        result = model.Update(frame, 1, bytes);
      }
      Require(!result.recode, "second overshoot must be accepted");
      model.Complete(frame);
      final_error = std::abs(result.telemetry.predicted_bits / (bytes * 8.0) - 1);
    }
    Require(final_error < 0.01, "synthetic P model did not converge");
    remotekit::media::QsvRateController controller(1000000, 2000000);
    controller.Prepare(0, {1, 1000000, false, true});
    const auto initial = controller.GetFrameCtrl(0, 0, true);
    Require(initial.qp == 26, "first IDR must use QP 26");
    Require(std::abs(initial.dt - 1.0 / 60) < 1e-9, "first dt must be 1/60");
    auto result = controller.Update(0, 0, 100000);
    Require(result.recode && result.qp >= 28, "overshoot did not request recode");
    const auto second = controller.GetFrameCtrl(0, 1, true);
    Require(second.qp == result.qp, "GetFrameCtrl lost recode QP");
    result = controller.Update(0, 1, 100000);
    Require(!result.recode && result.telemetry.fullness_after == 800000,
            "recode filled bucket more than once or rejected second overshoot");
    controller.Prepare(1, {2, 1100000, false, false});
    const auto p = controller.GetFrameCtrl(1, 0, false);
    controller.Update(1, 0, 1000);
    controller.Prepare(2, {3, 4000000, true, false});
    const auto keepalive = controller.GetFrameCtrl(2, 0, false);
    Require(keepalive.qp == std::min(51, p.qp + 6), "keepalive QP rule changed");
    controller.Update(2, 0, 10);
    controller.SetRates(1500000, 3000000);
    controller.Prepare(3, {4, 4100000, false, false});
    const auto next = controller.GetFrameCtrl(3, 0, false);
    Require(next.dt_raw == 3.0, "keepalive moved the real-frame dt origin");
    Require(!next.tau_known && next.dt == 1.0 / 60, "static gap retained cadence history");
    Require(next.target_bps == 1500000 && next.maximum_bps == 3000000,
            "GetFrameCtrl did not snapshot new rates");
    Require(next.budget == 25000 && next.cap == 50000, "capture budget or P cap mismatch");
    remotekit::media::QsvRateController cadence(1200000, 2400000);
    int64_t capture = 1000000;
    for (uint32_t index = 0; index < 4; ++index) {
      cadence.Prepare(index, {index + 1, capture, false, index == 0});
      const auto sample = cadence.GetFrameCtrl(index, 0, index == 0);
      Require(sample.tau_known == (index == 3), "cadence needs three real intervals");
      Require(sample.target <= (sample.frame.idr ? 80000 : sample.budget * 1.15),
              "bucket upper bound exceeded");
      cadence.Update(index, 0, 100);
      capture += 20000;
    }
    cadence.Prepare(4, {5, capture + 200000, false, true});
    const auto tail = cadence.GetFrameCtrl(4, 0, true);
    Require(std::abs(tail.tau - 0.02) < 1e-9 && std::abs(tail.dt - 0.02) < 1e-9,
            "tail gap escaped cadence bound");
    Require(tail.target == 72000 && tail.cap == 90000, "IDR target or cap mismatch");
    cadence.Update(4, 0, 100);
    cadence.Prepare(5, {6, capture + 2700000, true, false});
    Require(!cadence.GetFrameCtrl(5, 0, false).tau_known, "static keepalive retained cadence");
    cadence.Update(5, 0, 10);
    cadence.Prepare(6, {7, capture + 2800000, false, false});
    const auto restart = cadence.GetFrameCtrl(6, 0, false);
    Require(!restart.tau_known && restart.dt == 1.0 / 60 && restart.target <= restart.budget,
            "first scroll inherited idle credit");
    remotekit::media::QsvRateController late_idr(1000000, 2000000);
    late_idr.Prepare(0, {1, 1000000, false, false});
    auto late_p = late_idr.GetFrameCtrl(0, 0, false);
    late_idr.Update(0, 0, 1000);
    const double p_complexity = 8000 * late_idr.Qstep(late_p.qp);
    late_idr.Prepare(1, {2, 1500000, false, true});
    const auto late_i = late_idr.GetFrameCtrl(1, 0, true);
    Require(late_i.qp != 26, "later IDR ignored its P-derived model seed");
    late_idr.Update(1, 0, 1000);
    late_idr.Prepare(2, {3, 2000000, false, false});
    late_p = late_idr.GetFrameCtrl(2, 0, false);
    Require(std::abs(late_p.predicted_bits * late_idr.Qstep(late_p.qp) / p_complexity - 1) < 1e-9,
            "later first IDR overwrote existing P history");
    remotekit::media::QsvRateController initial_idrs(1000000, 2000000);
    initial_idrs.Prepare(0, {1, 1000000, false, true});
    const auto first_i = initial_idrs.GetFrameCtrl(0, 0, true);
    initial_idrs.Update(0, 0, 1000);
    initial_idrs.Prepare(1, {2, 1500000, false, true});
    initial_idrs.GetFrameCtrl(1, 0, true);
    initial_idrs.Update(1, 0, 1000);
    initial_idrs.Prepare(2, {3, 2000000, false, false});
    const auto initial_p = initial_idrs.GetFrameCtrl(2, 0, false);
    Require(std::abs(initial_p.predicted_bits * initial_idrs.Qstep(initial_p.qp) /
                         (2000 * initial_idrs.Qstep(first_i.qp)) -
                     1) < 1e-9,
            "consecutive initial IDRs changed the first-IDR P seed");
    // Encoder frame type, including native GOP I frames, controls model selection.
    remotekit::media::QsvRateController native_gop(1200000, 2400000);
    native_gop.Prepare(0, {1, 0, false, false});
    const auto native_i = native_gop.GetFrameCtrl(0, 0, true);
    Require(native_i.frame.idr && native_i.target == 72000 && native_i.cap == 90000,
            "native GOP I frame used the P model");
    native_gop.Update(0, 0, 1000);
    Require(native_gop.Complete(0).actual_bits == 8000, "completion lost actual bits");
    native_gop.Prepare(1, {2, 16667, false, false});
    native_gop.Cancel(1);
    native_gop.Prepare(1, {3, 16667, false, false});
    Require(native_gop.GetFrameCtrl(1, 0, false).frame.cookie == 3, "busy retry retained context");
    // Keepalive bits fill the bucket but do not teach the P model or cadence.
    remotekit::media::QsvRateController isolation(1200000, 2400000);
    isolation.Prepare(0, {1, 0, false, false});
    const auto before_keepalive = isolation.GetFrameCtrl(0, 0, false);
    isolation.Update(0, 0, 1000);
    isolation.Complete(0);
    isolation.Prepare(1, {2, 20000, true, false});
    isolation.GetFrameCtrl(1, 0, false);
    const auto counted = isolation.Update(1, 0, 100);
    Require(counted.telemetry.fullness_after == 800, "keepalive absent from bucket");
    isolation.Complete(1);
    isolation.Prepare(2, {3, 40000, false, false});
    const auto after_keepalive = isolation.GetFrameCtrl(2, 0, false);
    Require(after_keepalive.dt_raw == 0.04 && !after_keepalive.tau_known,
            "keepalive entered real cadence history");
    Require(std::abs(after_keepalive.predicted_bits * isolation.Qstep(after_keepalive.qp) -
                     8000 * isolation.Qstep(before_keepalive.qp)) < 1e-6,
            "keepalive changed P complexity");
    remotekit::media::QsvRateController slow(1200000, 2400000);
    for (uint32_t frame = 0; frame < 4; ++frame) {
      slow.Prepare(frame, {frame + 1, int64_t(frame) * 1000000, false, false});
      const auto sample = slow.GetFrameCtrl(frame, 0, false);
      if (frame == 3) {
        Require(sample.tau == 1 && sample.dt == 0.5 && sample.budget == 600000,
                "effective interval exceeded half a second");
        Require(sample.target == 690000 && sample.cap == 600000,
                "known-cadence multiplier or maximum-rate P cap mismatch");
      }
      slow.Update(frame, 0, 100);
      slow.Complete(frame);
    }
    slow.Prepare(4, {5, 5500000, false, false});
    const auto exact_gap = slow.GetFrameCtrl(4, 0, false);
    Require(!exact_gap.tau_known && exact_gap.dt == 1.0 / 60,
            "exact 2.5 second gap retained cadence");
    remotekit::media::QsvRateController step_limit(1200000, 2400000);
    step_limit.Prepare(0, {1, 0, false, false});
    const auto stable = step_limit.GetFrameCtrl(0, 0, false);
    step_limit.Update(0, 0, 2500);
    step_limit.Complete(0);
    step_limit.SetRates(300000, 600000);
    step_limit.Prepare(1, {2, 16667, false, false});
    const auto limited = step_limit.GetFrameCtrl(1, 0, false);
    Require(limited.qp == stable.qp + 4, "P QP step exceeded four without a miss");
    Require(step_limit.Update(1, 0, 2000).recode, "cap miss did not recode");
    step_limit.GetFrameCtrl(1, 1, false);
    const auto missed = step_limit.Update(1, 1, 10000);
    Require(!missed.recode && missed.telemetry.recodes == 1 && missed.telemetry.cap_hits == 1,
            "recode or cap-hit accounting changed");
    step_limit.Complete(1);
    step_limit.SetRates(1000, 2000);
    step_limit.Prepare(2, {3, 33334, false, false});
    Require(step_limit.GetFrameCtrl(2, 0, false).qp > missed.qp + 4,
            "greater-than-twofold miss did not lift the P QP limit");
    remotekit::media::QsvRateController handoff(1000000, 2000000);
    std::thread writer([&] {
      for (uint32_t index = 1; index <= 10000; ++index)
        handoff.SetRates(index, index * 2);
    });
    for (uint32_t index = 0; index < 10000; ++index) {
      const auto rates = handoff.Snapshot();
      Require(rates.maximum == rates.target * 2, "rate snapshot tore");
    }
    writer.join();
    handoff.SetRates(3000000, 2000000);
    Require(handoff.Snapshot().target == 2000000, "target exceeded maximum");
    std::cout << "RateController model, recode, bucket, keepalive and rate handoff verified\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
