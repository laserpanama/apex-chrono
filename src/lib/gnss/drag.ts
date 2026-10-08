/**
 * Drag / acceleration timing — the reference engine for "performance" runs
 * (0-100 km/h, 0-60 mph, 60 ft, 1/8 and 1/4 mile, 100-200 km/h).
 *
 * Independent of the lap engine and of any track: it consumes only the
 * receiver's Doppler ground speed and the GNSS clock, so it runs anywhere,
 * alongside lap timing, without a track loaded. The C++ port
 * (firmware/lib/apex_drag/DragEngine.h) must reproduce this file's results
 * (parity fixtures: `npm run firmware:fixtures`, checked by
 * firmware/test_host/drag_parity.cpp). Change the arithmetic in both places
 * or in neither.
 *
 * Model (docs/DRAG_MODE.md):
 *  - ARM: speed below `armKmh` for `armHoldS` of GNSS time with good quality.
 *  - LAUNCH: first armed fix at/above `launchKmh`. The start instant t0 is
 *    the zero-speed intercept of a least-squares line through the fix
 *    before launch and every fix up to `fitKmh` (≈ 0.1–0.4 s), bounded by
 *    the weakest plausible launch (`launchMinAccelMs2`) and by the start of
 *    the standstill. Targets are reported once t0 is known.
 *  - Between fixes speed is linear in time (constant acceleration), so the
 *    distance is the trapezoid of the two Doppler speeds and every target is
 *    interpolated inside its interval: speed targets linearly, distance
 *    targets by solving d = dp + vp·τ + a·τ²/2 — exact for constant
 *    acceleration, independent of the fix rate.
 *  - Rollout (optional, drag-strip style): times are measured from the
 *    instant the car has covered `rolloutM` (0.3048 m = 1 ft) instead of t0.
 *  - END: speed falls `endDropKmh` below the run's peak, the car stops, or
 *    `maxRunS` passes. A GNSS gap or missing speed ends the run as invalid;
 *    a bad-quality fix marks it invalid. Results are never invented: a
 *    target not reached is NaN.
 */

export type DragSample = {
  /** GNSS seconds (contract timestamp_ms / 1000) */
  t: number;
  /** Doppler ground speed, m/s; NaN = not reported */
  speedMs: number;
  sats: number;
  hdop: number;
  /** -1 unknown, 0 no fix, ≥ 1 fix (GGA quality) */
  fixType: number;
  /** metres; NaN = not reported */
  altM: number;
};

export type DragConfig = {
  armKmh: number;
  armHoldS: number;
  launchKmh: number;
  /** first moving fix faster than this ⇒ the launch was missed (late_launch) */
  maxLaunchKmh: number;
  /** lower bound on launch acceleration used to bound t0 extrapolation, m/s² */
  launchMinAccelMs2: number;
  /** the launch line is fitted through the fixes up to this speed */
  fitKmh: number;
  maxGapS: number;
  minSats: number;
  maxHdop: number;
  endDropKmh: number;
  maxRunS: number;
  /** 0 = time from t0 (standing start); 0.3048 = 1 ft rollout */
  rolloutM: number;
  speedTargetsKmh: number[];
  distanceTargetsM: number[];
  /** [fromKmh, toKmh] pairs; both ends must be in speedTargetsKmh */
  rangesKmh: [number, number][];
};

export const MPH = 1.609344;
export const FT = 0.3048;

export const DEFAULT_DRAG: DragConfig = {
  armKmh: 1.5,
  armHoldS: 1.0,
  launchKmh: 3.0,
  maxLaunchKmh: 20,
  launchMinAccelMs2: 0.5,
  fitKmh: 12,
  maxGapS: 0.25,
  minSats: 6,
  maxHdop: 2.5,
  endDropKmh: 10,
  maxRunS: 60,
  rolloutM: 0,
  speedTargetsKmh: [60, 60 * MPH, 100, 150, 200],
  distanceTargetsM: [60 * FT, 660 * FT, 1320 * FT],
  rangesKmh: [[100, 200]],
};

/** Labels for the default targets (UI / CLI). */
export function speedLabel(kmh: number): string {
  if (Math.abs(kmh - 60 * MPH) < 1e-9) return "0-60 mph";
  return `0-${kmh} km/h`;
}
export function distanceLabel(m: number): string {
  if (Math.abs(m - 60 * FT) < 1e-9) return "60 ft";
  if (Math.abs(m - 660 * FT) < 1e-9) return "1/8 mile";
  if (Math.abs(m - 1320 * FT) < 1e-9) return "1/4 mile";
  return `${m} m`;
}

export const DragFlag = {
  gap: 1,
  noSpeed: 2,
  quality: 4,
  lateLaunch: 8,
} as const;

export type DragEndReason = "lift" | "stopped" | "timeout" | "gap" | "no_speed" | "flush";

export type DragRun = {
  number: number;
  valid: boolean;
  /** bitmask of DragFlag */
  flags: number;
  endReason: DragEndReason;
  /** GNSS seconds: extrapolated zero-speed instant */
  t0: number;
  /** GNSS seconds the reported times count from (t0, or rollout crossing); NaN if rollout never reached */
  tStart: number;
  /** seconds from tStart, per config.speedTargetsKmh; NaN = not reached */
  speedTimesS: number[];
  /** seconds from tStart, per config.distanceTargetsM */
  distanceTimesS: number[];
  /** km/h at each distance target ("trap speed") */
  trapKmh: number[];
  /** seconds, per config.rangesKmh */
  rangeTimesS: number[];
  peakKmh: number;
  distanceM: number;
  /** last fix time − tStart */
  durationS: number;
  /** grade over the longest distance target reached, % (+ = uphill); NaN without altitude */
  slopePct: number;
};

export type DragEvent =
  | { type: "armed"; t: number }
  | { type: "launch"; t: number; t0: number }
  | { type: "speed"; t: number; index: number; timeS: number }
  | { type: "distance"; t: number; index: number; timeS: number; trapKmh: number }
  | { type: "end"; t: number; run: DragRun };

export type DragState = "idle" | "armed" | "running";

type Pt = { t: number; v: number; alt: number };

type Running = {
  /** NaN while the launch line is still being fitted */
  t0: number;
  tStart: number; // NaN until t0 is known and rollout reached (== t0 when rolloutM = 0)
  flags: number;
  /** launch window: the fix before launch + following fixes up to fitKmh */
  fit: Pt[];
  // absolute GNSS times of each crossing (NaN = not yet)
  speedT: number[];
  distT: number[];
  trapKmh: number[];
  peakMs: number;
  d: number;
  alt0: number;
  altAtDist: number[];
  /** end of the last integrated interval */
  tLast: number;
};

const KMH = 3.6;
/** launch-window cap (fixes): 1 s at 25 Hz */
export const MAX_FIT = 25;

export class DragEngine {
  readonly cfg: DragConfig;
  readonly runs: DragRun[] = [];
  state: DragState = "idle";
  /** samples ignored because their time did not advance */
  rejectedTime = 0;

  private prevT = NaN;
  private prevV = NaN;
  private prevAlt = NaN;
  private stillSince = NaN;
  private run: Running | null = null;
  private lastT = NaN;

  constructor(cfg: Partial<DragConfig> = {}) {
    this.cfg = { ...DEFAULT_DRAG, ...cfg };
    for (const [lo, hi] of this.cfg.rangesKmh) {
      if (!this.cfg.speedTargetsKmh.includes(lo) || !this.cfg.speedTargetsKmh.includes(hi))
        throw new Error(`range ${lo}-${hi} km/h: both ends must be speed targets`);
    }
  }

  /** Seconds since tStart while running (live display); NaN otherwise. */
  elapsedS(): number {
    if (!this.run || !Number.isFinite(this.run.tStart)) return NaN;
    return this.lastT - this.run.tStart;
  }

  get lastRun(): DragRun | undefined {
    return this.runs[this.runs.length - 1];
  }

  push(s: DragSample): DragEvent[] {
    const out: DragEvent[] = [];
    const c = this.cfg;
    if (!Number.isFinite(s.t) || (Number.isFinite(this.prevT) && !(s.t > this.prevT))) {
      this.rejectedTime++;
      return out;
    }
    const v = s.speedMs;
    const haveV = Number.isFinite(v);
    const goodQ = s.fixType !== 0 && s.sats >= c.minSats && s.hdop <= c.maxHdop;
    const dt = Number.isFinite(this.prevT) ? s.t - this.prevT : NaN;
    const gap = Number.isFinite(dt) && dt > c.maxGapS;
    this.lastT = s.t;

    if (this.run) {
      const r = this.run;
      if (gap) this.finish(out, s.t, "gap", DragFlag.gap);
      else if (!haveV) this.finish(out, s.t, "no_speed", DragFlag.noSpeed);
      else {
        if (!goodQ) r.flags |= DragFlag.quality;
        const vk = v * KMH;
        if (!Number.isFinite(r.t0)) {
          r.fit.push({ t: s.t, v, alt: s.altM });
          if (vk >= c.fitKmh || r.fit.length >= MAX_FIT) this.resolveLaunch(out);
        } else this.segment(out, this.prevT, this.prevV, s.t, v, s.altM);
        if (v > r.peakMs) r.peakMs = v;
        if (vk < c.armKmh) this.finish(out, s.t, "stopped", 0);
        else if (vk < r.peakMs * KMH - c.endDropKmh) this.finish(out, s.t, "lift", 0);
        else if (s.t - r.t0 > c.maxRunS) this.finish(out, s.t, "timeout", 0);
      }
      // after a run the car must stop again (from this fix on) to re-arm
      if (!this.run) this.stillSince = haveV && goodQ && v * KMH < c.armKmh ? s.t : NaN;
    } else if (!haveV || !goodQ || gap) {
      this.state = "idle";
      this.stillSince = haveV && goodQ && v * KMH < c.armKmh ? s.t : NaN;
    } else {
      const vk = v * KMH;
      if (vk < c.armKmh) {
        if (!Number.isFinite(this.stillSince)) this.stillSince = s.t;
        if (this.state === "idle" && s.t - this.stillSince >= c.armHoldS) {
          this.state = "armed";
          out.push({ type: "armed", t: s.t });
        }
      } else if (this.state === "armed" && vk >= c.launchKmh) {
        this.launch(out, s, vk, goodQ);
      } else if (this.state !== "armed") {
        this.stillSince = NaN; // moving and not armed
      }
      // armed and creeping below launchKmh: stay armed
    }

    this.prevT = s.t;
    this.prevV = haveV ? v : NaN;
    this.prevAlt = s.altM;
    return out;
  }

  /** End an in-progress run (e.g. end of a recording). */
  flush(): DragEvent[] {
    const out: DragEvent[] = [];
    if (this.run) this.finish(out, this.lastT, "flush", 0);
    return out;
  }

  private launch(out: DragEvent[], s: DragSample, vk: number, goodQ: boolean) {
    const c = this.cfg;
    const nS = c.speedTargetsKmh.length;
    const nD = c.distanceTargetsM.length;
    this.run = {
      t0: NaN,
      tStart: NaN,
      flags: (vk > c.maxLaunchKmh ? DragFlag.lateLaunch : 0) | (goodQ ? 0 : DragFlag.quality),
      fit: [
        { t: this.prevT, v: this.prevV, alt: this.prevAlt },
        { t: s.t, v: s.speedMs, alt: s.altM },
      ],
      speedT: new Array<number>(nS).fill(NaN),
      distT: new Array<number>(nD).fill(NaN),
      trapKmh: new Array<number>(nD).fill(NaN),
      peakMs: s.speedMs > this.prevV ? s.speedMs : this.prevV,
      d: 0,
      alt0: this.prevAlt,
      altAtDist: new Array<number>(nD).fill(NaN),
      tLast: NaN,
    };
    this.state = "running";
    if (vk >= c.fitKmh) this.resolveLaunch(out);
  }

  /**
   * t0 = zero-speed intercept of the least-squares line v(t) through the
   * launch window (the fix before launch and every fix up to fitKmh). The
   * line is bounded by the weakest plausible launch and by the standstill
   * start, then the window is integrated from t0.
   */
  private resolveLaunch(out: DragEvent[]) {
    const r = this.run!;
    const c = this.cfg;
    const f = r.fit;
    const n = f.length;
    const last = f[n - 1];
    const ref = f[0].t;
    let tm = 0;
    let vm = 0;
    for (let i = 0; i < n; i++) {
      tm += f[i].t - ref;
      vm += f[i].v;
    }
    tm /= n;
    vm /= n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      const dx = f[i].t - ref - tm;
      sxy += dx * (f[i].v - vm);
      sxx += dx * dx;
    }
    let t0 = f[0].t;
    if (sxx > 0 && sxy > 0) {
      t0 = ref + tm - (vm * sxx) / sxy;
      const lo = last.t - last.v / c.launchMinAccelMs2;
      if (t0 < lo) t0 = lo;
      if (t0 < this.stillSince) t0 = this.stillSince;
      if (t0 > f[0].t) t0 = f[0].t;
    }
    r.t0 = t0;
    r.tLast = t0;
    if (c.rolloutM <= 0) r.tStart = t0;
    out.push({ type: "launch", t: last.t, t0 });
    // t0 → first window fix: speed rises linearly from 0, then fix to fix
    this.segment(out, t0, 0, f[0].t, f[0].v, f[0].alt);
    for (let i = 1; i < n; i++) this.segment(out, f[i - 1].t, f[i - 1].v, f[i].t, f[i].v, f[i].alt);
    r.fit = [];
  }

  /** Integrate one constant-acceleration interval and emit the targets crossed in it. */
  private segment(out: DragEvent[], tp: number, vp: number, t: number, v: number, altM: number) {
    const r = this.run!;
    const c = this.cfg;
    const dt = t - tp;
    if (!(dt > 0)) return;
    const a = (v - vp) / dt;
    const dp = r.d;
    const d = dp + ((vp + v) / 2) * dt;
    // crossing time of distance D inside this interval
    const crossD = (D: number) => {
      const rem = D - dp;
      let tau: number;
      if (Math.abs(a) < 1e-9) tau = vp > 0 ? rem / vp : dt;
      else {
        let disc = vp * vp + 2 * a * rem;
        if (disc < 0) disc = 0;
        tau = (Math.sqrt(disc) - vp) / a;
      }
      if (!(tau >= 0)) tau = 0;
      if (tau > dt) tau = dt;
      return tau;
    };

    if (!Number.isFinite(r.tStart) && d >= c.rolloutM) {
      r.tStart = tp + crossD(c.rolloutM);
      // speed targets already crossed before rollout keep their absolute time
    }
    for (let k = 0; k < c.speedTargetsKmh.length; k++) {
      if (Number.isFinite(r.speedT[k])) continue;
      const target = c.speedTargetsKmh[k] / KMH;
      if (v >= target) {
        r.speedT[k] = vp >= target ? tp : tp + ((target - vp) / (v - vp)) * dt;
        if (Number.isFinite(r.tStart))
          out.push({ type: "speed", t, index: k, timeS: r.speedT[k] - r.tStart });
      }
    }
    for (let k = 0; k < c.distanceTargetsM.length; k++) {
      if (Number.isFinite(r.distT[k])) continue;
      const D = c.distanceTargetsM[k];
      if (d >= D) {
        const tau = crossD(D);
        r.distT[k] = tp + tau;
        r.trapKmh[k] = (vp + a * tau) * KMH;
        r.altAtDist[k] = altM;
        if (Number.isFinite(r.tStart))
          out.push({
            type: "distance",
            t,
            index: k,
            timeS: r.distT[k] - r.tStart,
            trapKmh: r.trapKmh[k],
          });
      }
    }
    r.d = d;
    r.tLast = t;
  }

  private finish(out: DragEvent[], t: number, reason: DragEndReason, flag: number) {
    const r = this.run!;
    const c = this.cfg;
    if (!Number.isFinite(r.t0)) this.resolveLaunch(out);
    r.flags |= flag;
    const rel = (x: number) =>
      Number.isFinite(x) && Number.isFinite(r.tStart) ? x - r.tStart : NaN;
    const speedTimesS = r.speedT.map(rel);
    const rangeTimesS = c.rangesKmh.map(([lo, hi]) => {
      const a = r.speedT[c.speedTargetsKmh.indexOf(lo)];
      const b = r.speedT[c.speedTargetsKmh.indexOf(hi)];
      return Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN;
    });
    let slopePct = NaN;
    for (let k = c.distanceTargetsM.length - 1; k >= 0; k--) {
      if (Number.isFinite(r.distT[k])) {
        if (Number.isFinite(r.alt0) && Number.isFinite(r.altAtDist[k]))
          slopePct = ((r.altAtDist[k] - r.alt0) / c.distanceTargetsM[k]) * 100;
        break;
      }
    }
    const run: DragRun = {
      number: this.runs.length + 1,
      valid: r.flags === 0,
      flags: r.flags,
      endReason: reason,
      t0: r.t0,
      tStart: r.tStart,
      speedTimesS,
      distanceTimesS: r.distT.map(rel),
      trapKmh: r.trapKmh.slice(),
      rangeTimesS,
      peakKmh: r.peakMs * KMH,
      distanceM: r.d,
      durationS: rel(r.tLast),
      slopePct,
    };
    this.runs.push(run);
    this.run = null;
    this.state = "idle";
    out.push({ type: "end", t, run });
  }
}

/** Contract row (recording.ts) → drag sample. Same conversion the firmware uses. */
export function rowToDragSample(r: {
  timestampMs: number;
  speedKmh: number | null;
  satellites: number;
  hdop: number;
  fixQuality: number | null;
  altitudeM: number | null;
}): DragSample {
  return {
    t: r.timestampMs / 1000,
    speedMs: r.speedKmh === null ? NaN : r.speedKmh / 3.6,
    sats: r.satellites,
    hdop: Number.isFinite(r.hdop) ? r.hdop : 99.9,
    fixType: r.fixQuality === null ? -1 : r.fixQuality,
    altM: r.altitudeM === null ? NaN : r.altitudeM,
  };
}

export function flagNames(flags: number): string[] {
  const n: string[] = [];
  if (flags & DragFlag.gap) n.push("gap");
  if (flags & DragFlag.noSpeed) n.push("no_speed");
  if (flags & DragFlag.quality) n.push("quality");
  if (flags & DragFlag.lateLaunch) n.push("late_launch");
  return n;
}
