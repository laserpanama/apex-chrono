#pragma once
// Apex Chrono V1.5 — what the ST7789 shows, as plain data.
//
// Pure C++17, no Arduino / GFX dependency: `buildFrame()` turns a status
// snapshot into eight fixed text lines (text + size + y + tone). Display.cpp
// only paints those lines; the host test (firmware/test_host/hw_test.cpp)
// checks the exact text without a panel. Keeping layout here means the
// "what" is tested and the "how" stays a thin, dumb renderer.
//
// Layout, landscape 320x240 (Adafruit GFX classic font: 6x8 px per char at
// size 1, so size 2 = 12x16, size 3 = 18x24, size 5 = 30x40):
//
//   y   size  content                         field(s) required by Task 4
//   4   2     FIX  SAT 12 HDOP 0.8            GNSS lock, satellites, HDOP
//   26  2     TIMING                          timing status
//   52  5     1:23.4                          lap time (current, live)
//   100 3     LAP 4        S2/3               current lap, sector
//   130 3     LAST 1:23.456                   last lap
//   162 2     BEST 1:22.901                   (best lap, extra)
//   190 2     SD LOG 1234                     SD status
//   214 2     IMU OK 100HZ                    (IMU status, extra)

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace apex {

enum class TimingStatus : uint8_t {
  NoTrack,    // no track loaded yet: fixes are not timed at all
  NoFix,      // track loaded, GNSS not locked (or no fix for > 2 s)
  WaitStart,  // locked, waiting for the first start/finish crossing
  InLap,      // a lap is running
};

enum class SdStatus : uint8_t {
  NoCard,   // SD.begin() failed at boot (no card / no wiring)
  Ready,    // card mounted, session file not opened yet (waiting for first fix)
  Logging,  // writing rows
  Failed,   // gave up after repeated write failures this session
};

enum class ImuStatus : uint8_t {
  Off,      // not detected / init or communication test failed at boot
  Running,  // producing samples
  Failed,   // came up, then stopped answering during the session
};

struct DisplayStatus {
  bool gnssLock = false;
  int sats = 0;
  double hdop = NAN;

  TimingStatus timing = TimingStatus::NoTrack;
  int lapNumber = 0;          // 0 = no lap started yet
  double lapElapsedS = NAN;   // live, only meaningful while InLap
  int sector = 0;             // 1-based current sector, 0 = n/a
  int sectorCount = 0;        // sectors per lap (1 = start/finish only)

  bool haveLastLap = false;
  double lastLapS = NAN;
  bool lastLapValid = false;
  bool haveBestLap = false;
  double bestLapS = NAN;

  SdStatus sd = SdStatus::NoCard;
  uint32_t sdRows = 0;
  uint32_t sdFailures = 0;

  ImuStatus imu = ImuStatus::Off;
  int imuHz = 0;
};

enum class Tone : uint8_t { Normal, Good, Bad, Dim };

struct DisplayLine {
  char text[28];  // longest line is size 2 = 26 columns on 320 px
  uint8_t size;
  uint16_t y;
  Tone tone;
};

constexpr int kDisplayLineCount = 8;
constexpr int kDisplayWidthPx = 320;
constexpr int kDisplayHeightPx = 240;
constexpr int kDisplayMarginPx = 4;

struct DisplayFrame {
  DisplayLine line[kDisplayLineCount];
};

// Columns that fit on one line at a given text size (classic 6 px font).
constexpr int displayColumns(uint8_t size) { return (kDisplayWidthPx - kDisplayMarginPx) / (6 * size); }

// Clamp for display: keeps every field a bounded width (and lets the
// compiler prove the snprintf calls below never truncate).
inline unsigned clampU(long long v, unsigned hi) { return v < 0 ? 0u : (v > static_cast<long long>(hi) ? hi : static_cast<unsigned>(v)); }

// "M:SS.d" / "M:SS.ddd". Rounds once on the total, so 59.9996 -> "1:00.000",
// never "0:60.000". Non-finite or negative -> dashes of the same shape.
inline void formatLapTime(double s, int decimals, char* out, size_t n) {
  if (!std::isfinite(s) || s < 0) {
    std::snprintf(out, n, decimals == 3 ? "-:--.---" : "-:--.-");
    return;
  }
  const long long scale = decimals == 3 ? 1000 : 10;
  long long units = std::llround(s * static_cast<double>(scale));
  const long long maxUnits = (99LL * 60 + 59) * scale + (scale - 1);  // clamp at 99:59.9(99)
  if (units > maxUnits) units = maxUnits;
  const unsigned frac = clampU(units % scale, 999);
  const long long whole = units / scale;
  const unsigned minutes = clampU(whole / 60, 99);
  const unsigned seconds = clampU(whole % 60, 59);
  if (decimals == 3) {
    std::snprintf(out, n, "%u:%02u.%03u", minutes, seconds, frac);
  } else {
    std::snprintf(out, n, "%u:%02u.%u", minutes, seconds, clampU(frac, 9));
  }
}

namespace detail {
inline void setLine(DisplayLine& l, uint8_t size, uint16_t y, Tone tone) {
  l.size = size;
  l.y = y;
  l.tone = tone;
}
}  // namespace detail

inline void buildFrame(const DisplayStatus& s, DisplayFrame& f) {
  using detail::setLine;
  char a[16];

  // 0 — GNSS lock, satellites, HDOP
  {
    DisplayLine& l = f.line[0];
    char hd[8];
    if (std::isfinite(s.hdop) && s.hdop < 99) std::snprintf(hd, sizeof hd, "%.1f", s.hdop);
    else std::snprintf(hd, sizeof hd, "--");
    std::snprintf(l.text, sizeof l.text, "%-6s SAT %2u HDOP %s", s.gnssLock ? "FIX" : "NO FIX", clampU(s.sats, 99), hd);
    setLine(l, 2, 4, s.gnssLock ? Tone::Good : Tone::Bad);
  }

  // 1 — timing status
  {
    DisplayLine& l = f.line[1];
    switch (s.timing) {
      case TimingStatus::NoTrack:
        std::snprintf(l.text, sizeof l.text, "NO TRACK LOADED");
        setLine(l, 2, 26, Tone::Bad);
        break;
      case TimingStatus::NoFix:
        std::snprintf(l.text, sizeof l.text, "WAITING GNSS LOCK");
        setLine(l, 2, 26, Tone::Bad);
        break;
      case TimingStatus::WaitStart:
        std::snprintf(l.text, sizeof l.text, "READY - CROSS START");
        setLine(l, 2, 26, Tone::Normal);
        break;
      case TimingStatus::InLap:
        std::snprintf(l.text, sizeof l.text, "TIMING");
        setLine(l, 2, 26, Tone::Good);
        break;
    }
  }

  // 2 — live lap time (big)
  {
    DisplayLine& l = f.line[2];
    const bool live = s.timing == TimingStatus::InLap;
    formatLapTime(live ? s.lapElapsedS : NAN, 1, l.text, sizeof l.text);
    setLine(l, 5, 52, live ? Tone::Normal : Tone::Dim);
  }

  // 3 — current lap + sector
  {
    DisplayLine& l = f.line[3];
    if (s.lapNumber > 0) std::snprintf(a, sizeof a, "LAP %u", clampU(s.lapNumber, 999));
    else std::snprintf(a, sizeof a, "LAP -");
    if (s.sectorCount > 1 && s.timing == TimingStatus::InLap && s.sector > 0) {
      char sec[12];
      std::snprintf(sec, sizeof sec, "S%u/%u", clampU(s.sector, 99), clampU(s.sectorCount, 99));
      // right-align the sector inside the 17-column size-3 line
      const int cols = displayColumns(3);
      const int pad = cols - static_cast<int>(std::strlen(a)) - static_cast<int>(std::strlen(sec));
      std::snprintf(l.text, sizeof l.text, "%s%*s%s", a, pad > 1 ? pad : 1, "", sec);
    } else {
      std::snprintf(l.text, sizeof l.text, "%s", a);
    }
    setLine(l, 3, 100, Tone::Normal);
  }

  // 4 — last lap (invalid laps flagged, still shown)
  {
    DisplayLine& l = f.line[4];
    if (s.haveLastLap) {
      formatLapTime(s.lastLapS, 3, a, sizeof a);
      std::snprintf(l.text, sizeof l.text, "LAST %s%s", a, s.lastLapValid ? "" : " X");
      setLine(l, 3, 130, s.lastLapValid ? Tone::Normal : Tone::Bad);
    } else {
      std::snprintf(l.text, sizeof l.text, "LAST --");
      setLine(l, 3, 130, Tone::Dim);
    }
  }

  // 5 — best lap
  {
    DisplayLine& l = f.line[5];
    if (s.haveBestLap) {
      formatLapTime(s.bestLapS, 3, a, sizeof a);
      std::snprintf(l.text, sizeof l.text, "BEST %s", a);
      setLine(l, 2, 162, Tone::Good);
    } else {
      std::snprintf(l.text, sizeof l.text, "BEST --");
      setLine(l, 2, 162, Tone::Dim);
    }
  }

  // 6 — SD status
  {
    DisplayLine& l = f.line[6];
    switch (s.sd) {
      case SdStatus::NoCard:
        std::snprintf(l.text, sizeof l.text, "SD NO CARD");
        setLine(l, 2, 190, Tone::Bad);
        break;
      case SdStatus::Ready:
        std::snprintf(l.text, sizeof l.text, "SD READY");
        setLine(l, 2, 190, Tone::Normal);
        break;
      case SdStatus::Logging:
        if (s.sdFailures) {
          std::snprintf(l.text, sizeof l.text, "SD LOG %u ERR %u", clampU(s.sdRows, 999999), clampU(s.sdFailures, 9999));
          setLine(l, 2, 190, Tone::Bad);
        } else {
          std::snprintf(l.text, sizeof l.text, "SD LOG %u", clampU(s.sdRows, 999999));
          setLine(l, 2, 190, Tone::Good);
        }
        break;
      case SdStatus::Failed:
        std::snprintf(l.text, sizeof l.text, "SD FAILED");
        setLine(l, 2, 190, Tone::Bad);
        break;
    }
  }

  // 7 — IMU status
  {
    DisplayLine& l = f.line[7];
    switch (s.imu) {
      case ImuStatus::Off:
        std::snprintf(l.text, sizeof l.text, "IMU --");
        setLine(l, 2, 214, Tone::Dim);
        break;
      case ImuStatus::Running:
        std::snprintf(l.text, sizeof l.text, "IMU OK %uHZ", clampU(s.imuHz, 9999));
        setLine(l, 2, 214, Tone::Good);
        break;
      case ImuStatus::Failed:
        std::snprintf(l.text, sizeof l.text, "IMU FAILED");
        setLine(l, 2, 214, Tone::Bad);
        break;
    }
  }
}

}  // namespace apex
