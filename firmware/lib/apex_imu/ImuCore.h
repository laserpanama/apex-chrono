#pragma once
// Apex Chrono V1.5 — BMI270 sample pipeline, hardware-independent.
//
// Pure C++17 (no Arduino): everything that can be wrong without a chip in
// front of you lives here and is host-tested with a mock backend
// (firmware/test_host/hw_test.cpp):
//   - bring-up state machine (not found / init failed / comm test failed / running / failed)
//   - communication test after init (live data, not just a CHIP_ID echo)
//   - raw -> SI conversion for the configured ranges
//   - timestamps: MCU microseconds (same clock as GNSS rows' mcu_ms) plus the
//     BMI270's own 24-bit sensor time, unwrapped to 64 bits
//   - give-up after consecutive read failures, so a dead bus goes quiet
//   - ImuSink: the interface a future logger implements (V2 analysis is out of scope)
//
// The real chip lives behind ImuBackend; the ESP32 implementation (Imu.cpp)
// uses Bosch's BMI270 Sensor API, which uploads Bosch's config file.
//
// Nothing here is ever read by the timing engine. IMU failure = no IMU data,
// never no timing.

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace apex {

// ───────────────────────────── data types ─────────────────────────────

// One raw register snapshot, as the chip reports it.
struct ImuRaw {
  int16_t ax = 0, ay = 0, az = 0;  // accelerometer LSB
  int16_t gx = 0, gy = 0, gz = 0;  // gyroscope LSB
  uint32_t sensorTime = 0;         // 24-bit SENSORTIME counter, 39.0625 us/tick
  bool accFresh = false;           // STATUS.drdy_acc: new accel data since last read
  bool gyrFresh = false;           // STATUS.drdy_gyr
};

// One converted, timestamped sample. Axis frame = BMI270 chip frame
// (mounting orientation is a V2 concern; not remapped here).
struct ImuSample {
  uint32_t seq = 0;          // 0,1,2,... per accepted sample this session
  uint64_t mcuUs = 0;        // ESP32 esp_timer microseconds at read completion (same clock as millis())
  uint64_t sensorTimeUs = 0; // chip clock, unwrapped; monotonic within a session
  float ax = 0, ay = 0, az = 0;  // m/s^2
  float gx = 0, gy = 0, gz = 0;  // deg/s
  bool accFresh = false;
  bool gyrFresh = false;
};

// Interface for future logging. Called once per accepted sample, from the
// main loop, after timing work for that iteration is done. Must not block.
class ImuSink {
 public:
  virtual ~ImuSink() = default;
  virtual void onImuSample(const ImuSample& s) = 0;
};

// Fixed-size, overwrite-oldest ring: the simplest ImuSink a future SD logger
// (or a test) can drain in batches. Single-threaded (main loop only).
template <size_t N>
class ImuRing : public ImuSink {
 public:
  void onImuSample(const ImuSample& s) override {
    buf_[head_] = s;
    head_ = (head_ + 1) % N;
    if (count_ < N) count_++;
    else dropped_++;
  }
  // Pops the oldest sample. Returns false when empty.
  bool pop(ImuSample& out) {
    if (!count_) return false;
    const size_t tail = (head_ + N - count_) % N;
    out = buf_[tail];
    count_--;
    return true;
  }
  size_t size() const { return count_; }
  uint32_t dropped() const { return dropped_; }  // overwritten before being popped

 private:
  ImuSample buf_[N];
  size_t head_ = 0, count_ = 0;
  uint32_t dropped_ = 0;
};

// ─────────────────────────── configuration ───────────────────────────

struct ImuConfig {
  int accelRangeG = 8;        // 2/4/8/16
  int gyroRangeDps = 500;     // 125/250/500/1000/2000
  int odrHz = 100;            // accel + gyro output data rate
};

// LSB per unit for the BMI270's signed 16-bit outputs (full scale = range).
inline float accelLsbPerG(int rangeG) { return 32768.0f / static_cast<float>(rangeG); }
inline float gyroLsbPerDps(int rangeDps) { return 32768.0f / static_cast<float>(rangeDps); }
constexpr float kStandardGravity = 9.80665f;
constexpr double kSensorTimeTickUs = 39.0625;  // BMI270 SENSORTIME resolution
constexpr uint32_t kSensorTimeMask = 0xFFFFFF;  // 24-bit counter, wraps every ~655 s

// ───────────────────────────── backend ─────────────────────────────

enum class ImuInitResult : uint8_t { Ok, NotFound, WrongChip, ConfigFailed };

class ImuBackend {
 public:
  virtual ~ImuBackend() = default;
  // Probe, verify CHIP_ID, upload config, set ranges/ODR, enable sensors.
  virtual ImuInitResult init(const ImuConfig& cfg, uint8_t& chipIdOut) = 0;
  // One burst read of STATUS..SENSORTIME. False on any bus error / short read.
  virtual bool read(ImuRaw& out) = 0;
  virtual uint64_t nowUs() = 0;
  virtual void sleepMs(uint32_t ms) = 0;
};

// ───────────────────────────── core ─────────────────────────────

enum class ImuState : uint8_t {
  NotStarted,
  NotFound,        // nothing answered at 0x68 / 0x69
  WrongChip,       // something answered, CHIP_ID != 0x24
  InitFailed,      // config upload / sensor config / enable failed
  CommTestFailed,  // initialized, but did not produce live data
  Running,
  Failed,          // was Running, then hit kMaxConsecutiveFailures
};

inline const char* imuStateName(ImuState s) {
  switch (s) {
    case ImuState::NotStarted: return "not_started";
    case ImuState::NotFound: return "not_found";
    case ImuState::WrongChip: return "wrong_chip";
    case ImuState::InitFailed: return "init_failed";
    case ImuState::CommTestFailed: return "comm_test_failed";
    case ImuState::Running: return "running";
    case ImuState::Failed: return "failed";
  }
  return "?";
}

struct ImuCommTest {
  bool ran = false;
  bool passed = false;
  int reads = 0;              // successful burst reads during the test
  int freshAcc = 0, freshGyr = 0;
  bool timeAdvanced = false;  // sensor time strictly increased read to read
  bool notStuck = false;      // at least one raw axis changed (a live MEMS always has noise)
  float accelMagG = NAN;      // |a| of the last test sample, in g (~1.0 when level and still)
  bool gravityPlausible = false;  // 0.7 g < |a| < 1.3 g: informational, never fails the test
};

class ImuCore {
 public:
  static constexpr int kCommTestReads = 5;
  static constexpr int kMaxConsecutiveFailures = 10;

  bool begin(ImuBackend& backend, const ImuConfig& cfg = ImuConfig{}) {
    backend_ = &backend;
    cfg_ = cfg;
    accScale_ = kStandardGravity / accelLsbPerG(cfg.accelRangeG);
    gyrScale_ = 1.0f / gyroLsbPerDps(cfg.gyroRangeDps);
    switch (backend.init(cfg, chipId_)) {
      case ImuInitResult::NotFound: state_ = ImuState::NotFound; return false;
      case ImuInitResult::WrongChip: state_ = ImuState::WrongChip; return false;
      case ImuInitResult::ConfigFailed: state_ = ImuState::InitFailed; return false;
      case ImuInitResult::Ok: break;
    }
    runCommTest();
    state_ = test_.passed ? ImuState::Running : ImuState::CommTestFailed;
    return test_.passed;
  }

  // Call often (main loop). Reads at most twice per ODR period (so a poll
  // that lands just before the chip's update doesn't cost a whole sample);
  // returns true when a new sample was produced (and handed to the sink).
  bool poll() {
    if (state_ != ImuState::Running) return false;
    const uint64_t now = backend_->nowUs();
    if (havePolled_ && now - lastPollUs_ < periodUs() / 2) return false;
    lastPollUs_ = now;
    havePolled_ = true;

    ImuRaw raw;
    if (!backend_->read(raw)) {
      readFailures_++;
      if (++consecutiveFailures_ >= kMaxConsecutiveFailures) state_ = ImuState::Failed;
      return false;
    }
    consecutiveFailures_ = 0;
    if (!raw.accFresh && !raw.gyrFresh) return false;  // polled between ODR ticks: nothing new

    convert(raw, backend_->nowUs(), latest_);
    latest_.seq = samples_++;
    haveLatest_ = true;
    if (sink_) sink_->onImuSample(latest_);
    return true;
  }

  void setSink(ImuSink* s) { sink_ = s; }
  ImuState state() const { return state_; }
  bool running() const { return state_ == ImuState::Running; }
  uint8_t chipId() const { return chipId_; }
  const ImuCommTest& commTest() const { return test_; }
  const ImuConfig& config() const { return cfg_; }
  bool haveLatest() const { return haveLatest_; }
  const ImuSample& latest() const { return latest_; }
  uint32_t samples() const { return samples_; }
  uint32_t readFailures() const { return readFailures_; }

 private:
  uint64_t periodUs() const { return cfg_.odrHz > 0 ? 1000000ULL / static_cast<uint64_t>(cfg_.odrHz) : 10000ULL; }

  uint64_t unwrapSensorTime(uint32_t t24) {
    t24 &= kSensorTimeMask;
    if (!haveSensorTime_) {
      haveSensorTime_ = true;
      sensorTicks_ = t24;
    } else {
      const uint32_t delta = (t24 - lastSensorTime24_) & kSensorTimeMask;
      sensorTicks_ += delta;
    }
    lastSensorTime24_ = t24;
    return static_cast<uint64_t>(static_cast<double>(sensorTicks_) * kSensorTimeTickUs);
  }

  void convert(const ImuRaw& r, uint64_t nowUs, ImuSample& s) {
    s.mcuUs = nowUs;
    s.sensorTimeUs = unwrapSensorTime(r.sensorTime);
    s.ax = r.ax * accScale_;
    s.ay = r.ay * accScale_;
    s.az = r.az * accScale_;
    s.gx = r.gx * gyrScale_;
    s.gy = r.gy * gyrScale_;
    s.gz = r.gz * gyrScale_;
    s.accFresh = r.accFresh;
    s.gyrFresh = r.gyrFresh;
  }

  // Proves the chip is producing live, changing data — not just that
  // something on the bus echoes 0x24. Takes ~kCommTestReads ODR periods.
  void runCommTest() {
    test_ = ImuCommTest{};
    test_.ran = true;
    ImuRaw prev{}, cur{};
    bool havePrev = false, timeOk = true;
    const uint32_t waitMs = static_cast<uint32_t>(periodUs() / 1000ULL) + 2;
    for (int i = 0; i < kCommTestReads; i++) {
      backend_->sleepMs(waitMs);
      if (!backend_->read(cur)) continue;
      test_.reads++;
      if (cur.accFresh) test_.freshAcc++;
      if (cur.gyrFresh) test_.freshGyr++;
      if (havePrev) {
        if (((cur.sensorTime - prev.sensorTime) & kSensorTimeMask) == 0) timeOk = false;
        if (cur.ax != prev.ax || cur.ay != prev.ay || cur.az != prev.az || cur.gx != prev.gx || cur.gy != prev.gy ||
            cur.gz != prev.gz)
          test_.notStuck = true;
      }
      prev = cur;
      havePrev = true;
    }
    test_.timeAdvanced = test_.reads >= 2 && timeOk;
    if (test_.reads > 0) {
      const float lsb = accelLsbPerG(cfg_.accelRangeG);
      const float x = prev.ax / lsb, y = prev.ay / lsb, z = prev.az / lsb;
      test_.accelMagG = std::sqrt(x * x + y * y + z * z);
      test_.gravityPlausible = test_.accelMagG > 0.7f && test_.accelMagG < 1.3f;
    }
    test_.passed = test_.reads == kCommTestReads && test_.freshAcc > 0 && test_.freshGyr > 0 &&
                   test_.timeAdvanced && test_.notStuck;
  }

  ImuBackend* backend_ = nullptr;
  ImuSink* sink_ = nullptr;
  ImuConfig cfg_{};
  ImuState state_ = ImuState::NotStarted;
  ImuCommTest test_{};
  uint8_t chipId_ = 0;
  float accScale_ = 0, gyrScale_ = 0;

  bool havePolled_ = false;
  uint64_t lastPollUs_ = 0;
  bool haveSensorTime_ = false;
  uint32_t lastSensorTime24_ = 0;
  uint64_t sensorTicks_ = 0;

  ImuSample latest_{};
  bool haveLatest_ = false;
  uint32_t samples_ = 0, readFailures_ = 0;
  int consecutiveFailures_ = 0;
};

}  // namespace apex
