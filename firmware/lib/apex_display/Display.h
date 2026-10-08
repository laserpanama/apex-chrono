#pragma once
// Apex Chrono V1.5 — minimal ST7789 status panel.
//
// Plain text only: GNSS fix state, lap count/elapsed, last + best lap,
// storage/IMU status. This is explicitly NOT a V2 telemetry dashboard — no
// graphics, no track map, no g-force gauges.
//
// A missing/unresponsive panel can never stop timing. The ST7789 is a
// write-only SPI display on this wiring (no MISO/readback path, which is
// normal for these breakouts), so there is no reliable way to prove the chip
// is actually present and responding before writing to it — see
// docs/V1_5_HARDWARE.md for the honest limitation. The guarantee this class
// DOES provide is architectural: it is a pure, stateless observer called
// strictly after timing has already happened, so even a fully dead/missing
// panel degrades to "no display", never to "no timing".

#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Arduino.h>
#include <SPI.h>

namespace apex {

struct DisplayStatus {
  bool gnssFix = false;
  int sats = 0;
  double hdop = 99.9;
  bool trackReady = false;
  bool inLap = false;
  int lapNumber = 0;
  double lapElapsedS = NAN;
  bool haveLastLap = false;
  double lastLapS = NAN;
  bool lastLapValid = false;
  bool haveBestLap = false;
  double bestLapS = NAN;
  bool sdCardPresent = false;
  uint32_t sdRowsLogged = 0;
  uint32_t sdFailures = 0;
  bool imuOk = false;
};

class Display {
 public:
  bool begin(int csPin, int dcPin, int rstPin, int blPin, SPIClass& spi, int sckPin, int mosiPin);
  void showStatus(const DisplayStatus& s);
  bool ok() const { return ok_; }

 private:
  Adafruit_ST7789* tft_ = nullptr;
  bool ok_ = false;
  int blPin_ = -1;
};

}  // namespace apex
