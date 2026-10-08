#pragma once
// Apex Chrono — drag / acceleration timing (0-100 km/h, 0-60 mph, 60 ft,
// 1/8 and 1/4 mile, 100-200 km/h), C++17 port of src/lib/gnss/drag.ts.
//
// Pure C++, no Arduino, no heap: fixed arrays sized by the k* constants.
// Independent of LapEngine and of any track — it reads only Doppler speed
// and the GNSS clock, so the firmware runs it alongside lap timing on every
// fix. Parity with the TypeScript reference is checked on host by
// firmware/test_host/drag_parity.cpp against fixtures exported by
// `npm run firmware:fixtures`. Keep the arithmetic identical to drag.ts
// (same operations, same order) or the parity test fails.
//
// Model, limits and validation: docs/DRAG_MODE.md.

#include <cmath>
#include <cstdint>

namespace apex {

constexpr int kDragMaxSpeedTargets = 8;
constexpr int kDragMaxDistTargets = 8;
constexpr int kDragMaxRanges = 4;
constexpr int kDragMaxFit = 25;  // launch-window cap (fixes): 1 s at 25 Hz
constexpr int kDragMaxEvents = 2 + kDragMaxSpeedTargets + kDragMaxDistTargets + 1;

constexpr double kMph = 1.609344;
constexpr double kFt = 0.3048;

struct DragSample {
  double t;        // GNSS seconds (contract timestamp_ms / 1000)
  double speedMs;  // NAN = not reported
  int sats;
  double hdop;
  int fixType;  // -1 unknown, 0 no fix, >= 1 fix (GGA quality)
  double altM;  // NAN = not reported
};

struct DragConfig {
  double armKmh = 1.5;
  double armHoldS = 1.0;
  double launchKmh = 3.0;
  double maxLaunchKmh = 20;
  double launchMinAccelMs2 = 0.5;
  double fitKmh = 12;
  double maxGapS = 0.25;
  int minSats = 6;
  double maxHdop = 2.5;
  double endDropKmh = 10;
  double maxRunS = 60;
  double rolloutM = 0;  // 0 = standing start from t0; kFt = 1 ft rollout
  int nSpeed = 5;
  double speedKmh[kDragMaxSpeedTargets] = {60, 60 * kMph, 100, 150, 200};
  int nDist = 3;
  double distM[kDragMaxDistTargets] = {60 * kFt, 660 * kFt, 1320 * kFt};
  int nRanges = 1;
  double rangeKmh[kDragMaxRanges][2] = {{100, 200}};
};

enum DragFlag : uint8_t { DragGap = 1, DragNoSpeed = 2, DragQuality = 4, DragLateLaunch = 8 };

enum class DragEnd : uint8_t { Lift, Stopped, Timeout, Gap, NoSpeed, Flush };

inline const char* dragEndName(DragEnd e) {
  switch (e) {
    case DragEnd::Lift: return "lift";
    case DragEnd::Stopped: return "stopped";
    case DragEnd::Timeout: return "timeout";
    case DragEnd::Gap: return "gap";
    case DragEnd::NoSpeed: return "no_speed";
    case DragEnd::Flush: return "flush";
  }
  return "?";
}

enum class DragState : uint8_t { Idle, Armed, Running };

inline const char* dragStateName(DragState s) {
  switch (s) {
    case DragState::Idle: return "idle";
    case DragState::Armed: return "armed";
    case DragState::Running: return "running";
  }
  return "?";
}

struct DragRun {
  int number = 0;
  bool valid = false;
  uint8_t flags = 0;
  DragEnd endReason = DragEnd::Flush;
  double t0 = NAN;
  double tStart = NAN;
  double speedTimeS[kDragMaxSpeedTargets];
  double distTimeS[kDragMaxDistTargets];
  double trapKmh[kDragMaxDistTargets];
  double rangeTimeS[kDragMaxRanges];
  double peakKmh = NAN;
  double distanceM = 0;
  double durationS = NAN;
  double slopePct = NAN;
};

enum class DragEventType : uint8_t { Armed, Launch, Speed, Distance, End };

struct DragEvent {
  DragEventType type;
  double t;        // GNSS time of the fix that produced the event
  int index;       // target index (Speed / Distance)
  double timeS;    // seconds from tStart (Speed / Distance); t0 for Launch
  double trapKmh;  // Distance only
};

class DragEngine {
 public:
  DragEngine() { reset(); }
  explicit DragEngine(const DragConfig& c) : cfg_(c) { reset(); }

  // False if a range end is not one of the speed targets or a count is out of bounds.
  bool configValid() const {
    if (cfg_.nSpeed < 0 || cfg_.nSpeed > kDragMaxSpeedTargets) return false;
    if (cfg_.nDist < 0 || cfg_.nDist > kDragMaxDistTargets) return false;
    if (cfg_.nRanges < 0 || cfg_.nRanges > kDragMaxRanges) return false;
    for (int i = 0; i < cfg_.nRanges; i++)
      if (speedIndex(cfg_.rangeKmh[i][0]) < 0 || speedIndex(cfg_.rangeKmh[i][1]) < 0) return false;
    return true;
  }

  void reset() {
    state_ = DragState::Idle;
    running_ = false;
    prevT_ = prevV_ = prevAlt_ = stillSince_ = lastT_ = NAN;
    runs_ = 0;
    rejectedTime_ = 0;
  }

  const DragConfig& config() const { return cfg_; }
  DragState state() const { return state_; }
  int runs() const { return runs_; }
  const DragRun& lastRun() const { return last_; }  // valid when runs() > 0
  uint32_t rejectedTime() const { return rejectedTime_; }

  // Seconds since tStart while running (live display); NAN otherwise.
  double elapsedS() const { return running_ && std::isfinite(r_.tStart) ? lastT_ - r_.tStart : NAN; }
  bool running() const { return running_; }

  // Returns the number of events written to `ev` (capacity kDragMaxEvents).
  int push(const DragSample& s, DragEvent* ev) {
    n_ = 0;
    ev_ = ev;
    const DragConfig& c = cfg_;
    if (!std::isfinite(s.t) || (std::isfinite(prevT_) && !(s.t > prevT_))) {
      rejectedTime_++;
      return 0;
    }
    const double v = s.speedMs;
    const bool haveV = std::isfinite(v);
    const bool goodQ = s.fixType != 0 && s.sats >= c.minSats && s.hdop <= c.maxHdop;
    const double dt = std::isfinite(prevT_) ? s.t - prevT_ : NAN;
    const bool gap = std::isfinite(dt) && dt > c.maxGapS;
    lastT_ = s.t;

    if (running_) {
      if (gap) finish(s.t, DragEnd::Gap, DragGap);
      else if (!haveV) finish(s.t, DragEnd::NoSpeed, DragNoSpeed);
      else {
        if (!goodQ) r_.flags |= DragQuality;
        const double vk = v * kKmh;
        if (!std::isfinite(r_.t0)) {
          fit_[nFit_++] = {s.t, v, s.altM};
          if (vk >= c.fitKmh || nFit_ >= kDragMaxFit) resolveLaunch();
        } else {
          segment(prevT_, prevV_, s.t, v, s.altM);
        }
        if (v > r_.peakMs) r_.peakMs = v;
        if (vk < c.armKmh) finish(s.t, DragEnd::Stopped, 0);
        else if (vk < r_.peakMs * kKmh - c.endDropKmh) finish(s.t, DragEnd::Lift, 0);
        else if (s.t - r_.t0 > c.maxRunS) finish(s.t, DragEnd::Timeout, 0);
      }
      if (!running_) stillSince_ = haveV && goodQ && v * kKmh < c.armKmh ? s.t : NAN;
    } else if (!haveV || !goodQ || gap) {
      state_ = DragState::Idle;
      stillSince_ = haveV && goodQ && v * kKmh < c.armKmh ? s.t : NAN;
    } else {
      const double vk = v * kKmh;
      if (vk < c.armKmh) {
        if (!std::isfinite(stillSince_)) stillSince_ = s.t;
        if (state_ == DragState::Idle && s.t - stillSince_ >= c.armHoldS) {
          state_ = DragState::Armed;
          emit({DragEventType::Armed, s.t, -1, NAN, NAN});
        }
      } else if (state_ == DragState::Armed && vk >= c.launchKmh) {
        launch(s, vk, goodQ);
      } else if (state_ != DragState::Armed) {
        stillSince_ = NAN;
      }
    }

    prevT_ = s.t;
    prevV_ = haveV ? v : NAN;
    prevAlt_ = s.altM;
    return n_;
  }

  int flush(DragEvent* ev) {
    n_ = 0;
    ev_ = ev;
    if (running_) finish(lastT_, DragEnd::Flush, 0);
    return n_;
  }

 private:
  static constexpr double kKmh = 3.6;

  struct Pt {
    double t, v, alt;
  };

  struct Running {
    double t0, tStart;
    uint8_t flags;
    double speedT[kDragMaxSpeedTargets];
    double distT[kDragMaxDistTargets];
    double trapKmh[kDragMaxDistTargets];
    double peakMs;
    double d;
    double alt0;
    double altAtDist[kDragMaxDistTargets];
    double tLast;
  };

  int speedIndex(double kmh) const {
    for (int i = 0; i < cfg_.nSpeed; i++)
      if (cfg_.speedKmh[i] == kmh) return i;
    return -1;
  }

  void emit(const DragEvent& e) {
    if (n_ >= kDragMaxEvents) return;  // cannot happen with valid counts; never overruns `ev`
    if (ev_) ev_[n_] = e;
    n_++;
  }

  void launch(const DragSample& s, double vk, bool goodQ) {
    const DragConfig& c = cfg_;
    r_.t0 = NAN;
    r_.tStart = NAN;
    r_.flags = static_cast<uint8_t>((vk > c.maxLaunchKmh ? DragLateLaunch : 0) | (goodQ ? 0 : DragQuality));
    nFit_ = 0;
    fit_[nFit_++] = {prevT_, prevV_, prevAlt_};
    fit_[nFit_++] = {s.t, s.speedMs, s.altM};
    for (int k = 0; k < kDragMaxSpeedTargets; k++) r_.speedT[k] = NAN;
    for (int k = 0; k < kDragMaxDistTargets; k++) r_.distT[k] = r_.trapKmh[k] = r_.altAtDist[k] = NAN;
    r_.peakMs = s.speedMs > prevV_ ? s.speedMs : prevV_;
    r_.d = 0;
    r_.alt0 = prevAlt_;
    r_.tLast = NAN;
    running_ = true;
    state_ = DragState::Running;
    if (vk >= c.fitKmh) resolveLaunch();
  }

  void resolveLaunch() {
    const DragConfig& c = cfg_;
    const int n = nFit_;
    const Pt& last = fit_[n - 1];
    const double ref = fit_[0].t;
    double tm = 0, vm = 0;
    for (int i = 0; i < n; i++) {
      tm += fit_[i].t - ref;
      vm += fit_[i].v;
    }
    tm /= n;
    vm /= n;
    double sxy = 0, sxx = 0;
    for (int i = 0; i < n; i++) {
      const double dx = fit_[i].t - ref - tm;
      sxy += dx * (fit_[i].v - vm);
      sxx += dx * dx;
    }
    double t0 = fit_[0].t;
    if (sxx > 0 && sxy > 0) {
      t0 = ref + tm - (vm * sxx) / sxy;
      const double lo = last.t - last.v / c.launchMinAccelMs2;
      if (t0 < lo) t0 = lo;
      if (t0 < stillSince_) t0 = stillSince_;
      if (t0 > fit_[0].t) t0 = fit_[0].t;
    }
    r_.t0 = t0;
    r_.tLast = t0;
    if (c.rolloutM <= 0) r_.tStart = t0;
    emit({DragEventType::Launch, last.t, -1, t0, NAN});
    segment(t0, 0, fit_[0].t, fit_[0].v, fit_[0].alt);
    for (int i = 1; i < n; i++) segment(fit_[i - 1].t, fit_[i - 1].v, fit_[i].t, fit_[i].v, fit_[i].alt);
    nFit_ = 0;
  }

  double crossD(double D, double dp, double vp, double a, double dt) const {
    const double rem = D - dp;
    double tau;
    if (std::fabs(a) < 1e-9) {
      tau = vp > 0 ? rem / vp : dt;
    } else {
      double disc = vp * vp + 2 * a * rem;
      if (disc < 0) disc = 0;
      tau = (std::sqrt(disc) - vp) / a;
    }
    if (!(tau >= 0)) tau = 0;
    if (tau > dt) tau = dt;
    return tau;
  }

  void segment(double tp, double vp, double t, double v, double altM) {
    const DragConfig& c = cfg_;
    const double dt = t - tp;
    if (!(dt > 0)) return;
    const double a = (v - vp) / dt;
    const double dp = r_.d;
    const double d = dp + ((vp + v) / 2) * dt;

    if (!std::isfinite(r_.tStart) && d >= c.rolloutM) r_.tStart = tp + crossD(c.rolloutM, dp, vp, a, dt);
    for (int k = 0; k < c.nSpeed; k++) {
      if (std::isfinite(r_.speedT[k])) continue;
      const double target = c.speedKmh[k] / kKmh;
      if (v >= target) {
        r_.speedT[k] = vp >= target ? tp : tp + ((target - vp) / (v - vp)) * dt;
        if (std::isfinite(r_.tStart)) emit({DragEventType::Speed, t, k, r_.speedT[k] - r_.tStart, NAN});
      }
    }
    for (int k = 0; k < c.nDist; k++) {
      if (std::isfinite(r_.distT[k])) continue;
      const double D = c.distM[k];
      if (d >= D) {
        const double tau = crossD(D, dp, vp, a, dt);
        r_.distT[k] = tp + tau;
        r_.trapKmh[k] = (vp + a * tau) * kKmh;
        r_.altAtDist[k] = altM;
        if (std::isfinite(r_.tStart))
          emit({DragEventType::Distance, t, k, r_.distT[k] - r_.tStart, r_.trapKmh[k]});
      }
    }
    r_.d = d;
    r_.tLast = t;
  }

  double rel(double x) const { return std::isfinite(x) && std::isfinite(r_.tStart) ? x - r_.tStart : NAN; }

  void finish(double t, DragEnd reason, uint8_t flag) {
    const DragConfig& c = cfg_;
    if (!std::isfinite(r_.t0)) resolveLaunch();
    r_.flags |= flag;
    DragRun& o = last_;
    o.number = runs_ + 1;
    o.flags = r_.flags;
    o.valid = r_.flags == 0;
    o.endReason = reason;
    o.t0 = r_.t0;
    o.tStart = r_.tStart;
    for (int k = 0; k < kDragMaxSpeedTargets; k++) o.speedTimeS[k] = k < c.nSpeed ? rel(r_.speedT[k]) : NAN;
    for (int k = 0; k < kDragMaxDistTargets; k++) {
      o.distTimeS[k] = k < c.nDist ? rel(r_.distT[k]) : NAN;
      o.trapKmh[k] = k < c.nDist ? r_.trapKmh[k] : NAN;
    }
    for (int i = 0; i < kDragMaxRanges; i++) {
      o.rangeTimeS[i] = NAN;
      if (i >= c.nRanges) continue;
      const int lo = speedIndex(c.rangeKmh[i][0]), hi = speedIndex(c.rangeKmh[i][1]);
      if (lo < 0 || hi < 0) continue;
      const double a = r_.speedT[lo], b = r_.speedT[hi];
      if (std::isfinite(a) && std::isfinite(b)) o.rangeTimeS[i] = b - a;
    }
    o.slopePct = NAN;
    for (int k = c.nDist - 1; k >= 0; k--) {
      if (std::isfinite(r_.distT[k])) {
        if (std::isfinite(r_.alt0) && std::isfinite(r_.altAtDist[k]))
          o.slopePct = ((r_.altAtDist[k] - r_.alt0) / c.distM[k]) * 100;
        break;
      }
    }
    o.peakKmh = r_.peakMs * kKmh;
    o.distanceM = r_.d;
    o.durationS = rel(r_.tLast);
    runs_++;
    running_ = false;
    state_ = DragState::Idle;
    emit({DragEventType::End, t, -1, NAN, NAN});
  }

  DragConfig cfg_;
  DragState state_ = DragState::Idle;
  bool running_ = false;
  Running r_{};
  Pt fit_[kDragMaxFit]{};
  int nFit_ = 0;
  DragRun last_{};
  int runs_ = 0;
  uint32_t rejectedTime_ = 0;
  double prevT_ = NAN, prevV_ = NAN, prevAlt_ = NAN, stillSince_ = NAN, lastT_ = NAN;
  DragEvent* ev_ = nullptr;
  int n_ = 0;
};

// Contract row fields -> drag sample (same conversion as drag.ts rowToDragSample).
inline DragSample dragSampleFromRow(int64_t timestampMs, double speedKmh, int satellites, double hdop, int fixQuality,
                                    double altitudeM) {
  DragSample s;
  s.t = static_cast<double>(timestampMs) / 1000;
  s.speedMs = std::isfinite(speedKmh) ? speedKmh / 3.6 : NAN;
  s.sats = satellites;
  s.hdop = std::isfinite(hdop) ? hdop : 99.9;
  s.fixType = fixQuality;
  s.altM = altitudeM;
  return s;
}

}  // namespace apex
