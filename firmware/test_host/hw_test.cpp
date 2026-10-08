// Host tests for the V1.5 display + IMU layers (no hardware, no Arduino).
// Build & run:  npm run firmware:test:hw   (part of npm run firmware:test)
//
// Covers what can be wrong without a chip or panel in front of you:
//   display  — text/layout of every status field, line widths and overlap
//   timing   — TimingView over the real LapEngine, replaying parity fixtures
//   imu      — init states, communication test, conversion, timestamps,
//              sensor-time wrap, failure give-up, ImuRing logging sink

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#include "DisplayModel.h"
#include "ImuCore.h"
#include "TimingView.h"
#include "apex_timing.h"

static int g_checks = 0, g_failed = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    g_checks++;                                                              \
    if (!(cond)) {                                                           \
      g_failed++;                                                            \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                        \
  } while (0)

#define CHECK_STR(actual, expected)                                                          \
  do {                                                                                       \
    g_checks++;                                                                              \
    if (std::strcmp((actual), (expected)) != 0) {                                            \
      g_failed++;                                                                            \
      std::printf("  FAIL %s:%d  got \"%s\" want \"%s\"\n", __FILE__, __LINE__, (actual), (expected)); \
    }                                                                                        \
  } while (0)

static bool near(double a, double b, double eps) { return std::fabs(a - b) <= eps; }

// ───────────────────────────── display ─────────────────────────────

static void testLapTimeFormat() {
  std::printf("display: lap time format\n");
  char b[16];
  apex::formatLapTime(83.456, 3, b, sizeof b);
  CHECK_STR(b, "1:23.456");
  apex::formatLapTime(59.9996, 3, b, sizeof b);
  CHECK_STR(b, "1:00.000");
  apex::formatLapTime(5.04, 1, b, sizeof b);
  CHECK_STR(b, "0:05.0");
  apex::formatLapTime(119.96, 1, b, sizeof b);
  CHECK_STR(b, "2:00.0");
  apex::formatLapTime(NAN, 3, b, sizeof b);
  CHECK_STR(b, "-:--.---");
  apex::formatLapTime(-1, 1, b, sizeof b);
  CHECK_STR(b, "-:--.-");
  apex::formatLapTime(1e9, 3, b, sizeof b);
  CHECK_STR(b, "99:59.999");
}

static void testFrameIdle() {
  std::printf("display: boot / no track frame\n");
  apex::DisplayStatus s;
  apex::DisplayFrame f;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[0].text, "NO FIX SAT  0 HDOP --");
  CHECK(f.line[0].tone == apex::Tone::Bad);
  CHECK_STR(f.line[1].text, "NO TRACK LOADED");
  CHECK_STR(f.line[2].text, "-:--.-");
  CHECK_STR(f.line[3].text, "LAP -");
  CHECK_STR(f.line[4].text, "LAST --");
  CHECK_STR(f.line[5].text, "BEST --");
  CHECK_STR(f.line[6].text, "SD NO CARD");
  CHECK_STR(f.line[7].text, "IMU --");
}

static void testFrameRacing() {
  std::printf("display: in-lap frame (all Task 4 fields)\n");
  apex::DisplayStatus s;
  s.gnssLock = true;
  s.sats = 12;
  s.hdop = 0.8;
  s.timing = apex::TimingStatus::InLap;
  s.lapNumber = 4;
  s.lapElapsedS = 83.44;
  s.sector = 2;
  s.sectorCount = 3;
  s.haveLastLap = true;
  s.lastLapS = 83.456;
  s.lastLapValid = false;
  s.haveBestLap = true;
  s.bestLapS = 82.901;
  s.sd = apex::SdStatus::Logging;
  s.sdRows = 1234;
  s.imu = apex::ImuStatus::Running;
  s.imuHz = 100;
  apex::DisplayFrame f;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[0].text, "FIX    SAT 12 HDOP 0.8");  // GNSS lock, satellites, HDOP
  CHECK(f.line[0].tone == apex::Tone::Good);
  CHECK_STR(f.line[1].text, "TIMING");  // timing status
  CHECK_STR(f.line[2].text, "1:23.4");  // lap time
  CHECK_STR(f.line[3].text, "LAP 4        S2/3");  // current lap + sector, right-aligned
  CHECK((int)std::strlen(f.line[3].text) == apex::displayColumns(3));
  CHECK_STR(f.line[4].text, "LAST 1:23.456 X");  // last lap, flagged invalid
  CHECK(f.line[4].tone == apex::Tone::Bad);
  CHECK_STR(f.line[5].text, "BEST 1:22.901");
  CHECK_STR(f.line[6].text, "SD LOG 1234");  // SD status
  CHECK_STR(f.line[7].text, "IMU OK 100HZ");

  s.sdFailures = 3;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[6].text, "SD LOG 1234 ERR 3");
  CHECK(f.line[6].tone == apex::Tone::Bad);
  s.sd = apex::SdStatus::Failed;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[6].text, "SD FAILED");
  s.imu = apex::ImuStatus::Failed;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[7].text, "IMU FAILED");

  s.timing = apex::TimingStatus::WaitStart;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[1].text, "READY - CROSS START");
  CHECK_STR(f.line[2].text, "-:--.-");  // no live time outside a lap
  CHECK_STR(f.line[3].text, "LAP 4");   // no sector outside a lap
  s.timing = apex::TimingStatus::NoFix;
  apex::buildFrame(s, f);
  CHECK_STR(f.line[1].text, "WAITING GNSS LOCK");
}

static void testFrameGeometry() {
  std::printf("display: worst-case widths, no overlap, fits 320x240\n");
  apex::DisplayStatus s;
  s.gnssLock = false;
  s.sats = 99;
  s.hdop = 12.3;
  s.timing = apex::TimingStatus::InLap;
  s.lapNumber = 999;
  s.lapElapsedS = 5999;
  s.sector = 16;
  s.sectorCount = 16;
  s.haveLastLap = s.haveBestLap = true;
  s.lastLapS = s.bestLapS = 5999.999;
  s.sd = apex::SdStatus::Logging;
  s.sdRows = 999999;  // > 27 h at 10 Hz
  s.sdFailures = 9999;
  s.imu = apex::ImuStatus::Running;
  s.imuHz = 200;
  apex::DisplayFrame f;
  apex::buildFrame(s, f);
  int prevBottom = 0;
  for (int i = 0; i < apex::kDisplayLineCount; i++) {
    const apex::DisplayLine& l = f.line[i];
    const int len = static_cast<int>(std::strlen(l.text));
    const int h = 8 * l.size;
    if (len > apex::displayColumns(l.size)) std::printf("  line %d too wide: \"%s\"\n", i, l.text);
    CHECK(len <= apex::displayColumns(l.size));
    CHECK(l.y >= prevBottom);
    CHECK(l.y + h <= apex::kDisplayHeightPx);
    prevBottom = l.y + h;
  }
}

// ───────────────────────── timing view (real engine) ─────────────────────────

static double parseNum(const char* s) { return std::strncmp(s, "nan", 3) == 0 ? NAN : std::strtod(s, nullptr); }

static std::vector<std::string> splitCsv(const std::string& line) {
  std::vector<std::string> out;
  size_t p = 0;
  while (true) {
    size_t q = line.find(',', p);
    out.push_back(line.substr(p, q == std::string::npos ? std::string::npos : q - p));
    if (q == std::string::npos) break;
    p = q + 1;
  }
  return out;
}

static bool loadTrack(const std::string& path, apex::Track& tr) {
  FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return false;
  char kw[32], a[64], b[64], c[64], d[64];
  int n = 0, ng = 0;
  bool ok = std::fscanf(f, "%31s %63s %63s", kw, a, b) == 3;
  const double olat = parseNum(a), olon = parseNum(b);
  ok = ok && std::fscanf(f, "%31s %d", kw, &n) == 2;
  std::vector<double> lat(ok ? n : 0), lon(ok ? n : 0);
  for (int i = 0; ok && i < n; i++) {
    ok = std::fscanf(f, "%63s %63s", a, b) == 2;
    lat[i] = parseNum(a);
    lon[i] = parseNum(b);
  }
  ok = ok && std::fscanf(f, "%31s %d", kw, &ng) == 2;
  std::vector<apex::GeoGate> gates(ok ? ng : 0);
  for (int i = 0; ok && i < ng; i++) {
    ok = std::fscanf(f, "%31s %63s %63s %63s %63s", kw, a, b, c, d) == 5;
    gates[i] = {std::strcmp(kw, "SF") == 0 ? apex::GateKind::StartFinish : apex::GateKind::Sector, parseNum(a),
                parseNum(b), parseNum(c), parseNum(d)};
  }
  std::fclose(f);
  return ok && tr.compile(olat, olon, lat.data(), lon.data(), n, gates.data(), ng);
}

static apex::Track g_track;  // large: keep off the stack
static apex::LapEngine g_engine;

static void testTimingView(const std::string& dir) {
  std::printf("timing view: replay club_3m_doppler through the real LapEngine\n");
  const std::string base = dir + "/club_3m_doppler";
  CHECK(loadTrack(base + ".track", g_track));
  g_engine.reset(&g_track);

  apex::GnssSnapshot g;
  apex::SectorTracker sectors;
  apex::DisplayStatus st;
  apex::fillTiming(g_engine, sectors, false, g, st);
  CHECK(st.timing == apex::TimingStatus::NoTrack);
  apex::fillTiming(g_engine, sectors, true, g, st);
  CHECK(st.timing == apex::TimingStatus::NoFix);  // track loaded, no fix yet

  FILE* f = std::fopen((base + ".fixes.csv").c_str(), "r");
  CHECK(f != nullptr);
  if (!f) return;
  char buf[512];
  bool header = true, sawWait = false, sawInLap = false, sectorOk = true, lastLapOk = true, elapsedOk = true;
  std::set<int> sectorsSeen;
  int prevSector = 0, prevLap = 0, sectorSteps = 0;
  apex::Event ev[apex::MAX_EVENTS];
  while (std::fgets(buf, sizeof buf, f)) {
    if (header) { header = false; continue; }
    std::string line(buf);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (line.empty()) continue;
    auto c = splitCsv(line);
    apex::GnssFix fx{parseNum(c[0].c_str()), parseNum(c[1].c_str()), parseNum(c[2].c_str()), parseNum(c[3].c_str()),
                     parseNum(c[4].c_str()), std::atoi(c[5].c_str()), parseNum(c[6].c_str()), std::atoi(c[7].c_str())};
    const int n = g_engine.push(fx, ev);
    g.haveFix = true;
    g.last = fx;
    g.stale = false;
    for (int i = 0; i < n; i++) sectors.onEvent(ev[i], g_engine);
    apex::fillTiming(g_engine, sectors, true, g, st);

    if (st.timing == apex::TimingStatus::WaitStart) sawWait = true;
    if (st.timing == apex::TimingStatus::InLap) {
      sawInLap = true;
      if (st.sector < 1 || st.sector > st.sectorCount) sectorOk = false;
      sectorsSeen.insert(st.sector);
      if (!(std::isfinite(st.lapElapsedS) && st.lapElapsedS >= -1.0)) elapsedOk = false;
      // Within one lap the sector only moves forward, one step at a time.
      if (st.lapNumber == prevLap && st.sector != prevSector) {
        if (st.sector != prevSector + 1) sectorOk = false;
        sectorSteps++;
      }
      prevSector = st.sector;
      prevLap = st.lapNumber;
    }
    for (int i = 0; i < n; i++) {
      if (ev[i].type == apex::EventType::Lap) {
        const apex::LapRecord* r = g_engine.lastLap();
        if (!r || !st.haveLastLap || st.lastLapS != r->timeS || st.lastLapValid != r->valid) lastLapOk = false;
      }
    }
  }
  std::fclose(f);
  CHECK(sawWait);
  CHECK(sawInLap);
  CHECK(sectorOk);
  CHECK(elapsedOk);
  CHECK(lastLapOk);
  CHECK(sectorSteps > 0);
  CHECK(st.sectorCount == (g_track.nGates <= 1 ? 1 : g_track.nGates));
  CHECK((int)sectorsSeen.size() == st.sectorCount);
  CHECK(g_engine.lapCount > 0);
  CHECK(st.haveBestLap == g_engine.haveBest);
  std::printf("  laps=%d sectors/lap=%d sector steps=%d\n", g_engine.lapCount, st.sectorCount, sectorSteps);

  // Stale GNSS (receiver went quiet) shows as no lock, even mid-lap.
  g.stale = true;
  apex::fillTiming(g_engine, sectors, true, g, st);
  CHECK(!st.gnssLock);
  CHECK(st.timing == apex::TimingStatus::NoFix);
}

// ───────────────────────────── IMU ─────────────────────────────

// Scripted BMI270: produces a noisy, level, stationary chip at the
// configured ODR, with optional faults.
class MockImu : public apex::ImuBackend {
 public:
  apex::ImuInitResult initResult = apex::ImuInitResult::Ok;
  uint8_t chipId = 0x24;
  bool stuck = false;        // identical raw values every read
  bool frozenTime = false;   // sensor time never advances
  bool neverFresh = false;   // DRDY bits never set
  int failNext = 0;          // next N reads fail
  uint32_t sensorTime = 1000;
  uint64_t clockUs = 0;
  int reads = 0;
  int16_t azRaw = 4096;      // 1 g at +-8 g range
  int16_t gzRaw = 0;

  apex::ImuInitResult init(const apex::ImuConfig&, uint8_t& id) override {
    id = chipId;
    return initResult;
  }
  bool read(apex::ImuRaw& r) override {
    reads++;
    if (failNext > 0) {
      failNext--;
      return false;
    }
    const int noise = stuck ? 0 : (reads % 3) - 1;
    r.ax = static_cast<int16_t>(noise);
    r.ay = static_cast<int16_t>(-noise);
    r.az = static_cast<int16_t>(azRaw + noise);
    r.gx = static_cast<int16_t>(noise * 2);
    r.gy = 0;
    r.gz = gzRaw;
    if (!frozenTime) sensorTime = (sensorTime + 256) & apex::kSensorTimeMask;  // 256 ticks = 10 ms
    r.sensorTime = sensorTime;
    r.accFresh = r.gyrFresh = !neverFresh;
    return true;
  }
  uint64_t nowUs() override { return clockUs; }
  void sleepMs(uint32_t ms) override { clockUs += ms * 1000ULL; }
};

static void testImuInitStates() {
  std::printf("imu: init / communication-test failure states\n");
  {
    MockImu m;
    m.initResult = apex::ImuInitResult::NotFound;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::NotFound);
    CHECK(!c.poll());
    CHECK(m.reads == 0);
  }
  {
    MockImu m;
    m.initResult = apex::ImuInitResult::WrongChip;
    m.chipId = 0x26;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::WrongChip);
    CHECK(c.chipId() == 0x26);
  }
  {
    MockImu m;
    m.initResult = apex::ImuInitResult::ConfigFailed;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::InitFailed);
  }
  {
    MockImu m;
    m.stuck = true;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::CommTestFailed);
    CHECK(!c.commTest().notStuck);
  }
  {
    MockImu m;
    m.frozenTime = true;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::CommTestFailed);
    CHECK(!c.commTest().timeAdvanced);
  }
  {
    MockImu m;
    m.neverFresh = true;
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::CommTestFailed);
  }
  {
    MockImu m;
    m.failNext = 1;  // one bus error during the test
    apex::ImuCore c;
    CHECK(!c.begin(m));
    CHECK(c.state() == apex::ImuState::CommTestFailed);
    CHECK(c.commTest().reads == apex::ImuCore::kCommTestReads - 1);
  }
}

static void testImuSamples() {
  std::printf("imu: samples, conversion, timestamps, logging sink\n");
  MockImu m;
  m.gzRaw = 655;  // 655 / (32768/500) = 9.995 deg/s
  apex::ImuCore c;
  apex::ImuRing<8> ring;
  c.setSink(&ring);
  CHECK(c.begin(m));
  CHECK(c.state() == apex::ImuState::Running);
  const apex::ImuCommTest& t = c.commTest();
  CHECK(t.passed && t.reads == 5 && t.timeAdvanced && t.notStuck && t.gravityPlausible);
  CHECK(near(t.accelMagG, 1.0, 0.01));

  // Throttle: a second poll inside half an ODR period does not touch the bus.
  CHECK(c.poll());
  const int readsAfterFirst = m.reads;
  m.clockUs += 1000;
  CHECK(!c.poll());
  CHECK(m.reads == readsAfterFirst);

  const apex::ImuSample& s = c.latest();
  CHECK(s.seq == 0);
  CHECK(s.mcuUs == m.clockUs - 1000);
  CHECK(near(s.az, 9.80665, 0.01));
  CHECK(near(s.gz, 9.995, 0.01));
  CHECK(s.accFresh && s.gyrFresh);

  uint64_t prevSensor = s.sensorTimeUs;
  bool monotonic = true, tenMs = true;
  for (int i = 0; i < 5; i++) {
    m.clockUs += 10000;
    CHECK(c.poll());
    const apex::ImuSample& x = c.latest();
    if (x.sensorTimeUs <= prevSensor) monotonic = false;
    if (x.sensorTimeUs - prevSensor != 10000) tenMs = false;  // 256 ticks * 39.0625 us
    prevSensor = x.sensorTimeUs;
  }
  CHECK(monotonic);
  CHECK(tenMs);
  CHECK(c.samples() == 6);

  // Sink got every sample, in order.
  CHECK(ring.size() == 6);
  apex::ImuSample out;
  uint32_t expect = 0;
  bool ordered = true;
  while (ring.pop(out)) ordered = ordered && out.seq == expect++;
  CHECK(ordered && expect == 6);

  // Not-fresh read (polled between ODR ticks): no sample, no failure.
  m.neverFresh = true;
  m.clockUs += 10000;
  CHECK(!c.poll());
  CHECK(c.readFailures() == 0);
  CHECK(c.state() == apex::ImuState::Running);
  m.neverFresh = false;
}

static void testImuSensorTimeWrap() {
  std::printf("imu: 24-bit sensor time wrap\n");
  MockImu m;
  m.sensorTime = apex::kSensorTimeMask - 256 * 7;  // wraps during the comm test / first polls
  apex::ImuCore c;
  CHECK(c.begin(m));
  uint64_t prev = 0;
  bool first = true, monotonic = true;
  for (int i = 0; i < 10; i++) {
    m.clockUs += 10000;
    CHECK(c.poll());
    const uint64_t t = c.latest().sensorTimeUs;
    if (!first && t != prev + 10000) monotonic = false;
    prev = t;
    first = false;
  }
  CHECK(monotonic);
}

static void testImuFailure() {
  std::printf("imu: bus failure gives up after %d consecutive errors\n", apex::ImuCore::kMaxConsecutiveFailures);
  MockImu m;
  apex::ImuCore c;
  CHECK(c.begin(m));
  // 9 failures, one success, 9 failures: still running (counter resets).
  auto step = [&](int fails) {
    for (int i = 0; i < fails; i++) {
      m.failNext = 1;
      m.clockUs += 10000;
      c.poll();
    }
  };
  step(9);
  m.clockUs += 10000;
  CHECK(c.poll());
  step(9);
  CHECK(c.state() == apex::ImuState::Running);
  CHECK(c.readFailures() == 18);
  step(1);
  CHECK(c.state() == apex::ImuState::Failed);
  const int reads = m.reads;
  m.clockUs += 10000;
  CHECK(!c.poll());
  CHECK(m.reads == reads);  // failed IMU never touches the bus again
}

static void testImuRingOverflow() {
  std::printf("imu: ImuRing overwrites oldest and counts drops\n");
  apex::ImuRing<4> r;
  for (uint32_t i = 0; i < 7; i++) {
    apex::ImuSample s;
    s.seq = i;
    r.onImuSample(s);
  }
  CHECK(r.size() == 4);
  CHECK(r.dropped() == 3);
  apex::ImuSample s;
  CHECK(r.pop(s) && s.seq == 3);
  CHECK(r.pop(s) && s.seq == 4);
  CHECK(r.pop(s) && s.seq == 5);
  CHECK(r.pop(s) && s.seq == 6);
  CHECK(!r.pop(s));
}

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "firmware/test_host/fixtures";
  testLapTimeFormat();
  testFrameIdle();
  testFrameRacing();
  testFrameGeometry();
  testTimingView(dir);
  testImuInitStates();
  testImuSamples();
  testImuSensorTimeWrap();
  testImuFailure();
  testImuRingOverflow();
  std::printf("%s hw_test: %d checks, %d failed\n", g_failed ? "FAIL" : "PASS", g_checks, g_failed);
  return g_failed ? 1 : 0;
}
