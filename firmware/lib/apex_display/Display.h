#pragma once
// Apex Chrono V1.5 — ST7789 2" status panel, landscape 320x240.
//
// What is shown is decided in DisplayModel.h (pure, host-tested). This class
// only paints the eight lines, and only the ones whose text or colour
// changed since the last frame. Partial redraws keep each refresh to a few
// milliseconds of SPI (a full 320x240 clear is ~150 KB), so the main loop
// keeps draining the GNSS UART.
//
// A missing or dead panel can never stop timing. The ST7789 wiring is
// write-only (no MISO), so there is no electrical presence check; the
// guarantee is architectural: Display is called after timing work, writes
// a bounded number of bytes, and nothing reads its result. See
// docs/V1_5_HARDWARE.md.

#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Arduino.h>
#include <SPI.h>

#include "DisplayModel.h"

namespace apex {

class Display {
 public:
  bool begin(int csPin, int dcPin, int rstPin, int blPin, SPIClass& spi, int sckPin, int mosiPin);
  // Paints the changed lines. Returns the time spent, in microseconds.
  uint32_t show(const DisplayStatus& s);
  bool ok() const { return ok_; }
  uint32_t lastRenderUs() const { return lastRenderUs_; }
  uint32_t maxRenderUs() const { return maxRenderUs_; }

 private:
  void paint(const DisplayLine& l);

  Adafruit_ST7789* tft_ = nullptr;
  bool ok_ = false;
  bool havePrev_ = false;
  DisplayFrame prev_{};
  uint32_t lastRenderUs_ = 0;
  uint32_t maxRenderUs_ = 0;
};

}  // namespace apex
