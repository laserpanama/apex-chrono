#pragma once
// Apex Chrono V1.5 — the raw GNSS recording row, shared by GnssDriver
// (produces rows) and SdLogger (writes them to microSD).
//
// This mirrors src/lib/gnss/recording.ts `ContractRow` / `formatRow` from
// Task 2 (GNSS_DATA_CONTRACT.md §1/§6) field-for-field and byte-for-byte on
// the fixed write precision. It intentionally has NO Arduino dependency, so
// it stays portable (host-parity-testable later, like apex_timing.h) even
// though nothing requires that today.
//
// NAN = "not reported", matching the TS side's `null`.

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace apex {

struct ContractRow {
  int64_t timestampMs = 0;
  double lat = NAN, lon = NAN;
  double speedKmh = NAN;     // NAN = not reported
  double headingDeg = NAN;   // NAN = not reported
  int satellites = 0;
  double hdop = 99.9;
  int fixQuality = -1;       // -1 = not reported; else raw NMEA GGA quality 0-8
  double altitudeM = NAN;    // NAN = not reported
  int32_t mcuMs = -1;        // -1 = not reported; ESP32 millis() at parse time.
                              // Diagnostic only (contract §1) — NEVER a clock.
};

// UTC calendar date for naming a session file per contract §6
// (`APEX_YYYYMMDD_HHMM.CSV`). Carried separately from ContractRow because the
// contract's `timestamp_ms` is deliberately date-less (§3: "Absolute date is
// not part of the row; the recording file header carries it").
struct SessionDate {
  bool valid = false;
  uint16_t year = 0;
  uint8_t month = 0, day = 0, hour = 0, minute = 0;
};

constexpr const char* kRecordingHeader =
    "timestamp_ms,latitude,longitude,speed_kmh,heading_deg,satellites,hdop,fix_quality,altitude_m,mcu_ms";

// Fixed contract precision (recording.ts formatRow, byte-for-byte on
// non-tie values): timestamp_ms integer; lat/lon 8dp; speed_kmh 2dp;
// heading_deg 1dp; hdop 2dp; altitude_m 1dp; empty = not reported.
// Returns the formatted length (excluding the NUL), or a negative value on
// a snprintf encoding error. Never throws.
inline int formatContractRow(const ContractRow& r, char* buf, std::size_t bufSize) {
  char speed[16] = "", heading[16] = "", fixq[8] = "", alt[16] = "", mcu[16] = "";
  if (std::isfinite(r.speedKmh)) std::snprintf(speed, sizeof speed, "%.2f", r.speedKmh);
  if (std::isfinite(r.headingDeg)) std::snprintf(heading, sizeof heading, "%.1f", r.headingDeg);
  if (r.fixQuality >= 0) std::snprintf(fixq, sizeof fixq, "%d", r.fixQuality);
  if (std::isfinite(r.altitudeM)) std::snprintf(alt, sizeof alt, "%.1f", r.altitudeM);
  if (r.mcuMs >= 0) std::snprintf(mcu, sizeof mcu, "%ld", static_cast<long>(r.mcuMs));
  return std::snprintf(buf, bufSize, "%lld,%.8f,%.8f,%s,%s,%d,%.2f,%s,%s,%s",
                        static_cast<long long>(r.timestampMs), r.lat, r.lon, speed, heading, r.satellites,
                        r.hdop, fixq, alt, mcu);
}

}  // namespace apex
