#pragma once
// Apex Chrono V1.5 — BN-880Q GNSS driver (hardware UART1 + NMEA parsing).
//
// GNSS is the critical V1 timing dependency: this class only PRODUCES raw
// fixes. It never decides laps, sectors or crossings (that is
// apex::LapEngine's job, reached only through TimerService) and a fix is
// never re-timed off anything but the receiver's own time-of-fix.
//
// "Hardware timestamp", per Task 3:
//   - `GnssFix.t` / `ContractRow.timestampMs` — the AUTHORITATIVE clock. It
//     comes from the receiver's own UTC time-of-fix (NMEA hh:mm:ss.cc),
//     decoded on the ESP32's hardware UART1 peripheral. This is the only
//     clock the timing engine (or a replay of the recording) ever sees.
//   - `ContractRow.mcuMs` — a DIAGNOSTIC-ONLY hardware timestamp: the ESP32's
//     millis() hardware timer, captured at the exact instant this UART
//     decoded the fix. It measures receiver-to-MCU / logger latency and is
//     never read by the timing engine (contract §1).
//
// Fix quality: TinyGPSLocation::FixQuality() parses NMEA GGA field 6
// directly (0=invalid .. 8=simulated), so the raw contract row's
// `fix_quality` is the receiver's real value, not a hardcoded placeholder.
// The engine-facing `fixType` applies the contract §2 adapter rule exactly
// (fix_quality <= 0 -> 0 / no fix; >= 1 -> 3 — GGA cannot tell 2D from 3D).

#include <Arduino.h>
#include <TinyGPSPlus.h>

#include "GnssContractRow.h"
#include "apex_timing.h"

namespace apex {

class GnssDriver {
 public:
  // Configures the u-blox receiver for 10 Hz NMEA (GGA+RMC only) at
  // 115200-8N1 over HardwareSerial(1) on the given pins.
  void begin(int rxPin, int txPin);

  // Call every loop() iteration, typically in a `while (gnss.poll(...))`
  // loop to drain everything currently in the UART FIFO. Returns true and
  // fills both `row` (raw contract row, for SdLogger) and `fix` (adapted
  // engine input, for TimerService) when a new fix-complete NMEA update has
  // been decoded; false once the FIFO is empty for this call.
  bool poll(ContractRow& row, GnssFix& fix);

  bool dateValid() const { return gps_.date.isValid(); }
  // TinyGPSDate/Time accessors clear an internal "updated" flag as a side
  // effect, so they are non-const in the library — these mirror that.
  uint16_t year() { return gps_.date.year(); }
  uint8_t month() { return gps_.date.month(); }
  uint8_t day() { return gps_.date.day(); }
  uint8_t hour() { return gps_.time.hour(); }
  uint8_t minute() { return gps_.time.minute(); }

  uint32_t fixesSeen() const { return fixesSeen_; }

  // Raw UART health, valid with or without a satellite lock (the receiver
  // sends GGA/RMC with empty fields before it has a fix). Used by the 1 Hz
  // STAT line to tell "UART dead / wrong baud" from "no sky view yet".
  uint32_t nmeaChars() const { return gps_.charsProcessed(); }
  uint32_t nmeaSentencesOk() const { return gps_.passedChecksum(); }
  uint32_t nmeaChecksumErrors() const { return gps_.failedChecksum(); }

 private:
  void configureReceiver(int rxPin, int txPin);
  void ubxSend(uint8_t cls, uint8_t id, const uint8_t* payload, uint16_t len);
  double fixTimeS();

  HardwareSerial uart_{1};
  TinyGPSPlus gps_;
  double dayOffsetS_ = 0;
  double lastTodS_ = -1;
  uint32_t fixesSeen_ = 0;
};

}  // namespace apex
