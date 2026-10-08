#include "Display.h"

#include <cmath>

namespace apex {

namespace {
// Common "2-inch" ST7789 breakout resolution. If your specific panel differs
// (e.g. a 240x240 square 1.3"/1.54" module sold alongside "2-inch" ones),
// change these two constants — there is no reliable way to auto-detect panel
// size over a write-only SPI link without a MISO/ID-read wire.
constexpr uint16_t kWidth = 240;
constexpr uint16_t kHeight = 320;
constexpr uint16_t kBg = 0x0000;   // black
constexpr uint16_t kFg = 0xFFFF;   // white
constexpr uint16_t kOk = 0x07E0;   // green
constexpr uint16_t kBad = 0xF800;  // red
}  // namespace

bool Display::begin(int csPin, int dcPin, int rstPin, int blPin, SPIClass& spi, int sckPin, int mosiPin) {
  blPin_ = blPin;
  spi.begin(sckPin, -1 /* no MISO: write-only display */, mosiPin, csPin);
  tft_ = new Adafruit_ST7789(&spi, csPin, dcPin, rstPin);
  tft_->init(kWidth, kHeight);
  tft_->setRotation(0);
  tft_->fillScreen(kBg);
  if (blPin_ >= 0) {
    pinMode(blPin_, OUTPUT);
    digitalWrite(blPin_, HIGH);
  }
  // See the class-level note in Display.h: a write-only SPI panel cannot be
  // reliably probed for presence. We optimistically report success once
  // init() returns; a dead/missing panel is simply invisible, never a fault
  // that propagates anywhere else in the firmware.
  ok_ = true;
  return ok_;
}

void Display::showStatus(const DisplayStatus& s) {
  if (!ok_ || !tft_) return;
  tft_->fillScreen(kBg);
  tft_->setTextSize(2);
  tft_->setCursor(4, 4);

  tft_->setTextColor(s.gnssFix ? kOk : kBad);
  tft_->printf("GNSS %s\n", s.gnssFix ? "OK" : "NO FIX");
  tft_->setTextColor(kFg);
  tft_->printf("sat %d hdop %.1f\n\n", s.sats, s.hdop);

  if (!s.trackReady) {
    tft_->setTextColor(kBad);
    tft_->println("NO TRACK");
  } else {
    tft_->setTextColor(kFg);
    tft_->printf("Lap %d %s\n", s.lapNumber, s.inLap ? "" : "(out)");
    if (s.inLap && std::isfinite(s.lapElapsedS)) tft_->printf("%.1fs\n", s.lapElapsedS);
    tft_->println();
    if (s.haveLastLap) {
      tft_->setTextColor(s.lastLapValid ? kFg : kBad);
      tft_->printf("Last %.3f\n", s.lastLapS);
    }
    if (s.haveBestLap) {
      tft_->setTextColor(kOk);
      tft_->printf("Best %.3f\n", s.bestLapS);
    }
  }

  tft_->setTextColor(kFg);
  tft_->println();
  tft_->setTextColor(s.sdCardPresent ? kOk : kBad);
  tft_->printf("SD %s", s.sdCardPresent ? "ok" : "--");
  if (s.sdFailures) tft_->printf(" f%lu", static_cast<unsigned long>(s.sdFailures));
  tft_->println();
  tft_->setTextColor(s.imuOk ? kOk : kFg);
  tft_->printf("IMU %s\n", s.imuOk ? "ok" : "--");
}

}  // namespace apex
