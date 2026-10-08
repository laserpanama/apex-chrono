#pragma once
// Apex Chrono V1.5 — the "Timer" interface boundary.
//
// Orchestrates apex::Track + apex::LapEngine. GNSS, Storage, Display and IMU
// never touch LapEngine directly — they only go through this class.
// apex_timing.h itself is UNCHANGED (frozen, host-parity-tested by
// firmware/test_host/parity.cpp): this is pure wiring, no timing decision
// logic lives here.

#include <Arduino.h>

#include "apex_timing.h"

namespace apex {

class TimerService {
 public:
  // Parses the same text track format as firmware/test_host fixtures
  // (`origin`, `centerline N` + N "lat lon" lines, `gates G` + G
  // "SF|SEC leftLat leftLon rightLat rightLon" lines, terminated by a line
  // "END"). `in` can be Serial (bring-up) or any other Stream — a File
  // works unchanged, for when SD-stored tracks land (V1_5_ARCHITECTURE.md
  // B7).
  bool loadTrackFrom(Stream& in);

  bool trackReady() const { return trackReady_; }

  // No-op (returns 0) until a track is loaded: fixes before that are simply
  // not timed, never queued or retried once a track does load.
  int pushFix(const GnssFix& fix, Event* events);
  int flush(Event* events);

  const LapEngine& engine() const { return engine_; }

 private:
  Track track_;
  LapEngine engine_;
  bool trackReady_ = false;
};

}  // namespace apex
