// Apex Chrono V1.5 firmware — ESP32-S3-DevKitC-1 N32R16V hardware layer.
//
// Clean interface separation (full architecture, pin map and rationale in
// docs/V1_5_HARDWARE.md):
//   GnssDriver    firmware/lib/apex_gnss     BN-880Q UART1 -> contract rows + apex::GnssFix
//   SdLogger      firmware/lib/apex_storage  microSD, raw contract CSV (Task 2 format)
//   Display       firmware/lib/apex_display  ST7789 320x240 status panel (observer)
//   Imu           firmware/lib/apex_imu      BMI270 via Bosch Sensor API (observer, not used for timing)
//   TimerService  firmware/lib/apex_timer    Track + apex::LapEngine (apex_timing.h UNCHANGED/frozen)
//
// GNSS -> Timer is the only critical path. Storage, IMU and Display run
// strictly after the fixes available this iteration have been timed, and no
// return value of theirs can gate or delay timing: a dead SD card, a missing
// display or an absent IMU degrade to "feature off", never "timing off".
//
// Serial (UART0 / USB, 115200) output used by docs/V1_5_TEST_PROCEDURE.md:
//   APEX_CHRONO,V1.5,BOOT,...     once, peripheral bring-up result
//   IMU,...                       once, BMI270 init + communication test detail
//   EVT,...                       timing events (unchanged from V1)
//   STAT,...                      once per second, health snapshot

#include <Arduino.h>
#include <SPI.h>

#include "Display.h"
#include "DisplayModel.h"
#include "GnssContractRow.h"
#include "GnssDriver.h"
#include "Imu.h"
#include "SdLogger.h"
#include "TimerService.h"
#include "TimingView.h"
#include "apex_timing.h"
#include "pins.h"

static apex::GnssDriver gnss;
static apex::SdLogger sd;
static apex::Display display;
static apex::Imu imu;
static apex::TimerService timer;

static SPIClass sdSpi(FSPI);   // dedicated bus for microSD
static SPIClass tftSpi(HSPI);  // dedicated bus for the ST7789 — never shared with SD

static bool sdOk = false, displayOk = false, imuOk = false;

// GNSS state kept across loop() iterations (poll() locals only see this call's bytes).
static apex::GnssSnapshot gnssView;
static apex::SectorTracker sectors;  // current sector, mirrored from engine events
static uint32_t lastFixMs = 0;

static uint32_t lastDisplayMs = 0;
static uint32_t lastStatMs = 0;
static uint32_t fixesAtLastStat = 0;
static uint32_t imuSamplesAtLastStat = 0;
static int gnssHz = 0;
static int imuHz = 0;

static constexpr uint32_t kDisplayPeriodMs = 200;  // 5 Hz panel refresh
static constexpr uint32_t kStatPeriodMs = 1000;    // 1 Hz serial health line
static constexpr uint32_t kGnssStaleMs = static_cast<uint32_t>(apex::kLockStaleS * 1000);

static void logEvent(const apex::Event& e) {
  switch (e.type) {
    case apex::EventType::LapStart:
      Serial.printf("EVT,LAP_START,%.3f,%d\n", e.t, e.lap);
      break;
    case apex::EventType::Sector:
      Serial.printf("EVT,SECTOR,%.3f,%d,%d,%.3f\n", e.t, e.lap, e.index + 1, e.value);
      break;
    case apex::EventType::Lap: {
      const apex::LapRecord* r = timer.engine().lastLap();
      Serial.printf("EVT,LAP,%.3f,%d,%.3f,%s,max_kmh=%.1f\n", e.t, e.lap, e.value,
                    r && r->valid ? "valid" : "invalid", r ? r->maxSpeedMs * 3.6 : 0.0);
      break;
    }
    case apex::EventType::RejectedOrder:
      Serial.printf("EVT,REJECT_ORDER,%.3f,gate=%d\n", e.t, e.index);
      break;
    case apex::EventType::RejectedShortLap:
      Serial.printf("EVT,REJECT_SHORT,%.3f,%.3f\n", e.t, e.value);
      break;
    case apex::EventType::IgnoredBeforeStart:
      Serial.printf("EVT,IGNORED,%.3f,gate=%d\n", e.t, e.index);
      break;
  }
}

static apex::SdStatus sdStatus() {
  if (!sd.cardPresent()) return apex::SdStatus::NoCard;
  if (sd.gaveUp()) return apex::SdStatus::Failed;
  return sd.fileOpen() ? apex::SdStatus::Logging : apex::SdStatus::Ready;
}

static apex::ImuStatus imuStatus() {
  switch (imu.state()) {
    case apex::ImuState::Running: return apex::ImuStatus::Running;
    case apex::ImuState::Failed: return apex::ImuStatus::Failed;
    default: return apex::ImuStatus::Off;
  }
}

static const char* timingName(apex::TimingStatus t) {
  switch (t) {
    case apex::TimingStatus::NoTrack: return "no_track";
    case apex::TimingStatus::NoFix: return "no_fix";
    case apex::TimingStatus::WaitStart: return "wait_start";
    case apex::TimingStatus::InLap: return "in_lap";
  }
  return "?";
}

static const char* sdName(apex::SdStatus s) {
  switch (s) {
    case apex::SdStatus::NoCard: return "no_card";
    case apex::SdStatus::Ready: return "ready";
    case apex::SdStatus::Logging: return "logging";
    case apex::SdStatus::Failed: return "failed";
  }
  return "?";
}

static void printImuBoot() {
  const apex::ImuCore& c = imu.core();
  const apex::ImuCommTest& t = c.commTest();
  Serial.printf(
      "IMU,state=%s,addr=0x%02X,chip=0x%02X,bosch=%d,comm_reads=%d,fresh_acc=%d,fresh_gyr=%d,time_adv=%d,"
      "not_stuck=%d,mag_g=%.3f,gravity_ok=%d,acc_range_g=%d,gyr_range_dps=%d,odr_hz=%d\n",
      apex::imuStateName(c.state()), imu.address(), c.chipId(), imu.lastBoschResult(), t.reads, t.freshAcc,
      t.freshGyr, t.timeAdvanced, t.notStuck, t.accelMagG, t.gravityPlausible, c.config().accelRangeG,
      c.config().gyroRangeDps, c.config().odrHz);
}

void setup() {
  Serial.begin(115200);

  // GNSS is the critical V1 dependency — bring it up first and
  // unconditionally. Everything below it may fail without consequence.
  gnss.begin(apex::pins::GNSS_RX, apex::pins::GNSS_TX);

  sdOk = sd.begin(apex::pins::SD_CS, sdSpi, apex::pins::SD_SCLK, apex::pins::SD_MISO, apex::pins::SD_MOSI);
  displayOk = display.begin(apex::pins::TFT_CS, apex::pins::TFT_DC, apex::pins::TFT_RST, apex::pins::TFT_BL,
                            tftSpi, apex::pins::TFT_SCLK, apex::pins::TFT_MOSI);
  imuOk = imu.begin(apex::pins::IMU_SDA, apex::pins::IMU_SCL);
  // Future IMU logging plugs in here: imu.setSink(&someLogger) — see ImuSink in ImuCore.h.

  Serial.printf("APEX_CHRONO,V1.5,BOOT,sd=%d,display=%d,imu=%d\n", sdOk, displayOk, imuOk);
  printImuBoot();
  Serial.println("APEX_CHRONO,V1.5,GNSS_READY,send track then END");
}

void loop() {
  if (!timer.trackReady() && Serial.available()) timer.loadTrackFrom(Serial);

  // ── Critical path: drain GNSS, log, time. ──
  apex::ContractRow row;
  apex::GnssFix fix;
  while (gnss.poll(row, fix)) {
    gnssView.haveFix = true;
    gnssView.last = fix;
    lastFixMs = millis();

    // Storage is an observer: its outcome never gates the timing push below.
    apex::SessionDate date;
    date.valid = gnss.dateValid();
    if (date.valid) {
      date.year = gnss.year();
      date.month = gnss.month();
      date.day = gnss.day();
      date.hour = gnss.hour();
      date.minute = gnss.minute();
    }
    sd.logRow(row, date);

    if (timer.trackReady()) {
      apex::Event ev[apex::MAX_EVENTS];
      const int n = timer.pushFix(fix, ev);
      for (int i = 0; i < n; i++) {
        sectors.onEvent(ev[i], timer.engine());
        logEvent(ev[i]);
      }
    }
  }

  const uint32_t now = millis();
  gnssView.stale = !gnssView.haveFix || now - lastFixMs > kGnssStaleMs;

  // ── Observers. Each is bounded in time and ignored by timing. ──
  // IMU: Running only after init + communication test passed; Failed after
  // repeated read errors. poll() is a no-op otherwise.
  imu.poll();

  if (displayOk && now - lastDisplayMs >= kDisplayPeriodMs) {
    lastDisplayMs = now;
    apex::DisplayStatus st;
    apex::fillTiming(timer.engine(), sectors, timer.trackReady(), gnssView, st);
    st.sd = sdStatus();
    st.sdRows = sd.rowsLogged();
    st.sdFailures = sd.failures();
    st.imu = imuStatus();
    st.imuHz = imuHz;
    display.show(st);
  }

  if (now - lastStatMs >= kStatPeriodMs) {
    const uint32_t dt = lastStatMs ? now - lastStatMs : kStatPeriodMs;
    lastStatMs = now;
    const uint32_t fixes = gnss.fixesSeen();
    const uint32_t imuSamples = imu.core().samples();
    gnssHz = static_cast<int>((fixes - fixesAtLastStat) * 1000UL / dt);
    imuHz = static_cast<int>((imuSamples - imuSamplesAtLastStat) * 1000UL / dt);
    fixesAtLastStat = fixes;
    imuSamplesAtLastStat = imuSamples;

    apex::DisplayStatus st;
    apex::fillTiming(timer.engine(), sectors, timer.trackReady(), gnssView, st);
    const apex::ImuSample& s = imu.core().latest();
    Serial.printf(
        "STAT,ms=%lu,fixes=%lu,gnss_hz=%d,lock=%d,sats=%d,hdop=%.2f,timing=%s,lap=%d,sector=%d/%d,"
        "sd=%s,rows=%lu,sd_fail=%lu,imu=%s,imu_hz=%d,imu_fail=%lu,ax=%.2f,ay=%.2f,az=%.2f,gx=%.2f,gy=%.2f,gz=%.2f,"
        "disp_us=%lu,disp_max_us=%lu\n",
        static_cast<unsigned long>(now), static_cast<unsigned long>(fixes), gnssHz, st.gnssLock, st.sats,
        std::isfinite(st.hdop) ? st.hdop : 99.9, timingName(st.timing), st.lapNumber, st.sector, st.sectorCount,
        sdName(sdStatus()), static_cast<unsigned long>(sd.rowsLogged()), static_cast<unsigned long>(sd.failures()),
        apex::imuStateName(imu.state()), imuHz, static_cast<unsigned long>(imu.core().readFailures()), s.ax, s.ay,
        s.az, s.gx, s.gy, s.gz, static_cast<unsigned long>(display.lastRenderUs()),
        static_cast<unsigned long>(display.maxRenderUs()));
  }
}
