// Apex Chrono V1.5 firmware — ESP32-S3-DevKitC-1 N32R16V hardware layer.
//
// Clean interface separation (full architecture, pin map and rationale in
// docs/V1_5_HARDWARE.md):
//   GnssDriver    firmware/lib/apex_gnss     BN-880Q UART1 -> contract rows + apex::GnssFix
//   SdLogger      firmware/lib/apex_storage  microSD, raw contract CSV (Task 2 format)
//   Display       firmware/lib/apex_display  ST7789 status panel (read-only observer)
//   Imu           firmware/lib/apex_imu      BMI270 wiring check (see its class note)
//   TimerService  firmware/lib/apex_timer    Track + apex::LapEngine (apex_timing.h UNCHANGED/frozen)
//
// GNSS -> Timer is the only critical path. Storage, Display and IMU are all
// called strictly AFTER a fix has already been timed, and none of their
// return values can gate or delay the next GNSS poll or any future timing
// call: a dead SD card, a missing display or an absent IMU degrade to
// "feature off", never to "timing off".

#include <Arduino.h>
#include <SPI.h>

#include "Display.h"
#include "GnssContractRow.h"
#include "GnssDriver.h"
#include "Imu.h"
#include "SdLogger.h"
#include "TimerService.h"
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
static uint32_t lastDisplayMs = 0;
static uint32_t lastImuMs = 0;

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

void setup() {
  Serial.begin(115200);

  // GNSS is the critical V1 dependency — bring it up first and
  // unconditionally. Everything below it may fail without consequence.
  gnss.begin(apex::pins::GNSS_RX, apex::pins::GNSS_TX);

  sdOk = sd.begin(apex::pins::SD_CS, sdSpi, apex::pins::SD_SCLK, apex::pins::SD_MISO, apex::pins::SD_MOSI);
  displayOk = display.begin(apex::pins::TFT_CS, apex::pins::TFT_DC, apex::pins::TFT_RST, apex::pins::TFT_BL,
                            tftSpi, apex::pins::TFT_SCLK, apex::pins::TFT_MOSI);
  imuOk = imu.begin(apex::pins::IMU_SDA, apex::pins::IMU_SCL);

  Serial.printf("APEX_CHRONO,V1.5,BOOT,sd=%d,display=%d,imu=%d\n", sdOk, displayOk, imuOk);
  Serial.println("APEX_CHRONO,V1.5,GNSS_READY,send track then END");
}

void loop() {
  if (!timer.trackReady() && Serial.available()) timer.loadTrackFrom(Serial);

  // Last known fix, kept across loop() iterations for the display block
  // below (the `fix`/`row` locals here only reflect bytes decoded THIS
  // call, so they must never be read once the poll loop below returns
  // false for this iteration).
  static bool haveFix = false;
  static apex::GnssFix lastFix{};

  apex::ContractRow row;
  apex::GnssFix fix;
  while (gnss.poll(row, fix)) {
    haveFix = true;
    lastFix = fix;

    // Storage is an observer: it runs AFTER the row already exists, and its
    // outcome never gates or delays the timing push below (SD failure must
    // not stop timing).
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
      for (int i = 0; i < n; i++) logEvent(ev[i]);
    }
  }

  const uint32_t now = millis();

  // IMU: best-effort, ~20 Hz, independent of GNSS cadence. A failed read
  // (or begin() never having succeeded) just skips this block — see Imu.h
  // for why the data isn't characterized/used for anything yet.
  if (imuOk && now - lastImuMs >= 50) {
    lastImuMs = now;
    apex::ImuSample s;
    imu.readRaw(s);  // diagnostic only, intentionally unused beyond bring-up
  }

  // Display: throttled refresh. Plenty for a text status panel and far
  // below the SPI bus's capacity, so it can never starve GNSS/timer work.
  if (displayOk && now - lastDisplayMs >= 200) {
    lastDisplayMs = now;
    apex::DisplayStatus st;
    st.gnssFix = haveFix && lastFix.fixType >= 2;
    st.sats = haveFix ? lastFix.sats : 0;
    st.hdop = haveFix ? lastFix.hdop : 99.9;
    st.trackReady = timer.trackReady();

    const apex::LapEngine& eng = timer.engine();
    st.inLap = eng.inLapNow();
    st.lapNumber = eng.currentLapNumber();
    if (st.inLap && haveFix) st.lapElapsedS = lastFix.t - eng.lapStartTime();

    const apex::LapRecord* last = eng.lastLap();
    st.haveLastLap = last != nullptr;
    if (last) {
      st.lastLapS = last->timeS;
      st.lastLapValid = last->valid;
    }
    st.haveBestLap = eng.haveBest;
    if (eng.haveBest) st.bestLapS = eng.bestLap.timeS;

    st.sdCardPresent = sd.cardPresent();
    st.sdRowsLogged = sd.rowsLogged();
    st.sdFailures = sd.failures();
    st.imuOk = imu.ok();

    display.showStatus(st);
  }
}
