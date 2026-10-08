#include "Display.h"

#include <cstring>
#include <new>

namespace apex {

namespace {
// The panel is initialised in its native portrait 240x320, then rotated to
// landscape 320x240. If the module is a 240x240 or 170x320 variant, change
// these and the layout in DisplayModel.h — a write-only SPI link cannot
// detect the panel size.
constexpr uint16_t kNativeW = 240;
constexpr uint16_t kNativeH = 320;
constexpr uint8_t kRotation = 1;          // 1 = landscape, connector on the left; 3 flips it
constexpr uint32_t kSpiHz = 40000000;     // drop to 27 MHz if the panel shows noise on long wires

uint16_t toneColor(Tone t) {
  switch (t) {
    case Tone::Good: return ST77XX_GREEN;
    case Tone::Bad: return ST77XX_RED;
    case Tone::Dim: return 0x7BEF;  // mid grey
    case Tone::Normal: break;
  }
  return ST77XX_WHITE;
}
}  // namespace

bool Display::begin(int csPin, int dcPin, int rstPin, int blPin, SPIClass& spi, int sckPin, int mosiPin) {
  spi.begin(sckPin, -1 /* no MISO: write-only panel */, mosiPin, csPin);
  tft_ = new (std::nothrow) Adafruit_ST7789(&spi, csPin, dcPin, rstPin);
  if (!tft_) return ok_ = false;
  tft_->init(kNativeW, kNativeH);
  tft_->setSPISpeed(kSpiHz);
  tft_->setRotation(kRotation);
  tft_->setTextWrap(false);
  tft_->fillScreen(ST77XX_BLACK);  // the only full clear; every later frame is partial
  if (blPin >= 0) {
    pinMode(blPin, OUTPUT);
    digitalWrite(blPin, HIGH);
  }
  havePrev_ = false;
  ok_ = true;
  return ok_;
}

void Display::paint(const DisplayLine& l) {
  // Text drawn with an explicit background overwrites the old glyphs; padding
  // to the full line width erases whatever was longer last time.
  char padded[sizeof(l.text)];
  const int cols = displayColumns(l.size);
  std::snprintf(padded, sizeof padded, "%-*s", cols, l.text);
  tft_->setTextSize(l.size);
  tft_->setTextColor(toneColor(l.tone), ST77XX_BLACK);
  tft_->setCursor(kDisplayMarginPx, l.y);
  tft_->print(padded);
}

uint32_t Display::show(const DisplayStatus& s) {
  if (!ok_ || !tft_) return 0;
  const uint32_t t0 = micros();
  DisplayFrame f;
  buildFrame(s, f);
  for (int i = 0; i < kDisplayLineCount; i++) {
    const DisplayLine& l = f.line[i];
    if (havePrev_ && l.tone == prev_.line[i].tone && std::strcmp(l.text, prev_.line[i].text) == 0) continue;
    paint(l);
  }
  prev_ = f;
  havePrev_ = true;
  lastRenderUs_ = micros() - t0;
  if (lastRenderUs_ > maxRenderUs_) maxRenderUs_ = lastRenderUs_;
  return lastRenderUs_;
}

}  // namespace apex
