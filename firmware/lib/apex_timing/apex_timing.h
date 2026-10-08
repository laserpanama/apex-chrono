// Apex Chrono V1 — GNSS lap timing core (C++17, header-only, no heap).
//
// Line-for-line port of src/lib/gnss (TypeScript). The TS version is the
// reference; firmware/test_host/parity.cpp replays fixtures exported from it
// and checks this port produces the same laps.
//
//   GnssFix → quality filter → LocalFrame → MapMatcher → GateDetector → LapEngine
//
// All storage is fixed-size and lives inside the objects (put a LapEngine in
// a static, not on the task stack: it is ~60 KB with the default limits).
// Doubles are used throughout. The ESP32-S3 FPU is single precision, so
// doubles are emulated, but the per-fix cost (≈ 2·window segment
// projections + a few gates) is far below the 100 ms fix period.

#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>

namespace apex {

// 1536 points at the usual 3–4 m spacing covers a 4.5–6 km circuit (~74 KB).
// Override with -DAPEX_MAX_CENTER_PTS=... for longer tracks / PSRAM builds.
#ifndef APEX_MAX_CENTER_PTS
#define APEX_MAX_CENTER_PTS 1536
#endif
constexpr int MAX_CENTER_PTS = APEX_MAX_CENTER_PTS;
constexpr int MAX_GATES = 16;
constexpr int RING_CAP = 128;
constexpr int MAX_WINDOW = 64;  // 2 × refineFixesMax + slack
constexpr int MAX_LAPS = 64;    // ring of recent laps kept in RAM (SD has all)
constexpr int MAX_TRACE = MAX_CENTER_PTS;  // best-lap trace bins at 5 m (≥ track length / 5 m)
constexpr double kPi = 3.14159265358979323846;
constexpr double DEG = kPi / 180.0;

// ───────────────────────────── geo ─────────────────────────────
struct LocalFrame {
  double lat0 = 0, lon0 = 0, mPerDegLat = 1, mPerDegLon = 1;
  void init(double lat, double lon) {
    lat0 = lat;
    lon0 = lon;
    const double A = 6378137.0, E2 = 0.00669437999014;
    const double s = std::sin(lat * DEG), w = 1 - E2 * s * s;
    const double M = A * (1 - E2) / std::pow(w, 1.5), N = A / std::sqrt(w);
    mPerDegLat = M * DEG;
    mPerDegLon = N * std::cos(lat * DEG) * DEG;
  }
  void toLocal(double lat, double lon, double& x, double& y) const {
    double dLon = lon - lon0;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    x = dLon * mPerDegLon;
    y = (lat - lat0) * mPerDegLat;
  }
  void toGeo(double x, double y, double& lat, double& lon) const {
    lon = lon0 + x / mPerDegLon;
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    lat = lat0 + y / mPerDegLat;
  }
};

inline void courseToUnit(double c, double& x, double& y) {
  x = std::sin(c * DEG);
  y = std::cos(c * DEG);
}

// ───────────────────────────── centerline ─────────────────────────────
struct Centerline {
  int n = 0;
  double ax[MAX_CENTER_PTS], ay[MAX_CENTER_PTS], tx[MAX_CENTER_PTS], ty[MAX_CENTER_PTS], len[MAX_CENTER_PTS];
  double cum[MAX_CENTER_PTS + 1];
  double lengthM = 0;

  // pts: local metres, closed loop (a repeated closing point is dropped). Returns false on bad input.
  bool init(const double* px, const double* py, int count) {
    n = 0;
    for (int i = 0; i < count; i++) {
      if (!std::isfinite(px[i]) || !std::isfinite(py[i])) return false;
      if (n > 0 && std::hypot(px[i] - ax[n - 1], py[i] - ay[n - 1]) < 1e-6) continue;
      if (n >= MAX_CENTER_PTS) return false;
      ax[n] = px[i];
      ay[n] = py[i];
      n++;
    }
    if (n > 1 && std::hypot(ax[0] - ax[n - 1], ay[0] - ay[n - 1]) < 1e-6) n--;
    if (n < 3) return false;
    double acc = 0;
    for (int i = 0; i < n; i++) {
      const int j = (i + 1) % n;
      const double dx = ax[j] - ax[i], dy = ay[j] - ay[i], L = std::hypot(dx, dy);
      tx[i] = dx / L;
      ty[i] = dy / L;
      len[i] = L;
      cum[i] = acc;
      acc += L;
    }
    cum[n] = acc;
    lengthM = acc;
    return true;
  }
  double wrap(double s) const {
    double r = std::fmod(s, lengthM);
    return r < 0 ? r + lengthM : r;
  }
  double delta(double to, double from) const {
    double d = std::fmod(to - from, lengthM);
    if (d > lengthM / 2) d -= lengthM;
    else if (d <= -lengthM / 2) d += lengthM;
    return d;
  }
  int segmentAt(double s) const {
    const double d = wrap(s);
    int lo = 0, hi = n - 1;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  void pointAt(double s, double& x, double& y, double& otx, double& oty, int& seg) const {
    const double d = wrap(s);
    seg = segmentAt(d);
    const double u = d - cum[seg];
    x = ax[seg] + tx[seg] * u;
    y = ay[seg] + ty[seg] * u;
    otx = tx[seg];
    oty = ty[seg];
  }
  // s, signed cross-track (left +), squared distance
  void projectOnSegment(int i, double px, double py, double& s, double& e, double& d2) const {
    const double L = len[i];
    double t = ((px - ax[i]) * tx[i] + (py - ay[i]) * ty[i]) / L;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const double qx = ax[i] + tx[i] * L * t, qy = ay[i] + ty[i] * L * t;
    const double ex = px - qx, ey = py - qy;
    d2 = ex * ex + ey * ey;
    const double side = ex * -ty[i] + ey * tx[i];
    e = (side >= 0 ? 1 : -1) * std::sqrt(d2);
    s = cum[i] + t * L;
  }
};

struct MatchResult {
  double s, e;
  int seg;
  bool fullScan;
};

struct MapMatcher {
  const Centerline* cl = nullptr;
  int windowSegments = 16;
  double fallbackDistanceM = 30;
  int lastSeg = -1;
  uint32_t fullScans = 0;

  void scan(double px, double py, int from, int count, double& bs, double& be, double& bd2, int& bseg) const {
    bd2 = INFINITY;
    bseg = -1;
    for (int k = 0; k < count; k++) {
      const int i = (((from + k) % cl->n) + cl->n) % cl->n;
      double s, e, d2;
      cl->projectOnSegment(i, px, py, s, e, d2);
      if (d2 < bd2) {
        bd2 = d2;
        bs = s;
        be = e;
        bseg = i;
      }
    }
  }
  MatchResult match(double px, double py, bool havePred, double predictedS) {
    const double fb2 = fallbackDistanceM * fallbackDistanceM;
    int center = lastSeg;
    if (havePred && std::isfinite(predictedS) && lastSeg >= 0) center = cl->segmentAt(predictedS);
    double s = 0, e = 0, d2 = 0;
    int seg = -1;
    if (center >= 0 && 2 * windowSegments + 1 < cl->n) {
      scan(px, py, center - windowSegments, 2 * windowSegments + 1, s, e, d2, seg);
      if (d2 <= fb2) {
        lastSeg = seg;
        return {cl->wrap(s), e, seg, false};
      }
    }
    fullScans++;
    scan(px, py, 0, cl->n, s, e, d2, seg);
    if (d2 <= fb2 || lastSeg < 0) lastSeg = seg;
    return {cl->wrap(s), e, seg, true};
  }
};

// ───────────────────────────── track ─────────────────────────────
enum class GateKind : uint8_t { StartFinish, Sector };

struct Gate {
  GateKind kind;
  double lx, ly, rx, ry, fx, fy, halfWidthM, s, centerE;
};

struct GeoGate {
  GateKind kind;
  double leftLat, leftLon, rightLat, rightLon;
};

struct Track {
  LocalFrame frame;
  Centerline cl;
  Gate gates[MAX_GATES];
  int nGates = 0;
  const char* error = nullptr;

  // Centerline lat/lon arrays in driving order; gates[0] = start/finish, then sectors in order.
  // NOTE: lat/lon are converted IN PLACE to local x/y metres (saves a second
  // 2×N double buffer on the MCU); do not reuse them as lat/lon afterwards.
  bool compile(double originLat, double originLon, double* lat, double* lon, int nPts, const GeoGate* g, int ng) {
    error = nullptr;
    double* px = lat;
    double* py = lon;
    if (nPts > MAX_CENTER_PTS + 1) return fail("centerline too long");
    if (ng < 1 || ng > MAX_GATES) return fail("bad gate count");
    if (g[0].kind != GateKind::StartFinish) return fail("gates[0] must be start/finish");
    frame.init(originLat, originLon);
    for (int i = 0; i < nPts; i++) {
      double x, y;
      frame.toLocal(lat[i], lon[i], x, y);
      px[i] = x;
      py[i] = y;
    }
    if (!cl.init(px, py, nPts)) return fail("bad centerline");
    nGates = ng;
    for (int k = 0; k < ng; k++) {
      Gate& G = gates[k];
      G.kind = g[k].kind;
      if (k > 0 && G.kind != GateKind::Sector) return fail("only gates[0] may be start/finish");
      frame.toLocal(g[k].leftLat, g[k].leftLon, G.lx, G.ly);
      frame.toLocal(g[k].rightLat, g[k].rightLon, G.rx, G.ry);
      const double dx = G.rx - G.lx, dy = G.ry - G.ly, w = std::hypot(dx, dy);
      if (w < 1) return fail("gate shorter than 1 m");
      G.fx = -dy / w;
      G.fy = dx / w;
      G.halfWidthM = w / 2;
      const double mx = (G.lx + G.rx) / 2, my = (G.ly + G.ry) / 2;
      double bestS = NAN, bestD = INFINITY;
      int bestSeg = -1;
      for (int i = 0; i < cl.n; i++) {
        const double ax = cl.ax[i], ay = cl.ay[i], bx = ax + cl.tx[i] * cl.len[i], by = ay + cl.ty[i] * cl.len[i];
        const double rX = bx - ax, rY = by - ay, sX = G.rx - G.lx, sY = G.ry - G.ly;
        const double den = rX * sY - rY * sX;
        if (std::fabs(den) < 1e-12) continue;
        const double qX = G.lx - ax, qY = G.ly - ay;
        const double u = (qX * sY - qY * sX) / den, v = (qX * rY - qY * rX) / den;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const double ix = ax + rX * u, iy = ay + rY * u, d = std::hypot(ix - mx, iy - my);
        if (d < bestD) {
          bestD = d;
          bestS = cl.cum[i] + u * cl.len[i];
          bestSeg = i;
        }
      }
      if (!std::isfinite(bestS)) return fail("gate does not cross the centerline");
      if (G.fx * cl.tx[bestSeg] + G.fy * cl.ty[bestSeg] < 0.5) return fail("gate direction disagrees with centerline");
      double ps, pe, pd2;
      cl.projectOnSegment(bestSeg, mx, my, ps, pe, pd2);
      G.s = cl.wrap(bestS);
      G.centerE = pe;
    }
    double prev = 0;
    for (int k = 1; k < ng; k++) {
      const double rel = cl.wrap(gates[k].s - gates[0].s);
      if (rel <= prev) return fail("gate out of driving order");
      prev = rel;
    }
    return true;
  }

 private:
  bool fail(const char* m) {
    error = m;
    return false;
  }
};

// ───────────────────────────── fixes ─────────────────────────────
struct GnssFix {
  double t;  // GNSS seconds
  double lat, lon;
  double speedMs;    // NAN if not reported
  double courseDeg;  // NAN if not reported
  int sats;
  double hdop;
  int fixType;  // -1 unknown, 0 none, 2 = 2D, 3 = 3D
};

enum class Quality : uint8_t { Ok, NoFix, Sats, Hdop, NotFinite, Time };

struct QualityConfig {
  int minSats = 6;
  double maxHdop = 2.5;
  double maxCrossTrackM = 25;
};

inline Quality checkFixQuality(const GnssFix& f, const QualityConfig& c, bool haveLast, double lastT) {
  if (!std::isfinite(f.lat) || !std::isfinite(f.lon) || !std::isfinite(f.t)) return Quality::NotFinite;
  if (std::fabs(f.lat) > 90 || std::fabs(f.lon) > 180) return Quality::NotFinite;
  if (f.fixType >= 0 && f.fixType < 2) return Quality::NoFix;
  if (!(f.sats >= c.minSats)) return Quality::Sats;
  if (!(f.hdop <= c.maxHdop)) return Quality::Hdop;
  if (haveLast && !(f.t > lastT)) return Quality::Time;
  return Quality::Ok;
}

struct FixRing {
  double t[RING_CAP], x[RING_CAP], y[RING_CAP], s[RING_CAP], e[RING_CAP], v[RING_CAP], c[RING_CAP];
  int64_t nextSeq = 0;
  int count = 0;
  int64_t push(double ft, double fx, double fy, double fs, double fe, double fv, double fc) {
    const int64_t seq = nextSeq++;
    const int i = (int)(seq % RING_CAP);
    t[i] = ft; x[i] = fx; y[i] = fy; s[i] = fs; e[i] = fe; v[i] = fv; c[i] = fc;
    if (count < RING_CAP) count++;
    return seq;
  }
  int64_t oldestSeq() const { return nextSeq - count; }
  bool has(int64_t q) const { return q >= oldestSeq() && q < nextSeq; }
  static int slot(int64_t q) { return (int)(q % RING_CAP); }
};

// ───────────────────────────── gates ─────────────────────────────
struct GateConfig {
  int refineFixes = 10;
  int refineFixesMax = 30;
  double noiseRefM = 2.5;
  double approachM = 60;
  double rearmDistanceM = 80;
  double cooldownS = 5;
  double maxGapS = 1.0;
  double minSpeedMs = 4;
  double minMoveM = 2;
  double maxHeadingErrorDeg = 60;
  double lateralMarginM = 5;
  double pendingTimeoutS = 4.5;
  double minScale = 0.8, maxScale = 1.2;
};

enum class Reject : uint8_t { Gap, Cooldown, Slow, NoMovement, WrongDirection, OutsideGate, NoProgress, TooFewFixes, COUNT };

struct Crossing {
  int gate;
  double t, tPrelim, speedMs, lateralM, headingErrDeg, noiseEstM;
  bool doppler;
  int nFixes;
};

struct GateDetector {
  const Track* track = nullptr;
  GateConfig cfg;
  FixRing ring;
  enum : uint8_t { IDLE, APPROACH, PENDING, DISARMED };
  uint8_t state[MAX_GATES];
  int64_t lastBeforeSeq[MAX_GATES], pendingSeq[MAX_GATES];
  double pendingT[MAX_GATES], pendingK[MAX_GATES], pendingNoise[MAX_GATES], lastAcceptT[MAX_GATES];
  uint32_t rejections[(int)Reject::COUNT];

  void reset(const Track* tr) {
    track = tr;
    ring.nextSeq = 0;
    ring.count = 0;
    for (int g = 0; g < MAX_GATES; g++) {
      state[g] = IDLE;
      lastBeforeSeq[g] = -1;
      pendingSeq[g] = -1;
      pendingT[g] = pendingK[g] = pendingNoise[g] = 0;
      lastAcceptT[g] = -INFINITY;
    }
    std::memset(rejections, 0, sizeof(rejections));
  }
  bool hasPending() const {
    for (int g = 0; g < track->nGates; g++)
      if (state[g] == PENDING) return true;
    return false;
  }
  double earliestPendingT() const {
    double t = INFINITY;
    for (int g = 0; g < track->nGates; g++)
      if (state[g] == PENDING && pendingT[g] < t) t = pendingT[g];
    return t;
  }

  // returns number of crossings written to out (≤ MAX_GATES)
  int push(double t, double x, double y, double s, double e, double v, double c, Crossing* out) {
    const int64_t seq = ring.push(t, x, y, s, e, v, c);
    const Centerline& cl = track->cl;
    int nOut = 0;
    for (int g = 0; g < track->nGates; g++) {
      const Gate& gate = track->gates[g];
      const double rel = cl.delta(s, gate.s);
      uint8_t st = state[g];
      if (st == PENDING) continue;
      if (st == DISARMED) {
        if (std::fabs(rel) > cfg.rearmDistanceM) st = IDLE;
        else continue;
      }
      if (rel >= -cfg.approachM && rel < 0) {
        st = APPROACH;
        lastBeforeSeq[g] = seq;
      } else if (rel >= 0 && rel <= cfg.approachM && st == APPROACH) {
        const int64_t bSeq = lastBeforeSeq[g];
        if (!ring.has(bSeq)) {
          st = IDLE;
        } else {
          const int b = FixRing::slot(bSeq);
          const double tb = ring.t[b], relB = cl.delta(ring.s[b], gate.s);
          const double tPre = tb + (-relB / (rel - relB)) * (t - tb);
          if (t - tb > cfg.maxGapS) {
            rejections[(int)Reject::Gap]++;
            st = IDLE;
          } else if (tPre - lastAcceptT[g] < cfg.cooldownS) {
            rejections[(int)Reject::Cooldown]++;
            st = DISARMED;
          } else {
            st = PENDING;
            pendingSeq[g] = seq;
            pendingT[g] = tPre;
            pendingK[g] = 0;
          }
        }
      } else {
        st = IDLE;
      }
      state[g] = st;
    }
    for (int g = 0; g < track->nGates; g++) {
      if (state[g] != PENDING) continue;
      const int64_t after = seq - pendingSeq[g] + 1;
      const bool timedOut = t - pendingT[g] > cfg.pendingTimeoutS;
      if (after < cfg.refineFixes && !timedOut) continue;
      if (pendingK[g] == 0) {
        const double noise = estimateNoise(g, cfg.refineFixes);
        pendingNoise[g] = noise;
        double want = std::floor(cfg.refineFixes * std::fmax(1.0, noise / cfg.noiseRefM) + 0.5);
        pendingK[g] = std::fmax(cfg.refineFixes, std::fmin(cfg.refineFixesMax, want));
      }
      if (after >= pendingK[g] || timedOut) {
        if (finalize(g, out[nOut])) nOut++;
      }
    }
    return nOut;
  }

  int flush(Crossing* out) {
    int nOut = 0;
    for (int g = 0; g < track->nGates; g++) {
      if (state[g] != PENDING) continue;
      if (pendingK[g] == 0) pendingK[g] = cfg.refineFixes;
      if (finalize(g, out[nOut])) nOut++;
    }
    return nOut;
  }

 private:
  double estimateNoise(int g, int K) const {
    const Centerline& cl = track->cl;
    const double gs = track->gates[g].s;
    const int64_t c = pendingSeq[g];
    const int64_t lo = c - K > ring.oldestSeq() ? c - K : ring.oldestSeq();
    const int64_t hi = c + K - 1 < ring.nextSeq - 1 ? c + K - 1 : ring.nextSeq - 1;
    double sum = 0;
    int n = 0;
    for (int64_t q = lo + 2; q <= hi; q++) {
      const double ra = cl.delta(ring.s[FixRing::slot(q - 2)], gs);
      const double rb = cl.delta(ring.s[FixRing::slot(q - 1)], gs);
      const double rd = cl.delta(ring.s[FixRing::slot(q)], gs);
      const double d2 = rd - 2 * rb + ra;
      if (std::fabs(d2) > 100) continue;
      sum += d2 * d2;
      n++;
    }
    return n ? std::sqrt(sum / n / 6) : 0;
  }

  bool done(int g, bool ok, double tAcc, Reject r) {
    if (ok) {
      state[g] = DISARMED;
      lastAcceptT[g] = tAcc;
    } else {
      state[g] = IDLE;
      rejections[(int)r]++;
    }
    pendingSeq[g] = -1;
    return ok;
  }

  bool finalize(int g, Crossing& out) {
    const Gate& gate = track->gates[g];
    const Centerline& cl = track->cl;
    const int64_t crossSeq = pendingSeq[g];
    const double tPre = pendingT[g];
    const int K = (int)(pendingK[g] > 0 ? pendingK[g] : cfg.refineFixes);
    const int64_t lo = crossSeq - K > ring.oldestSeq() ? crossSeq - K : ring.oldestSeq();
    const int64_t hi = crossSeq + K - 1 < ring.nextSeq - 1 ? crossSeq + K - 1 : ring.nextSeq - 1;
    double ts[MAX_WINDOW], rels[MAX_WINDOW], vs[MAX_WINDOW];
    int slots[MAX_WINDOW];
    int n = 0;
    bool allSpeed = true, allCourse = true;
    for (int64_t q = lo; q <= hi && n < MAX_WINDOW; q++) {
      const int i = FixRing::slot(q);
      const double rel = cl.delta(ring.s[i], gate.s);
      if (std::fabs(rel) > 2 * cfg.approachM) continue;
      ts[n] = ring.t[i];
      rels[n] = rel;
      vs[n] = ring.v[i];
      slots[n] = i;
      if (!std::isfinite(ring.v[i])) allSpeed = false;
      if (!std::isfinite(ring.c[i])) allCourse = false;
      n++;
    }
    if (n < 2) return done(g, false, 0, Reject::TooFewFixes);

    double tCross, speed;
    bool doppler;
    if (allSpeed) {
      doppler = true;
      speed = 0;
      for (int k = 0; k < n; k++) speed += vs[k];
      speed /= n;
      if (allCourse) {
        for (int k = 0; k < n; k++) {
          double px, py, ptx, pty, ux, uy;
          int seg;
          cl.pointAt(ring.s[slots[k]], px, py, ptx, pty, seg);
          courseToUnit(ring.c[slots[k]], ux, uy);
          vs[k] = vs[k] * std::fmax(0.0, ux * ptx + uy * pty);
        }
      }
      double D[MAX_WINDOW], r[MAX_WINDOW], sorted[MAX_WINDOW];
      D[0] = 0;
      for (int k = 1; k < n; k++) D[k] = D[k - 1] + 0.5 * (vs[k - 1] + vs[k]) * (ts[k] - ts[k - 1]);
      for (int k = 0; k < n; k++) sorted[k] = r[k] = rels[k] - D[k];
      for (int a = 1; a < n; a++) {  // insertion sort, n ≤ 64
        const double key = sorted[a];
        int b = a - 1;
        while (b >= 0 && sorted[b] > key) { sorted[b + 1] = sorted[b]; b--; }
        sorted[b + 1] = key;
      }
      const double med = sorted[n >> 1];
      int cnt = 0;
      double mD = 0, mR = 0;
      for (int k = 0; k < n; k++)
        if (std::fabs(r[k] - med) <= 30) { mD += D[k]; mR += rels[k]; cnt++; }
      double alpha = 1, c0 = med;
      if (cnt > 0) {
        mD /= cnt;
        mR /= cnt;
        double sdd = 0, sdr = 0;
        for (int k = 0; k < n; k++) {
          if (std::fabs(r[k] - med) > 30) continue;
          sdd += (D[k] - mD) * (D[k] - mD);
          sdr += (D[k] - mD) * (rels[k] - mR);
        }
        const double a = sdd > 0 ? sdr / sdd : 1;
        alpha = (cnt >= 6 && a > cfg.minScale && a < cfg.maxScale) ? a : 1;
        c0 = mR - alpha * mD;
      }
      const double target = -c0 / alpha;
      tCross = NAN;
      for (int k = 0; k < n - 1; k++) {
        if (D[k] <= target && target <= D[k + 1]) {
          const double dt = ts[k + 1] - ts[k], v0 = vs[k];
          const double acc = dt > 0 ? (vs[k + 1] - v0) / dt : 0, need = target - D[k];
          double tau;
          if (std::fabs(acc) < 1e-9) tau = v0 > 0 ? need / v0 : 0;
          else tau = (-v0 + std::sqrt(std::fmax(0.0, v0 * v0 + 2 * acc * need))) / acc;
          tCross = ts[k] + std::fmin(dt, std::fmax(0.0, tau));
          break;
        }
      }
      if (!std::isfinite(tCross)) {
        if (target < D[0]) tCross = ts[0] - (D[0] - target) / std::fmax(0.1, vs[0]);
        else tCross = ts[n - 1] + (target - D[n - 1]) / std::fmax(0.1, vs[n - 1]);
      }
    } else {
      doppler = false;
      double tm = 0, rm = 0;
      for (int k = 0; k < n; k++) { tm += ts[k]; rm += rels[k]; }
      tm /= n;
      rm /= n;
      double s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0;
      for (int k = 0; k < n; k++) {
        const double u = ts[k] - tm, u2 = u * u;
        s2 += u2; s3 += u2 * u; s4 += u2 * u2;
        r0 += rels[k]; r1 += rels[k] * u; r2 += rels[k] * u2;
      }
      double a, b, c = 0;
      const double det = n * (s2 * s4 - s3 * s3) - s2 * (s2 * s2);
      if (n >= 6 && std::fabs(det) > 1e-12) {
        a = (r0 * (s2 * s4 - s3 * s3) + s2 * (r1 * s3 - s2 * r2)) / det;
        b = (n * (r1 * s4 - s3 * r2) + s2 * (r0 * s3 - s2 * r1)) / det;
        c = (n * (s2 * r2 - r1 * s3) - s2 * (s2 * r0)) / det;
      } else {
        b = s2 > 0 ? r1 / s2 : 0;
        a = rm;
      }
      if (!(b > 0.1)) return done(g, false, 0, Reject::NoProgress);
      double tau;
      const double disc = b * b - 4 * a * c;
      if (std::fabs(c) < 1e-9 || disc < 0) tau = -a / b;
      else tau = (-2 * a) / (b + std::sqrt(disc));
      if (!std::isfinite(tau) || std::fabs(tau) > 3) tau = -a / b;
      tCross = tm + tau;
      speed = b + 2 * c * tau;
    }
    if (speed < cfg.minSpeedMs) return done(g, false, 0, Reject::Slow);
    const int first = slots[0], last = slots[n - 1];
    const double mvx = ring.x[last] - ring.x[first], mvy = ring.y[last] - ring.y[first];
    if (std::hypot(mvx, mvy) < cfg.minMoveM) return done(g, false, 0, Reject::NoMovement);
    double hx = 0, hy = 0;
    if (allCourse) {
      for (int k = 0; k < n; k++) {
        double ux, uy;
        courseToUnit(ring.c[slots[k]], ux, uy);
        hx += ux;
        hy += uy;
      }
    } else {
      hx = mvx;
      hy = mvy;
    }
    double hl = std::hypot(hx, hy);
    if (hl == 0) hl = 1;
    const double cosErr = (hx * gate.fx + hy * gate.fy) / hl;
    const double headingErr = std::acos(std::fmax(-1.0, std::fmin(1.0, cosErr))) / DEG;
    if (headingErr > cfg.maxHeadingErrorDeg) return done(g, false, 0, Reject::WrongDirection);
    double esum = 0;
    for (int k = 0; k < n; k++) esum += ring.e[slots[k]];
    const double lateral = esum / n - gate.centerE;
    if (std::fabs(lateral) > gate.halfWidthM + cfg.lateralMarginM) return done(g, false, 0, Reject::OutsideGate);
    if (tCross - lastAcceptT[g] < cfg.cooldownS) return done(g, false, 0, Reject::Cooldown);
    out = {g, tCross, tPre, speed, lateral, headingErr, pendingNoise[g], doppler, n};
    return done(g, true, tCross, Reject::Gap);
  }
};

// ───────────────────────────── lap engine ─────────────────────────────
struct LapRecord {
  int number;
  double startT, endT, timeS;
  double splits[MAX_GATES];  // NAN = not seen in order
  double maxSpeedMs;
  bool valid;
};

enum class EventType : uint8_t { LapStart, Sector, Lap, RejectedOrder, RejectedShortLap, IgnoredBeforeStart };

struct Event {
  EventType type;
  double t;
  int lap;       // lap number (LapStart/Sector/Lap)
  int index;     // sector index (Sector) or gate (Rejected*/Ignored*)
  double value;  // split (Sector) or lap time (Lap/RejectedShortLap)
};

constexpr int MAX_EVENTS = 2 * MAX_GATES + 2;

struct LapEngine {
  const Track* track = nullptr;
  QualityConfig quality;
  double minLapS = 10;
  double traceStepM = 5;
  double derivedSpeedBaselineS = 1;
  MapMatcher matcher;
  GateDetector detector;

  LapRecord laps[MAX_LAPS];  // ring
  int lapCount = 0;          // total closed laps
  LapRecord bestLap{};
  bool haveBest = false;

  // stats
  uint32_t fixes = 0, accepted = 0, rejectedQuality = 0, rejectedCrossTrack = 0;

  void reset(const Track* tr) {
    track = tr;
    matcher.cl = &tr->cl;
    matcher.lastSeg = -1;
    matcher.fullScans = 0;
    detector.reset(tr);
    lapCount = 0;
    haveBest = false;
    inLap = false;
    lapNumber = 0;
    haveQualityT = false;
    haveLastS = false;
    heldN = 0;
    hHead = hN = 0;
    fixes = accepted = rejectedQuality = rejectedCrossTrack = 0;
  }

  const LapRecord* lastLap() const { return lapCount ? &laps[(lapCount - 1) % MAX_LAPS] : nullptr; }

  // Feed one fix; returns number of events written to ev (array of MAX_EVENTS).
  int push(const GnssFix& f, Event* ev) {
    fixes++;
    if (checkFixQuality(f, quality, haveQualityT, lastQualityT) != Quality::Ok) {
      rejectedQuality++;
      return 0;
    }
    haveQualityT = true;
    lastQualityT = f.t;
    double x, y;
    track->frame.toLocal(f.lat, f.lon, x, y);
    const double v = std::isfinite(f.speedMs) ? f.speedMs : NAN;
    const bool havePred = haveLastS && std::isfinite(v);
    const double pred = havePred ? lastS + v * (f.t - lastAcceptedT) : 0;
    const MatchResult m = matcher.match(x, y, havePred, pred);
    if (std::fabs(m.e) > quality.maxCrossTrackM) {
      rejectedCrossTrack++;
      return 0;
    }
    accepted++;
    haveLastS = true;
    lastS = m.s;
    lastAcceptedT = f.t;
    Crossing cr[MAX_GATES];
    const double c = std::isfinite(f.courseDeg) ? f.courseDeg : NAN;
    int nc = detector.push(f.t, x, y, m.s, m.e, v, c, cr);

    double vLap = v;
    if (!std::isfinite(vLap)) {
      pushHist(f.t, m.s);
      const double dt = f.t - histT[hHead];
      if (dt >= derivedSpeedBaselineS * 0.8) vLap = std::fmax(0.0, track->cl.delta(m.s, histS[hHead]) / dt);
    }
    if (heldN < RING_CAP) {
      heldT[heldN] = f.t;
      heldV[heldN] = vLap;
      heldS[heldN] = m.s;
      heldN++;
    }
    sortCrossings(cr, nc);
    int ne = 0;
    for (int k = 0; k < nc; k++) handle(cr[k], ev, ne);
    releaseHeld(detector.hasPending() ? detector.earliestPendingT() : INFINITY);
    return ne;
  }

  int flush(Event* ev) {
    Crossing cr[MAX_GATES];
    int nc = detector.flush(cr);
    sortCrossings(cr, nc);
    int ne = 0;
    for (int k = 0; k < nc; k++) handle(cr[k], ev, ne);
    releaseHeld(INFINITY);
    return ne;
  }

  bool inLapNow() const { return inLap; }
  int currentLapNumber() const { return lapNumber; }
  double lapStartTime() const { return lapStartT; }

  // Live delta vs best lap at the current lap distance; NAN if unavailable.
  double liveDelta() const {
    if (!inLap || !haveLastS || !haveBest || lastAcceptedT < lapStartT) return NAN;
    const double d = track->cl.wrap(lastS - track->gates[0].s);
    const int b = (int)(d / traceStepM);
    if (b + 1 >= MAX_TRACE) return NAN;
    const double f = d / traceStepM - b, t0 = bestTrace[b], t1 = bestTrace[b + 1];
    const double ref = std::isfinite(t1) ? t0 + (t1 - t0) * f : t0;
    return std::isfinite(ref) ? lastAcceptedT - lapStartT - ref : NAN;
  }

 private:
  bool inLap = false;
  int lapNumber = 0;
  double lapStartT = 0, lastGateT = 0;
  int nextGate = 0;
  bool missedLine = false;
  double splits[MAX_GATES];
  double lapMax = 0;
  bool haveQualityT = false, haveLastS = false;
  double lastQualityT = 0, lastS = 0, lastAcceptedT = 0;
  double heldT[RING_CAP], heldV[RING_CAP], heldS[RING_CAP];
  int heldN = 0;
  double histT[16], histS[16];
  int hHead = 0, hN = 0;
  double trace[MAX_TRACE], bestTrace[MAX_TRACE];
  int traceLastBin = 0;
  double traceLastD = 0, traceLastT = 0;

  void pushHist(double t, double s) {
    // keep oldest sample with t - oldest ≥ baseline and t - second < baseline (mirrors TS shift loop)
    const int cap = 16;
    histT[(hHead + hN) % cap] = t;
    histS[(hHead + hN) % cap] = s;
    if (hN < cap) hN++;
    else hHead = (hHead + 1) % cap;
    while (hN > 2 && t - histT[(hHead + 1) % cap] >= derivedSpeedBaselineS) {
      hHead = (hHead + 1) % cap;
      hN--;
    }
  }

  static void sortCrossings(Crossing* c, int n) {
    for (int a = 1; a < n; a++) {
      Crossing key = c[a];
      int b = a - 1;
      while (b >= 0 && c[b].t > key.t) { c[b + 1] = c[b]; b--; }
      c[b + 1] = key;
    }
  }

  void releaseHeld(double beforeT) {
    int k = 0;
    while (k < heldN && heldT[k] < beforeT) {
      commit(heldT[k], heldV[k], heldS[k]);
      k++;
    }
    if (k > 0) {
      for (int i = k; i < heldN; i++) {
        heldT[i - k] = heldT[i];
        heldV[i - k] = heldV[i];
        heldS[i - k] = heldS[i];
      }
      heldN -= k;
    }
  }

  void commit(double t, double v, double s) {
    if (!inLap || t < lapStartT) return;
    if (std::isfinite(v) && v > lapMax) lapMax = v;
    const Centerline& cl = track->cl;
    const double d = cl.wrap(s - track->gates[0].s);
    const int bin = (int)std::floor(d / traceStepM);
    const double el = t - lapStartT;
    if (d > cl.lengthM / 2 && el < 10) return;
    if (d > traceLastD && bin < MAX_TRACE) {
      for (int b = traceLastBin + 1; b <= bin; b++) {
        const double frac = (b * traceStepM - traceLastD) / (d - traceLastD);
        trace[b] = traceLastT + (el - traceLastT) * frac;
      }
      if (bin > traceLastBin) traceLastBin = bin;
      traceLastD = d;
      traceLastT = el;
    }
  }

  void startLap(double t) {
    inLap = true;
    lapNumber++;
    lapStartT = t;
    lastGateT = t;
    nextGate = track->nGates > 1 ? 1 : 0;
    missedLine = false;
    for (int i = 0; i < MAX_GATES; i++) splits[i] = NAN;
    lapMax = 0;
    for (int i = 0; i < MAX_TRACE; i++) trace[i] = NAN;
    trace[0] = 0;
    traceLastBin = 0;
    traceLastD = 0;
    traceLastT = 0;
    int w = 0;
    for (int k = 0; k < heldN; k++) {
      if (heldT[k] >= t) commit(heldT[k], heldV[k], heldS[k]);
      else {
        heldT[w] = heldT[k];
        heldV[w] = heldV[k];
        heldS[w] = heldS[k];
        w++;
      }
    }
    heldN = w;
  }

  void handle(const Crossing& c, Event* ev, int& ne) {
    releaseHeld(c.t);
    const int nG = track->nGates;
    if (c.gate == 0) {
      if (!inLap) {
        startLap(c.t);
        ev[ne++] = {EventType::LapStart, c.t, lapNumber, 0, 0};
        return;
      }
      const double timeS = c.t - lapStartT;
      if (timeS < minLapS) {
        ev[ne++] = {EventType::RejectedShortLap, c.t, lapNumber, 0, timeS};
        return;
      }
      const bool complete = nextGate == 0 && !missedLine;
      if (complete) splits[nG - 1] = c.t - lastGateT;
      LapRecord& r = laps[lapCount % MAX_LAPS];
      r.number = lapNumber;
      r.startT = lapStartT;
      r.endT = c.t;
      r.timeS = timeS;
      for (int i = 0; i < MAX_GATES; i++) r.splits[i] = i < nG ? splits[i] : NAN;
      r.maxSpeedMs = lapMax;
      r.valid = complete;
      lapCount++;
      if (r.valid && (!haveBest || r.timeS < bestLap.timeS)) {
        bestLap = r;
        haveBest = true;
        std::memcpy(bestTrace, trace, sizeof(trace));
      }
      ev[ne++] = {EventType::Lap, c.t, r.number, 0, timeS};
      startLap(c.t);
      ev[ne++] = {EventType::LapStart, c.t, lapNumber, 0, 0};
      return;
    }
    if (!inLap) {
      ev[ne++] = {EventType::IgnoredBeforeStart, c.t, 0, c.gate, 0};
      return;
    }
    if (c.gate != nextGate) {
      if (nextGate == 0 && c.gate == 1) missedLine = true;
      ev[ne++] = {EventType::RejectedOrder, c.t, lapNumber, c.gate, (double)nextGate};
      return;
    }
    const double split = c.t - lastGateT;
    splits[c.gate - 1] = split;
    lastGateT = c.t;
    nextGate = (c.gate + 1) % nG;
    ev[ne++] = {EventType::Sector, c.t, lapNumber, c.gate - 1, split};
  }
};

}  // namespace apex
