#pragma once
// Apex Chrono — read-only view of the drag engine for the display.
// Pure C++17 (host-tested in firmware/test_host/hw_test.cpp): fills the drag
// half of a DisplayStatus. GNSS lock/sats/HDOP come from fillTiming().

#include <cmath>

#include "DisplayModel.h"
#include "DragEngine.h"

namespace apex {

struct DragTargetIndex {
  int s0to100 = -1;
  int d60ft = -1, dEighth = -1, dQuarter = -1;
};

inline DragTargetIndex dragTargetIndex(const DragConfig& c) {
  DragTargetIndex x;
  for (int i = 0; i < c.nSpeed; i++)
    if (c.speedKmh[i] == 100) x.s0to100 = i;
  for (int i = 0; i < c.nDist; i++) {
    if (std::fabs(c.distM[i] - 60 * kFt) < 1e-6) x.d60ft = i;
    if (std::fabs(c.distM[i] - 660 * kFt) < 1e-6) x.dEighth = i;
    if (std::fabs(c.distM[i] - 1320 * kFt) < 1e-6) x.dQuarter = i;
  }
  return x;
}

// `locked`: GNSS lock as shown on line 0; `speedKmh`: newest Doppler speed (NAN if none).
inline void fillDrag(const DragEngine& e, bool locked, double speedKmh, DisplayStatus& st) {
  st.view = DisplayView::Drag;
  st.speedKmh = speedKmh;
  if (e.running()) st.drag = DragUi::Run;
  else if (!locked) st.drag = DragUi::NoFix;
  else if (e.state() == DragState::Armed) st.drag = DragUi::Ready;
  else st.drag = DragUi::Stop;
  st.dragElapsedS = e.running() ? e.elapsedS() : NAN;

  st.haveDragRun = e.runs() > 0;
  if (!st.haveDragRun) return;
  const DragRun& r = e.lastRun();
  const DragTargetIndex x = dragTargetIndex(e.config());
  st.dragRun = r.number;
  st.dragValid = r.valid;
  st.drag0to100S = x.s0to100 >= 0 ? r.speedTimeS[x.s0to100] : NAN;
  st.drag60ftS = x.d60ft >= 0 ? r.distTimeS[x.d60ft] : NAN;
  st.dragEighthS = x.dEighth >= 0 ? r.distTimeS[x.dEighth] : NAN;
  st.dragEighthTrapKmh = x.dEighth >= 0 ? r.trapKmh[x.dEighth] : NAN;
  st.dragQuarterS = x.dQuarter >= 0 ? r.distTimeS[x.dQuarter] : NAN;
  st.dragQuarterTrapKmh = x.dQuarter >= 0 ? r.trapKmh[x.dQuarter] : NAN;
}

}  // namespace apex
