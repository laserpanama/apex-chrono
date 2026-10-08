#include "TimerService.h"

#include <cstdio>
#include <cstring>

namespace apex {

bool TimerService::loadTrackFrom(Stream& in) {
  static double lat[MAX_CENTER_PTS + 1], lon[MAX_CENTER_PTS + 1];
  static GeoGate gates[MAX_GATES];
  double olat = NAN, olon = NAN;
  int n = 0, ng = 0, mode = 0, want = 0;
  while (true) {
    String line = in.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) {
      if (!in.available()) delay(5);
      continue;
    }
    if (line == "END") break;
    char kw[16];
    if (line.startsWith("origin")) {
      sscanf(line.c_str(), "%15s %lf %lf", kw, &olat, &olon);
    } else if (line.startsWith("centerline")) {
      sscanf(line.c_str(), "%15s %d", kw, &want);
      if (want > MAX_CENTER_PTS + 1) return false;
      mode = 1;
      n = 0;
    } else if (line.startsWith("gates")) {
      sscanf(line.c_str(), "%15s %d", kw, &want);
      if (want > MAX_GATES) return false;
      mode = 2;
      ng = 0;
    } else if (mode == 1 && n < want) {
      sscanf(line.c_str(), "%lf %lf", &lat[n], &lon[n]);
      n++;
    } else if (mode == 2 && ng < want) {
      GeoGate& g = gates[ng++];
      sscanf(line.c_str(), "%15s %lf %lf %lf %lf", kw, &g.leftLat, &g.leftLon, &g.rightLat, &g.rightLon);
      g.kind = strcmp(kw, "SF") == 0 ? GateKind::StartFinish : GateKind::Sector;
    }
    if (mode == 2 && ng == want && want > 0) break;
  }
  if (!track_.compile(olat, olon, lat, lon, n, gates, ng)) {
    Serial.printf("TRACK,ERROR,%s\n", track_.error);
    return false;
  }
  engine_.reset(&track_);
  trackReady_ = true;
  Serial.printf("TRACK,OK,%d_points,%d_gates,%.1f_m\n", track_.cl.n, track_.nGates, track_.cl.lengthM);
  return true;
}

int TimerService::pushFix(const GnssFix& fix, Event* events) {
  if (!trackReady_) return 0;
  return engine_.push(fix, events);
}

int TimerService::flush(Event* events) {
  if (!trackReady_) return 0;
  return engine_.flush(events);
}

}  // namespace apex
