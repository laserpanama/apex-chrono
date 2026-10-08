/**
 * Geographic gate crossing detection.
 *
 * Detection runs on the map-matched centerline distance `s`, so lateral GNSS
 * noise does not create or destroy crossings; only along-track noise matters.
 * Each gate has a small state machine:
 *
 *   IDLE ──fix in approach zone──▶ APPROACH ──fix past gate──▶ PENDING
 *     ▲                                                          │ K fixes later:
 *     └──── |s - gate| > rearmDistance ◀── DISARMED ◀──accept────┘ refine + validate
 *
 * A crossing is only *accepted* after K post-crossing fixes have arrived.
 * The crossing time is then refined from the ±K fixes around the gate:
 *   - with Doppler speed: integrate speed into a path-distance curve D(t),
 *     estimate the along-track offset as the mean of (s_i − D_i) (this
 *     averages position noise over 2K fixes), then solve s(t) = gate.s on
 *     the speed-integrated curve (exact under acceleration);
 *   - without speed: least-squares line s(t) through the window.
 * Validation (speed, movement, direction, lateral position inside the gate)
 * is done on the same window, so a single noisy fix cannot reject or create
 * a crossing.
 */

import { courseToUnit } from "./geo.ts";
import { FixRing, type MatchedFix } from "./fix.ts";
import type { CompiledTrack } from "./track.ts";

export type GateConfig = {
  /** fixes before AND after the crossing used to refine/validate it (low noise) */
  refineFixes: number;
  /**
   * Upper bound for the adaptive window. When the along-track noise measured
   * around the gate exceeds `noiseRefM`, the window grows ∝ noise (more
   * averaging) up to this many fixes each side. Short windows have less model
   * bias; long windows have less noise — this picks per crossing.
   */
  refineFixesMax: number;
  noiseRefM: number;
  /** start of the approach zone before a gate, metres along track */
  approachM: number;
  /** gate re-arms once the car is this far (along track) from it */
  rearmDistanceM: number;
  /** min time between two accepted crossings of the same gate */
  cooldownS: number;
  /** max time between the last fix before and first fix after the gate */
  maxGapS: number;
  /** min ground speed at the crossing */
  minSpeedMs: number;
  /** min straight-line movement across the refinement window */
  minMoveM: number;
  /** max angle between travel direction and the gate's forward direction */
  maxHeadingErrorDeg: number;
  /** extra lateral tolerance beyond the gate half-width */
  lateralMarginM: number;
  /** finalize a pending crossing after this long even without K post fixes */
  pendingTimeoutS: number;
  /** accepted range for the fitted centerline/path-length ratio (Doppler mode) */
  minScale: number;
  maxScale: number;
};

export const DEFAULT_GATE_CONFIG: GateConfig = {
  refineFixes: 10,
  refineFixesMax: 30,
  noiseRefM: 2.5,
  approachM: 60,
  rearmDistanceM: 80,
  cooldownS: 5,
  maxGapS: 1.0,
  minSpeedMs: 4,
  minMoveM: 2,
  maxHeadingErrorDeg: 60,
  lateralMarginM: 5,
  pendingTimeoutS: 4.5,
  minScale: 0.8,
  maxScale: 1.2,
};

export type GateCrossing = {
  gate: number;
  /** refined crossing time, GNSS seconds */
  t: number;
  /** first-pass time from the two straddling fixes */
  tPrelim: number;
  speedMs: number;
  lateralM: number;
  headingErrDeg: number;
  method: "doppler" | "position";
  nFixes: number;
  /** along-track noise estimated around the gate, metres (1σ) */
  noiseEstM: number;
};

export type GateRejectReason =
  | "gap"
  | "cooldown"
  | "slow"
  | "no_movement"
  | "wrong_direction"
  | "outside_gate"
  | "no_progress"
  | "too_few_fixes";

const IDLE = 0;
const APPROACH = 1;
const PENDING = 2;
const DISARMED = 3;

export class GateDetector {
  readonly track: CompiledTrack;
  readonly cfg: GateConfig;
  readonly ring: FixRing;
  private state: Int8Array;
  private lastBeforeSeq: Float64Array;
  private pendingSeq: Float64Array;
  private pendingT: Float64Array;
  private pendingK: Float64Array;
  private pendingNoise: Float64Array;
  private lastAcceptT: Float64Array;
  rejections: Record<GateRejectReason, number> = {
    gap: 0,
    cooldown: 0,
    slow: 0,
    no_movement: 0,
    wrong_direction: 0,
    outside_gate: 0,
    no_progress: 0,
    too_few_fixes: 0,
  };
  lastRejection: { gate: number; reason: GateRejectReason; t: number } | null = null;

  constructor(track: CompiledTrack, cfg: Partial<GateConfig> = {}) {
    this.track = track;
    this.cfg = { ...DEFAULT_GATE_CONFIG, ...cfg };
    const n = track.gates.length;
    // Ring must hold the approach fix plus K before and K after.
    this.ring = new FixRing(
      Math.max(32, 4 * Math.max(this.cfg.refineFixes, this.cfg.refineFixesMax) + 8),
    );
    this.state = new Int8Array(n);
    this.lastBeforeSeq = new Float64Array(n).fill(-1);
    this.pendingSeq = new Float64Array(n).fill(-1);
    this.pendingT = new Float64Array(n);
    this.pendingK = new Float64Array(n);
    this.pendingNoise = new Float64Array(n);
    this.lastAcceptT = new Float64Array(n).fill(-Infinity);
  }

  reset(): void {
    this.ring.clear();
    this.state.fill(IDLE);
    this.lastBeforeSeq.fill(-1);
    this.pendingSeq.fill(-1);
    this.lastAcceptT.fill(-Infinity);
  }

  hasPending(): boolean {
    for (let g = 0; g < this.state.length; g++) if (this.state[g] === PENDING) return true;
    return false;
  }

  /** Earliest preliminary time among pending crossings (Infinity if none). */
  earliestPendingT(): number {
    let t = Infinity;
    for (let g = 0; g < this.state.length; g++) {
      if (this.state[g] === PENDING && this.pendingT[g] < t) t = this.pendingT[g];
    }
    return t;
  }

  private reject(g: number, reason: GateRejectReason, t: number) {
    this.rejections[reason]++;
    this.lastRejection = { gate: g, reason, t };
  }

  /** Feed a quality-checked, map-matched fix. Returns crossings accepted on this fix. */
  push(f: Omit<MatchedFix, "seq">): GateCrossing[] {
    const seq = this.ring.push(f);
    const cl = this.track.centerline;
    const cfg = this.cfg;
    const out: GateCrossing[] = [];
    for (let g = 0; g < this.track.gates.length; g++) {
      const gate = this.track.gates[g];
      const rel = cl.delta(f.s, gate.s);
      let st = this.state[g];
      if (st === PENDING) continue;
      if (st === DISARMED) {
        if (Math.abs(rel) > cfg.rearmDistanceM) st = IDLE;
        else continue;
      }
      if (rel >= -cfg.approachM && rel < 0) {
        st = APPROACH;
        this.lastBeforeSeq[g] = seq;
      } else if (rel >= 0 && rel <= cfg.approachM && st === APPROACH) {
        const bSeq = this.lastBeforeSeq[g];
        if (!this.ring.has(bSeq)) {
          st = IDLE;
        } else {
          const b = this.ring.slot(bSeq);
          const tb = this.ring.t[b];
          const relB = cl.delta(this.ring.s[b], gate.s);
          const frac = -relB / (rel - relB);
          const tPre = tb + frac * (f.t - tb);
          if (f.t - tb > cfg.maxGapS) {
            this.reject(g, "gap", tPre);
            st = IDLE;
          } else if (tPre - this.lastAcceptT[g] < cfg.cooldownS) {
            this.reject(g, "cooldown", tPre);
            st = DISARMED;
          } else {
            st = PENDING;
            this.pendingSeq[g] = seq;
            this.pendingT[g] = tPre;
            this.pendingK[g] = 0;
          }
        }
      } else {
        st = IDLE;
      }
      this.state[g] = st;
    }
    // Finalize pending crossings that have enough post-crossing fixes.
    for (let g = 0; g < this.track.gates.length; g++) {
      if (this.state[g] !== PENDING) continue;
      const after = seq - this.pendingSeq[g] + 1;
      const timedOut = f.t - this.pendingT[g] > cfg.pendingTimeoutS;
      if (after < cfg.refineFixes && !timedOut) continue;
      if (this.pendingK[g] === 0) {
        const noise = this.estimateNoise(g, cfg.refineFixes);
        this.pendingNoise[g] = noise;
        const want = Math.round(cfg.refineFixes * Math.max(1, noise / cfg.noiseRefM));
        this.pendingK[g] = Math.max(cfg.refineFixes, Math.min(cfg.refineFixesMax, want));
      }
      if (after >= this.pendingK[g] || timedOut) {
        const c = this.finalize(g);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /**
   * Along-track noise (1σ, metres) from second differences of s around the
   * gate: for fixes at a steady rate, Δ²s ≈ a·dt² + noise·√6, and the
   * acceleration term is negligible at 10 Hz. Model-free, so it works with or
   * without Doppler.
   */
  private estimateNoise(g: number, K: number): number {
    const ring = this.ring;
    const cl = this.track.centerline;
    const gate = this.track.gates[g];
    const c = this.pendingSeq[g];
    const lo = Math.max(ring.oldestSeq(), c - K);
    const hi = Math.min(ring.nextSeq - 1, c + K - 1);
    let sum = 0;
    let n = 0;
    for (let q = lo + 2; q <= hi; q++) {
      const a = ring.slot(q - 2);
      const b = ring.slot(q - 1);
      const d = ring.slot(q);
      const ra = cl.delta(ring.s[a], gate.s);
      const rb = cl.delta(ring.s[b], gate.s);
      const rd = cl.delta(ring.s[d], gate.s);
      const d2 = rd - 2 * rb + ra;
      if (Math.abs(d2) > 100) continue;
      sum += d2 * d2;
      n++;
    }
    return n ? Math.sqrt(sum / n / 6) : 0;
  }

  /** Finalize all pending crossings (end of session / data gap). */
  flush(): GateCrossing[] {
    const out: GateCrossing[] = [];
    for (let g = 0; g < this.track.gates.length; g++) {
      if (this.state[g] === PENDING) {
        if (this.pendingK[g] === 0) this.pendingK[g] = this.cfg.refineFixes;
        const c = this.finalize(g);
        if (c) out.push(c);
      }
    }
    return out;
  }

  private finalize(g: number): GateCrossing | null {
    const cfg = this.cfg;
    const gate = this.track.gates[g];
    const cl = this.track.centerline;
    const ring = this.ring;
    const crossSeq = this.pendingSeq[g];
    const tPre = this.pendingT[g];
    const K = Math.max(1, this.pendingK[g] || cfg.refineFixes);
    const lo = Math.max(ring.oldestSeq(), crossSeq - K);
    const hi = Math.min(ring.nextSeq - 1, crossSeq + K - 1);
    // Window (fixed-size scratch would be used on the MCU; arrays here are ≤ 2K).
    const ts: number[] = [];
    const rels: number[] = [];
    const vs: number[] = [];
    const slots: number[] = [];
    let allSpeed = true;
    let allCourse = true;
    for (let q = lo; q <= hi; q++) {
      const i = ring.slot(q);
      const rel = cl.delta(ring.s[i], gate.s);
      if (Math.abs(rel) > 2 * cfg.approachM) continue;
      ts.push(ring.t[i]);
      rels.push(rel);
      vs.push(ring.v[i]);
      slots.push(i);
      if (!Number.isFinite(ring.v[i])) allSpeed = false;
      if (!Number.isFinite(ring.c[i])) allCourse = false;
    }
    const n = ts.length;
    const done = (accepted: GateCrossing | null, reason?: GateRejectReason) => {
      if (accepted) {
        this.state[g] = DISARMED;
        this.lastAcceptT[g] = accepted.t;
      } else {
        this.state[g] = IDLE;
        if (reason) this.reject(g, reason, tPre);
      }
      this.pendingSeq[g] = -1;
      return accepted;
    };
    if (n < 2) return done(null, "too_few_fixes");

    let tCross: number;
    let speed: number;
    let method: "doppler" | "position";
    if (allSpeed) {
      method = "doppler";
      // Project Doppler speed onto the centerline tangent when course is
      // known: the car's heading differs from the centerline whenever its
      // lateral offset changes, and s only advances with the along-track part.
      speed = vs.reduce((a, b) => a + b, 0) / n;
      if (allCourse) {
        for (let k = 0; k < n; k++) {
          const i = slots[k];
          const tg = cl.pointAt(ring.s[i]);
          const u = courseToUnit(ring.c[i]);
          vs[k] = vs[k] * Math.max(0, u.x * tg.tx + u.y * tg.ty);
        }
      }
      const D = new Array<number>(n);
      D[0] = 0;
      for (let k = 1; k < n; k++) D[k] = D[k - 1] + 0.5 * (vs[k - 1] + vs[k]) * (ts[k] - ts[k - 1]);
      // rel_i ≈ c + α·D_i. α absorbs the ratio between the car's path length
      // (what Doppler measures) and centerline length (what s measures), which
      // differs on a curve or when the car is off the centerline.
      const r = rels.map((x, k) => x - D[k]);
      const sorted = r.slice().sort((a, b) => a - b);
      const med = sorted[n >> 1];
      let cnt = 0;
      let mD = 0;
      let mR = 0;
      for (let k = 0; k < n; k++) {
        if (Math.abs(r[k] - med) <= 30) {
          mD += D[k];
          mR += rels[k];
          cnt++;
        }
      }
      let alpha = 1;
      let c0 = med;
      if (cnt > 0) {
        mD /= cnt;
        mR /= cnt;
        let sdd = 0;
        let sdr = 0;
        for (let k = 0; k < n; k++) {
          if (Math.abs(r[k] - med) > 30) continue;
          sdd += (D[k] - mD) ** 2;
          sdr += (D[k] - mD) * (rels[k] - mR);
        }
        const a = sdd > 0 ? sdr / sdd : 1;
        alpha = cnt >= 6 && a > cfg.minScale && a < cfg.maxScale ? a : 1;
        c0 = mR - alpha * mD;
      }
      const target = -c0 / alpha; // D(t) at which s(t) == gate.s
      tCross = NaN;
      for (let k = 0; k < n - 1; k++) {
        if (D[k] <= target && target <= D[k + 1]) {
          const dt = ts[k + 1] - ts[k];
          const v0 = vs[k];
          const acc = dt > 0 ? (vs[k + 1] - v0) / dt : 0;
          const need = target - D[k];
          let tau: number;
          if (Math.abs(acc) < 1e-9) tau = v0 > 0 ? need / v0 : 0;
          else {
            const disc = v0 * v0 + 2 * acc * need;
            tau = (-v0 + Math.sqrt(Math.max(0, disc))) / acc;
          }
          tCross = ts[k] + Math.min(dt, Math.max(0, tau));
          break;
        }
      }
      if (!Number.isFinite(tCross)) {
        // extrapolate from the nearest end
        if (target < D[0]) tCross = ts[0] - (D[0] - target) / Math.max(0.1, vs[0]);
        else tCross = ts[n - 1] + (target - D[n - 1]) / Math.max(0.1, vs[n - 1]);
      }
    } else {
      method = "position";
      const tm = ts.reduce((a, b) => a + b, 0) / n;
      const rm = rels.reduce((a, b) => a + b, 0) / n;
      // Quadratic least squares rel(τ) = a + bτ + cτ², τ = t − tm. The
      // quadratic term absorbs acceleration through the window, which a
      // straight line would turn into a timing bias.
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      let r0 = 0;
      let r1 = 0;
      let r2 = 0;
      for (let k = 0; k < n; k++) {
        const u = ts[k] - tm;
        const u2 = u * u;
        s2 += u2;
        s3 += u2 * u;
        s4 += u2 * u2;
        r0 += rels[k];
        r1 += rels[k] * u;
        r2 += rels[k] * u2;
      }
      let a: number;
      let b: number;
      let c = 0;
      // normal equations [n 0 s2; 0 s2 s3; s2 s3 s4] (Σu = 0 by construction)
      const det = n * (s2 * s4 - s3 * s3) - s2 * (s2 * s2);
      if (n >= 6 && Math.abs(det) > 1e-12) {
        a = (r0 * (s2 * s4 - s3 * s3) + s2 * (r1 * s3 - s2 * r2)) / det;
        b = (n * (r1 * s4 - s3 * r2) + s2 * (r0 * s3 - s2 * r1)) / det;
        c = (n * (s2 * r2 - r1 * s3) - s2 * (s2 * r0)) / det;
      } else {
        b = s2 > 0 ? r1 / s2 : 0;
        a = rm;
      }
      if (!(b > 0.1)) return done(null, "no_progress");
      let tau: number;
      const disc = b * b - 4 * a * c;
      if (Math.abs(c) < 1e-9 || disc < 0) tau = -a / b;
      else tau = (-2 * a) / (b + Math.sqrt(disc));
      if (!Number.isFinite(tau) || Math.abs(tau) > 3) tau = -a / b;
      tCross = tm + tau;
      speed = b + 2 * c * tau;
    }

    if (speed < cfg.minSpeedMs) return done(null, "slow");

    const first = slots[0];
    const last = slots[n - 1];
    const mvx = ring.x[last] - ring.x[first];
    const mvy = ring.y[last] - ring.y[first];
    const move = Math.hypot(mvx, mvy);
    if (move < cfg.minMoveM) return done(null, "no_movement");

    let hx: number;
    let hy: number;
    if (allCourse) {
      hx = 0;
      hy = 0;
      for (const i of slots) {
        const u = courseToUnit(ring.c[i]);
        hx += u.x;
        hy += u.y;
      }
    } else {
      hx = mvx;
      hy = mvy;
    }
    const hl = Math.hypot(hx, hy) || 1;
    const cosErr = (hx * gate.fx + hy * gate.fy) / hl;
    const headingErrDeg = (Math.acos(Math.max(-1, Math.min(1, cosErr))) * 180) / Math.PI;
    if (headingErrDeg > cfg.maxHeadingErrorDeg) return done(null, "wrong_direction");

    let esum = 0;
    for (const i of slots) esum += ring.e[i];
    const lateral = esum / n - gate.centerE;
    if (Math.abs(lateral) > gate.halfWidthM + cfg.lateralMarginM) return done(null, "outside_gate");

    if (tCross - this.lastAcceptT[g] < cfg.cooldownS) return done(null, "cooldown");

    return done({
      gate: g,
      t: tCross,
      tPrelim: tPre,
      speedMs: speed,
      lateralM: lateral,
      headingErrDeg,
      method,
      nFixes: n,
      noiseEstM: this.pendingNoise[g],
    });
  }
}
