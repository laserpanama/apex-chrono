/**
 * Circuit centerline + GNSS map matching.
 *
 * The centerline is stored as flat typed arrays (struct-of-arrays) so the
 * same layout maps 1:1 onto fixed-size C arrays on the ESP32-S3. A
 * centerline is a closed loop in the direction of travel; distance along
 * it (`s`) runs from 0 at the first vertex to `lengthM`, then wraps.
 */

import type { LocalPoint } from "./geo.ts";

export type SegmentProjection = {
  /** clamped parameter along the segment, 0 = a, 1 = b */
  t: number;
  x: number;
  y: number;
  dist2: number;
};

/** Project point P onto segment AB (clamped). */
export function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): SegmentProjection {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = ax + dx * t;
  const y = ay + dy * t;
  const ex = px - x;
  const ey = py - y;
  return { t, x, y, dist2: ex * ex + ey * ey };
}

export class Centerline {
  /** number of segments */
  readonly n: number;
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  /** unit tangent */
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly len: Float64Array;
  /** cumulative distance at segment start */
  readonly cum: Float64Array;
  readonly lengthM: number;

  constructor(points: LocalPoint[]) {
    const pts: LocalPoint[] = [];
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
        throw new Error("centerline point not finite");
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
      pts.push({ x: p.x, y: p.y });
    }
    // Closed loop: drop an explicit closing vertex, the wrap segment is implicit.
    if (pts.length > 1) {
      const f = pts[0];
      const l = pts[pts.length - 1];
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) pts.pop();
    }
    if (pts.length < 3) throw new Error("centerline needs at least 3 distinct points");
    const n = pts.length;
    this.n = n;
    this.ax = new Float64Array(n);
    this.ay = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.ty = new Float64Array(n);
    this.len = new Float64Array(n);
    this.cum = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      this.ax[i] = a.x;
      this.ay[i] = a.y;
      this.tx[i] = dx / L;
      this.ty[i] = dy / L;
      this.len[i] = L;
      this.cum[i] = acc;
      acc += L;
    }
    this.cum[n] = acc;
    this.lengthM = acc;
  }

  /** Wrap any distance into [0, lengthM). */
  wrap(s: number): number {
    const L = this.lengthM;
    const r = s % L;
    return r < 0 ? r + L : r;
  }

  /**
   * Signed shortest along-track difference `to - from`, in (-L/2, L/2].
   * Positive means `to` lies ahead of `from` in the direction of travel.
   */
  delta(to: number, from: number): number {
    const L = this.lengthM;
    let d = (to - from) % L;
    if (d > L / 2) d -= L;
    else if (d <= -L / 2) d += L;
    return d;
  }

  /** Segment index containing distance s (binary search). */
  segmentAt(s: number): number {
    const d = this.wrap(s);
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Point and unit tangent at distance s. */
  pointAt(s: number): { x: number; y: number; tx: number; ty: number; seg: number } {
    const d = this.wrap(s);
    const i = this.segmentAt(d);
    const u = d - this.cum[i];
    return {
      x: this.ax[i] + this.tx[i] * u,
      y: this.ay[i] + this.ty[i] * u,
      tx: this.tx[i],
      ty: this.ty[i],
      seg: i,
    };
  }

  /** Project onto one segment; returns s and signed cross-track (left of travel = +). */
  projectOnSegment(i: number, px: number, py: number): { s: number; e: number; dist2: number } {
    const ax = this.ax[i];
    const ay = this.ay[i];
    const L = this.len[i];
    const pr = projectPointToSegment(px, py, ax, ay, ax + this.tx[i] * L, ay + this.ty[i] * L);
    // left normal = (-ty, tx)
    const e = (px - pr.x) * -this.ty[i] + (py - pr.y) * this.tx[i];
    const sign = e >= 0 ? 1 : -1;
    return { s: this.cum[i] + pr.t * L, e: sign * Math.sqrt(pr.dist2), dist2: pr.dist2 };
  }
}

export type MatchResult = {
  /** distance along centerline, [0, L) */
  s: number;
  /** signed cross-track error, + = left of direction of travel */
  crossTrackM: number;
  seg: number;
  fullScan: boolean;
};

export type MapMatcherConfig = {
  /** segments searched each side of the predicted segment */
  windowSegments: number;
  /** if the windowed best match is further than this, do a full scan */
  fallbackDistanceM: number;
};

export const DEFAULT_MATCHER_CONFIG: MapMatcherConfig = {
  windowSegments: 16,
  fallbackDistanceM: 30,
};

/**
 * Nearest-segment map matcher with a local search window.
 *
 * Normal operation searches ±windowSegments around the last (or predicted)
 * segment, which keeps the cost O(window) per fix and stops the match from
 * jumping to a parallel straight or the other leg of a hairpin. If there is
 * no history, or the windowed result is implausibly far from the line, it
 * falls back to a full O(n) scan.
 */
export class MapMatcher {
  readonly cl: Centerline;
  readonly cfg: MapMatcherConfig;
  private lastSeg = -1;
  fullScans = 0;
  windowed = 0;

  constructor(cl: Centerline, cfg: Partial<MapMatcherConfig> = {}) {
    this.cl = cl;
    this.cfg = { ...DEFAULT_MATCHER_CONFIG, ...cfg };
  }

  reset(): void {
    this.lastSeg = -1;
  }

  private scan(px: number, py: number, from: number, count: number) {
    const n = this.cl.n;
    let best = { s: 0, e: 0, dist2: Infinity };
    let bestSeg = -1;
    for (let k = 0; k < count; k++) {
      const i = (((from + k) % n) + n) % n;
      const r = this.cl.projectOnSegment(i, px, py);
      if (r.dist2 < best.dist2) {
        best = r;
        bestSeg = i;
      }
    }
    return { best, bestSeg };
  }

  /**
   * @param predictedS optional dead-reckoned distance (e.g. last s + v·dt);
   *                   centres the search window when available.
   */
  match(px: number, py: number, predictedS?: number): MatchResult {
    const n = this.cl.n;
    const W = this.cfg.windowSegments;
    const fallback2 = this.cfg.fallbackDistanceM * this.cfg.fallbackDistanceM;
    let center = this.lastSeg;
    if (predictedS !== undefined && Number.isFinite(predictedS) && this.lastSeg >= 0) {
      center = this.cl.segmentAt(predictedS);
    }
    if (center >= 0 && 2 * W + 1 < n) {
      const { best, bestSeg } = this.scan(px, py, center - W, 2 * W + 1);
      if (best.dist2 <= fallback2) {
        this.windowed++;
        this.lastSeg = bestSeg;
        return { s: this.cl.wrap(best.s), crossTrackM: best.e, seg: bestSeg, fullScan: false };
      }
    }
    this.fullScans++;
    const { best, bestSeg } = this.scan(px, py, 0, n);
    // Only commit the history when the full-scan answer is itself plausible;
    // a single wild fix must not drag the window to the wrong part of the lap.
    if (best.dist2 <= fallback2 || this.lastSeg < 0) this.lastSeg = bestSeg;
    return { s: this.cl.wrap(best.s), crossTrackM: best.e, seg: bestSeg, fullScan: true };
  }
}
