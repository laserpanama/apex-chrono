#pragma once
// Apex Chrono V1.5 — read-only view of the lap engine for the display.
//
// Pure C++17 over apex_timing.h's existing public members (no engine change):
// fills the timing half of a DisplayStatus. Host-tested by replaying the
// parity fixtures through the real LapEngine (firmware/test_host/hw_test.cpp).

#include <cmath>

#include "DisplayModel.h"
#include "apex_timing.h"

namespace apex {

// A fix older than this (in GNSS seconds, against the newest fix seen) or a
// receiver that stopped sending entirely counts as "no lock" on screen.
constexpr double kLockStaleS = 2.0;

struct GnssSnapshot {
  bool haveFix = false;     // at least one fix decoded this session
  GnssFix last{};           // newest fix (GNSS clock)
  bool stale = false;       // no new fix for > kLockStaleS of MCU time
};

inline bool gnssLocked(const GnssSnapshot& g) { return g.haveFix && !g.stale && g.last.fixType >= 2; }

// Current sector while a lap runs, derived from the engine's own events.
// LapEngine keeps its expected-next-gate private, and apex_timing.h is
// frozen, so this mirrors it exactly from the event stream: LapStart sets
// it to gate 1 (or 0 with no sector lines), Sector for gate g sets it to
// (g + 1) % nGates. Gate 0 is start/finish, gates 1..nG-1 are sector lines,
// so a track with nG gates has nG sectors (1 with no sector lines).
struct SectorTracker {
  int nextGate = 0;

  void reset() { nextGate = 0; }

  void onEvent(const Event& ev, const LapEngine& e) {
    if (!e.track) return;
    const int nG = e.track->nGates;
    if (ev.type == EventType::LapStart) nextGate = nG > 1 ? 1 : 0;
    else if (ev.type == EventType::Sector && nG > 0) nextGate = (ev.index + 2) % nG;  // index = gate - 1
  }

  int current(const LapEngine& e) const {
    if (!e.track || !e.inLapNow()) return 0;
    const int nG = e.track->nGates;
    if (nG <= 1) return 1;
    return nextGate == 0 ? nG : nextGate;
  }
};

inline int sectorCount(const LapEngine& e) {
  if (!e.track) return 0;
  return e.track->nGates <= 1 ? 1 : e.track->nGates;
}

inline void fillTiming(const LapEngine& e, const SectorTracker& sectors, bool trackReady, const GnssSnapshot& g,
                       DisplayStatus& st) {
  st.gnssLock = gnssLocked(g);
  st.sats = g.haveFix ? g.last.sats : 0;
  st.hdop = g.haveFix ? g.last.hdop : NAN;

  if (!trackReady) {
    st.timing = TimingStatus::NoTrack;
  } else if (!st.gnssLock) {
    st.timing = TimingStatus::NoFix;
  } else if (!e.inLapNow()) {
    st.timing = TimingStatus::WaitStart;
  } else {
    st.timing = TimingStatus::InLap;
  }

  if (trackReady) {
    st.lapNumber = e.currentLapNumber();
    st.sectorCount = sectorCount(e);
    st.sector = sectors.current(e);
    st.lapElapsedS = (e.inLapNow() && g.haveFix) ? g.last.t - e.lapStartTime() : NAN;
    const LapRecord* last = e.lastLap();
    st.haveLastLap = last != nullptr;
    st.lastLapS = last ? last->timeS : NAN;
    st.lastLapValid = last ? last->valid : false;
    st.haveBestLap = e.haveBest;
    st.bestLapS = e.haveBest ? e.bestLap.timeS : NAN;
  }
}

}  // namespace apex
