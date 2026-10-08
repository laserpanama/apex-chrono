/**
 * GNSS fix types, quality filtering and a fixed-capacity fix history.
 */

export type GnssFix = {
  /** GNSS time of the fix in seconds (e.g. UTC seconds-of-day or GPS TOW). Never wall/frame time. */
  t: number;
  lat: number;
  lon: number;
  /** Doppler ground speed, m/s (NMEA RMC/VTG speed, u-blox gSpeed). Optional. */
  speedMs?: number;
  /** Course over ground, degrees true. Optional. */
  courseDeg?: number;
  sats: number;
  hdop: number;
  /** 0 = no fix, 2 = 2D, 3 = 3D. Optional; if present must be ≥ 2. */
  fixType?: number;
};

export type QualityConfig = {
  minSats: number;
  maxHdop: number;
  /** fixes further than this from the centerline are discarded (off-track / mismatched) */
  maxCrossTrackM: number;
};

export const DEFAULT_QUALITY: QualityConfig = {
  minSats: 6,
  maxHdop: 2.5,
  maxCrossTrackM: 25,
};

export type QualityVerdict = "ok" | "no_fix" | "sats" | "hdop" | "not_finite" | "time";

export function checkFixQuality(
  f: GnssFix,
  cfg: QualityConfig,
  lastT: number | null,
): QualityVerdict {
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || !Number.isFinite(f.t))
    return "not_finite";
  if (Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180) return "not_finite";
  if (f.fixType !== undefined && f.fixType < 2) return "no_fix";
  if (!(f.sats >= cfg.minSats)) return "sats";
  if (!(f.hdop <= cfg.maxHdop)) return "hdop";
  if (lastT !== null && !(f.t > lastT)) return "time";
  return "ok";
}

/** A quality-checked, map-matched fix. NaN = not reported. */
export type MatchedFix = {
  seq: number;
  t: number;
  x: number;
  y: number;
  s: number;
  e: number;
  speedMs: number;
  courseDeg: number;
};

/**
 * Fixed-capacity ring of matched fixes, struct-of-arrays. Same shape as the
 * C ring buffer on the ESP32 (no allocation per fix).
 */
export class FixRing {
  readonly cap: number;
  readonly t: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly s: Float64Array;
  readonly e: Float64Array;
  readonly v: Float64Array;
  readonly c: Float64Array;
  /** seq of the next fix to be written */
  nextSeq = 0;
  count = 0;

  constructor(cap = 64) {
    this.cap = cap;
    this.t = new Float64Array(cap);
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.s = new Float64Array(cap);
    this.e = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.c = new Float64Array(cap);
  }

  push(f: Omit<MatchedFix, "seq">): number {
    const seq = this.nextSeq++;
    const i = seq % this.cap;
    this.t[i] = f.t;
    this.x[i] = f.x;
    this.y[i] = f.y;
    this.s[i] = f.s;
    this.e[i] = f.e;
    this.v[i] = f.speedMs;
    this.c[i] = f.courseDeg;
    if (this.count < this.cap) this.count++;
    return seq;
  }

  oldestSeq(): number {
    return this.nextSeq - this.count;
  }

  has(seq: number): boolean {
    return seq >= this.oldestSeq() && seq < this.nextSeq;
  }

  /** ring slot for a seq that `has()` */
  slot(seq: number): number {
    return seq % this.cap;
  }

  clear(): void {
    this.count = 0;
  }
}
