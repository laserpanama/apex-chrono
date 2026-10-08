// Host-side parity test for the firmware timing core.
// Build & run:  npm run firmware:test   (g++ -std=c++17)
// Replays fixtures exported from the TypeScript reference engine
// (npm run firmware:fixtures) and checks the C++ port produces the same laps.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../lib/apex_timing/apex_timing.h"

static double parseNum(const char* s) { return std::strncmp(s, "nan", 3) == 0 ? NAN : std::strtod(s, nullptr); }

static bool loadTrack(const std::string& path, apex::Track& tr) {
  FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return false;
  char kw[32], a[64], b[64], c[64], d[64];
  double olat, olon;
  int n;
  if (std::fscanf(f, "%31s %63s %63s", kw, a, b) != 3) return false;
  olat = parseNum(a);
  olon = parseNum(b);
  if (std::fscanf(f, "%31s %d", kw, &n) != 2) return false;
  std::vector<double> lat(n), lon(n);
  for (int i = 0; i < n; i++) {
    if (std::fscanf(f, "%63s %63s", a, b) != 2) return false;
    lat[i] = parseNum(a);
    lon[i] = parseNum(b);
  }
  int ng;
  if (std::fscanf(f, "%31s %d", kw, &ng) != 2) return false;
  std::vector<apex::GeoGate> gates(ng);
  for (int i = 0; i < ng; i++) {
    if (std::fscanf(f, "%31s %63s %63s %63s %63s", kw, a, b, c, d) != 5) return false;
    gates[i] = {std::strcmp(kw, "SF") == 0 ? apex::GateKind::StartFinish : apex::GateKind::Sector, parseNum(a), parseNum(b),
                parseNum(c), parseNum(d)};
  }
  std::fclose(f);
  if (!tr.compile(olat, olon, lat.data(), lon.data(), n, gates.data(), ng)) {
    std::fprintf(stderr, "compile failed: %s\n", tr.error);
    return false;
  }
  return true;
}

struct Expected {
  int number;
  double timeS;
  int valid;
  double maxSpeed;
  std::vector<double> splits;
};

static std::vector<std::string> splitCsv(const std::string& line) {
  std::vector<std::string> out;
  size_t p = 0;
  while (true) {
    size_t q = line.find(',', p);
    out.push_back(line.substr(p, q == std::string::npos ? std::string::npos : q - p));
    if (q == std::string::npos) break;
    p = q + 1;
  }
  return out;
}

static std::vector<std::string> readLines(const std::string& path) {
  std::vector<std::string> lines;
  FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return lines;
  char buf[1024];
  while (std::fgets(buf, sizeof buf, f)) {
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    if (!s.empty()) lines.push_back(s);
  }
  std::fclose(f);
  return lines;
}

static apex::Track track;      // large: keep off the stack
static apex::LapEngine engine;

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "firmware/test_host/fixtures";
  const char* names[] = {"club_3m_doppler", "street_1m5_position_only", "fast_10m_degraded"};
  int failures = 0;
  for (const char* name : names) {
    const std::string base = dir + "/" + name;
    if (!loadTrack(base + ".track", track)) {
      std::printf("FAIL %s: cannot load track\n", name);
      failures++;
      continue;
    }
    engine.reset(&track);
    auto fixLines = readLines(base + ".fixes.csv");
    apex::Event ev[apex::MAX_EVENTS];
    for (size_t i = 1; i < fixLines.size(); i++) {
      auto c = splitCsv(fixLines[i]);
      apex::GnssFix f{parseNum(c[0].c_str()), parseNum(c[1].c_str()), parseNum(c[2].c_str()), parseNum(c[3].c_str()),
                      parseNum(c[4].c_str()), std::atoi(c[5].c_str()), parseNum(c[6].c_str()), std::atoi(c[7].c_str())};
      engine.push(f, ev);
    }
    engine.flush(ev);
    auto expLines = readLines(base + ".expected.csv");
    std::vector<Expected> exp;
    for (size_t i = 1; i < expLines.size(); i++) {
      auto c = splitCsv(expLines[i]);
      Expected e{std::atoi(c[0].c_str()), parseNum(c[1].c_str()), std::atoi(c[2].c_str()), parseNum(c[3].c_str()), {}};
      for (size_t k = 4; k < c.size(); k++) e.splits.push_back(parseNum(c[k].c_str()));
      exp.push_back(e);
    }
    bool ok = (int)exp.size() == engine.lapCount;
    double maxDiff = 0;
    for (size_t i = 0; ok && i < exp.size(); i++) {
      const apex::LapRecord& r = engine.laps[i % apex::MAX_LAPS];
      if (r.number != exp[i].number || (int)r.valid != exp[i].valid) ok = false;
      auto diff = [&](double a, double b) {
        if (std::isnan(a) && std::isnan(b)) return;
        if (std::isnan(a) != std::isnan(b)) { ok = false; return; }
        const double d = std::fabs(a - b);
        if (d > maxDiff) maxDiff = d;
      };
      diff(r.timeS, exp[i].timeS);
      diff(r.maxSpeedMs, exp[i].maxSpeed);
      for (size_t k = 0; k < exp[i].splits.size(); k++) diff(r.splits[k], exp[i].splits[k]);
    }
    if (maxDiff > 1e-6) ok = false;
    std::printf("%s %s: %d laps (expected %zu), max |C++ − TS| = %.3g s, fixes=%u accepted=%u full_scans=%u\n",
                ok ? "PASS" : "FAIL", name, engine.lapCount, exp.size(), maxDiff, engine.fixes, engine.accepted,
                engine.matcher.fullScans);
    if (!ok) failures++;
  }
  std::printf("sizeof(LapEngine) = %zu bytes, sizeof(Track) = %zu bytes\n", sizeof(apex::LapEngine), sizeof(apex::Track));
  return failures ? 1 : 0;
}
