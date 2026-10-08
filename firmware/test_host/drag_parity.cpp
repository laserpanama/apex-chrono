// Host-side parity test for the drag engine (firmware/lib/apex_drag).
// Build & run:  npm run firmware:test
// Replays contract CSVs exported by `npm run firmware:fixtures` through the
// C++ DragEngine and checks every run AND every event against what the
// TypeScript reference (src/lib/gnss/drag.ts) produced from the same text.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "../lib/apex_drag/DragEngine.h"

static int g_checks = 0, g_failed = 0;
static constexpr double kEps = 1e-9;

static std::vector<std::string> splitCsv(const std::string& line) {
  std::vector<std::string> out;
  size_t p = 0;
  while (true) {
    const size_t q = line.find(',', p);
    out.push_back(line.substr(p, q == std::string::npos ? std::string::npos : q - p));
    if (q == std::string::npos) break;
    p = q + 1;
  }
  return out;
}

static double num(const std::string& s) {
  if (s.empty() || s == "nan") return NAN;
  return std::strtod(s.c_str(), nullptr);
}

static bool same(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
  return std::fabs(a - b) <= kEps;
}

static void check(bool ok, const std::string& what) {
  g_checks++;
  if (!ok) {
    g_failed++;
    if (g_failed < 40) std::printf("  FAIL %s\n", what.c_str());
  }
}

static std::vector<std::vector<std::string>> readRows(const std::string& path) {
  std::ifstream f(path);
  std::vector<std::vector<std::string>> rows;
  std::string line;
  bool header = true;
  while (std::getline(f, line)) {
    if (line.empty() || line[0] == '#') continue;
    if (header) {
      header = false;
      continue;
    }
    rows.push_back(splitCsv(line));
  }
  return rows;
}

static void runScenario(const std::string& dir, const std::string& name) {
  const std::string base = dir + "/" + name;
  apex::DragConfig cfg;
  {
    std::ifstream f(base + ".dragcfg");
    std::string key;
    double v;
    while (f >> key >> v)
      if (key == "rollout_m") cfg.rolloutM = v;
  }
  apex::DragEngine eng(cfg);
  check(eng.configValid(), name + ": config valid");

  std::vector<apex::DragEvent> events;
  std::vector<apex::DragRun> runs;
  apex::DragEvent ev[apex::kDragMaxEvents];
  auto collect = [&](int n) {
    for (int i = 0; i < n; i++) {
      events.push_back(ev[i]);
      if (ev[i].type == apex::DragEventType::End) runs.push_back(eng.lastRun());
    }
  };
  // Contract columns (recording.ts RECORDING_HEADER order):
  // timestamp_ms,latitude,longitude,speed_kmh,heading_deg,satellites,hdop,fix_quality,altitude_m,mcu_ms
  for (const auto& c : readRows(base + ".csv")) {
    const int64_t ms = std::strtoll(c[0].c_str(), nullptr, 10);
    const int fixq = c[7].empty() ? -1 : std::atoi(c[7].c_str());
    const apex::DragSample s =
        apex::dragSampleFromRow(ms, num(c[3]), std::atoi(c[5].c_str()), num(c[6]), fixq, num(c[8]));
    collect(eng.push(s, ev));
  }
  collect(eng.flush(ev));

  const auto exp = readRows(base + ".drag_expected.csv");
  check(exp.size() == runs.size(), name + ": run count " + std::to_string(runs.size()) + " vs " +
                                       std::to_string(exp.size()));
  for (size_t i = 0; i < exp.size() && i < runs.size(); i++) {
    const auto& e = exp[i];
    const apex::DragRun& r = runs[i];
    const std::string tag = name + " run " + std::to_string(i + 1) + ": ";
    size_t k = 0;
    check(r.number == std::atoi(e[k++].c_str()), tag + "number");
    check((r.valid ? 1 : 0) == std::atoi(e[k++].c_str()), tag + "valid");
    check(r.flags == std::atoi(e[k++].c_str()), tag + "flags");
    check(static_cast<int>(r.endReason) == std::atoi(e[k++].c_str()), tag + "end reason");
    check(same(r.t0, num(e[k++])), tag + "t0");
    check(same(r.tStart, num(e[k++])), tag + "tStart");
    check(same(r.peakKmh, num(e[k++])), tag + "peak");
    check(same(r.distanceM, num(e[k++])), tag + "distance");
    check(same(r.durationS, num(e[k++])), tag + "duration");
    check(same(r.slopePct, num(e[k++])), tag + "slope");
    for (int j = 0; j < cfg.nSpeed; j++) check(same(r.speedTimeS[j], num(e[k++])), tag + "speed " + std::to_string(j));
    for (int j = 0; j < cfg.nDist; j++) {
      check(same(r.distTimeS[j], num(e[k++])), tag + "dist " + std::to_string(j));
      check(same(r.trapKmh[j], num(e[k++])), tag + "trap " + std::to_string(j));
    }
    for (int j = 0; j < cfg.nRanges; j++) check(same(r.rangeTimeS[j], num(e[k++])), tag + "range " + std::to_string(j));
  }

  const auto expEv = readRows(base + ".drag_events.csv");
  check(expEv.size() == events.size(), name + ": event count " + std::to_string(events.size()) + " vs " +
                                           std::to_string(expEv.size()));
  for (size_t i = 0; i < expEv.size() && i < events.size(); i++) {
    const auto& e = expEv[i];
    const apex::DragEvent& g = events[i];
    const std::string tag = name + " event " + std::to_string(i) + ": ";
    check(static_cast<int>(g.type) == std::atoi(e[0].c_str()), tag + "type");
    check(same(g.t, num(e[1])), tag + "t");
    const bool target = g.type == apex::DragEventType::Speed || g.type == apex::DragEventType::Distance;
    check((target ? g.index : -1) == std::atoi(e[2].c_str()), tag + "index");
    check(same(g.timeS, num(e[3])), tag + "time");
    check(same(g.trapKmh, num(e[4])), tag + "trap");
  }
  std::printf("%s: %zu runs, %zu events\n", name.c_str(), runs.size(), events.size());
}

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "firmware/test_host/fixtures";
  for (const char* n : {"drag_10hz_three_cars", "drag_25hz_uphill", "drag_10hz_rollout", "drag_10hz_degraded"})
    runScenario(dir, n);
  std::printf("%s drag_parity: %d checks, %d failed\n", g_failed ? "FAIL" : "PASS", g_checks, g_failed);
  return g_failed ? 1 : 0;
}
