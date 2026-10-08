/**
 * GPS lap engine: the reusable timing pipeline.
 *
 *   GnssFix → quality filter → LocalFrame → MapMatcher (s, cross-track)
 *           → GateDetector (geographic gates, refined crossing time)
 *           → sector/lap state machine → LapRecord
 *
 * All times come from GNSS fix timestamps. Nothing here reads a wall clock
 * or animation frame time, so the same code produces the same laps from a
 * live receiver, a replayed log, or the deterministic simulator.
 */

import { MapMatcher, type MapMatcherConfig } from "./centerline.ts";
import {
  checkFixQuality,
  DEFAULT_QUALITY,
  type GnssFix,
  type QualityConfig,
  type QualityVerdict,
} from "./fix.ts";
import { GateDetector, type GateConfig, type GateCrossing } from "./gates.ts";
import type { CompiledTrack } from "./track.ts";

export type GpsLapRecord = {
  number: number;
  startT: number;
  endT: number;
  timeS: number;
  /** split per sector; null if that sector's gate was not seen in order */
  splits: (number | null)[];
  maxSpeedMs: number;
  /** every sector gate was crossed in order */
  valid: boolean;
};

export type TimingEvent =
  | { type: "lap_start"; t: number; lap: number }
  | { type: "sector"; t: number; lap: number; sector: number; splitS: number }
  | { type: "lap"; t: number; record: GpsLapRecord }
  | { type: "rejected_order"; t: number; gate: number; expected: number }
  | { type: "rejected_short_lap"; t: number; timeS: number }
  | { type: "ignored_before_start"; t: number; gate: number };

export type LapEngineConfig = {
  quality: QualityConfig;
  matcher: Partial<MapMatcherConfig>;
  gates: Partial<GateConfig>;
  /** laps shorter than this are rejected (belt and braces on top of gate cooldown) */
  minLapS: number;
  /** resolution of the best-lap time-vs-distance trace for live delta */
  traceStepM: number;
  /** baseline for position-derived speed when the receiver reports no Doppler speed */
  derivedSpeedBaselineS: number;
};

export const DEFAULT_LAP_ENGINE_CONFIG: LapEngineConfig = {
  quality: DEFAULT_QUALITY,
  matcher: {},
  gates: {},
  minLapS: 10,
  traceStepM: 5,
  derivedSpeedBaselineS: 1,
};

export type LapEngineStats = {
  fixes: number;
  accepted: number;
  rejected: Record<QualityVerdict | "cross_track", number>;
  crossings: number;
};

export type LiveState = {
  phase: "out_lap" | "in_lap";
  lapNumber: number;
  lapStartT: number | null;
  lapElapsedS: number | null;
  /** 0-based sector currently being driven */
  sectorIndex: number;
  currentSplits: (number | null)[];
  sectorElapsedS: number | null;
  /** distance from the start/finish line along the centerline */
  lapDistM: number | null;
  /** live delta vs best lap at the same lap distance; + = slower */
  liveDeltaS: number | null;
  previousLap: GpsLapRecord | null;
  bestLap: GpsLapRecord | null;
  /** previous lap − best lap */
  previousDeltaS: number | null;
  /** current-lap closed splits − best-lap splits */
  sectorDeltasS: (number | null)[];
  lastS: number | null;
  lastCrossTrackM: number | null;
  lastSpeedMs: number | null;
};

export class GpsLapEngine {
  readonly track: CompiledTrack;
  readonly cfg: LapEngineConfig;
  readonly matcher: MapMatcher;
  readonly detector: GateDetector;
  readonly nGates: number;

  laps: GpsLapRecord[] = [];
  bestLap: GpsLapRecord | null = null;
  stats: LapEngineStats;
  /** Optional observer for every accepted gate crossing (validation, logging). */
  onCrossing: ((c: GateCrossing) => void) | null = null;
  /** Map-match result of the most recent fix that passed the quality filter. */
  lastMatch: { t: number; s: number; e: number; fullScan: boolean; accepted: boolean } | null =
    null;

  private phase: "out_lap" | "in_lap" = "out_lap";
  private lapNumber = 0;
  private lapStartT = 0;
  private lastGateT = 0;
  private nextGate = 0;
  /** set when sector 1 is crossed while waiting for start/finish → the S/F crossing was missed */
  private missedLine = false;
  private splits: (number | null)[];
  private lapMax = 0;
  private lastQualityT: number | null = null;
  private lastS: number | null = null;
  private lastSpeed: number | null = null;
  private lastE: number | null = null;
  private lastFixT: number | null = null;
  private lastAcceptedT: number | null = null;
  // Fixes held back while a gate crossing is pending, so max speed and the
  // delta trace are attributed to the correct lap once the crossing time is known.
  private heldT: number[] = [];
  private heldV: number[] = [];
  private heldS: number[] = [];
  private sHistT: number[] = [];
  private sHistS: number[] = [];
  private trace: Float64Array;
  private bestTrace: Float64Array | null = null;
  private traceLastBin = -1;
  private traceLastT = 0;
  private traceLastD = 0;

  constructor(track: CompiledTrack, cfg: Partial<LapEngineConfig> = {}) {
    this.track = track;
    this.cfg = {
      ...DEFAULT_LAP_ENGINE_CONFIG,
      ...cfg,
      quality: { ...DEFAULT_QUALITY, ...(cfg.quality ?? {}) },
    };
    this.matcher = new MapMatcher(track.centerline, this.cfg.matcher);
    this.detector = new GateDetector(track, this.cfg.gates);
    this.nGates = track.gates.length;
    this.splits = Array(this.nGates).fill(null);
    this.trace = new Float64Array(
      Math.ceil(track.centerline.lengthM / this.cfg.traceStepM) + 1,
    ).fill(NaN);
    this.stats = {
      fixes: 0,
      accepted: 0,
      rejected: { ok: 0, no_fix: 0, sats: 0, hdop: 0, not_finite: 0, time: 0, cross_track: 0 },
      crossings: 0,
    };
  }

  /** Feed one GNSS fix. Returns timing events produced by it. */
  push(fix: GnssFix): TimingEvent[] {
    this.stats.fixes++;
    const verdict = checkFixQuality(fix, this.cfg.quality, this.lastQualityT);
    if (verdict !== "ok") {
      this.stats.rejected[verdict]++;
      return [];
    }
    this.lastQualityT = fix.t;
    const p = this.track.frame.toLocal(fix.lat, fix.lon);
    const v = fix.speedMs !== undefined && Number.isFinite(fix.speedMs) ? fix.speedMs : NaN;
    let predicted: number | undefined;
    if (this.lastS !== null && this.lastAcceptedT !== null && Number.isFinite(v)) {
      predicted = this.lastS + v * (fix.t - this.lastAcceptedT);
    }
    const m = this.matcher.match(p.x, p.y, predicted);
    this.lastFixT = fix.t;
    const onTrack = Math.abs(m.crossTrackM) <= this.cfg.quality.maxCrossTrackM;
    this.lastMatch = {
      t: fix.t,
      s: m.s,
      e: m.crossTrackM,
      fullScan: m.fullScan,
      accepted: onTrack,
    };
    if (!onTrack) {
      this.stats.rejected.cross_track++;
      return [];
    }
    this.stats.accepted++;
    this.lastS = m.s;
    this.lastE = m.crossTrackM;
    this.lastAcceptedT = fix.t;
    const course =
      fix.courseDeg !== undefined && Number.isFinite(fix.courseDeg) ? fix.courseDeg : NaN;
    const crossings = this.detector.push({
      t: fix.t,
      x: p.x,
      y: p.y,
      s: m.s,
      e: m.crossTrackM,
      speedMs: v,
      courseDeg: course,
    });

    // Without Doppler, fall back to along-track speed over a ~1 s baseline.
    let vLap = v;
    if (!Number.isFinite(vLap)) {
      this.sHistT.push(fix.t);
      this.sHistS.push(m.s);
      while (this.sHistT.length > 2 && fix.t - this.sHistT[1] >= this.cfg.derivedSpeedBaselineS) {
        this.sHistT.shift();
        this.sHistS.shift();
      }
      const dt = fix.t - this.sHistT[0];
      if (dt >= this.cfg.derivedSpeedBaselineS * 0.8) {
        vLap = Math.max(0, this.track.centerline.delta(m.s, this.sHistS[0]) / dt);
      }
    }
    this.heldT.push(fix.t);
    this.heldV.push(Number.isFinite(vLap) ? vLap : NaN);
    this.heldS.push(m.s);
    if (Number.isFinite(vLap)) this.lastSpeed = vLap;

    const events: TimingEvent[] = [];
    crossings.sort((a, b) => a.t - b.t);
    for (const c of crossings) this.handleCrossing(c, events);
    this.releaseHeld(this.detector.hasPending() ? this.detector.earliestPendingT() : Infinity);
    return events;
  }

  /** End of data: finalize pending crossings. */
  flush(): TimingEvent[] {
    const events: TimingEvent[] = [];
    const cs = this.detector.flush().sort((a, b) => a.t - b.t);
    for (const c of cs) this.handleCrossing(c, events);
    this.releaseHeld(Infinity);
    return events;
  }

  private releaseHeld(beforeT: number) {
    let k = 0;
    while (k < this.heldT.length && this.heldT[k] < beforeT) {
      this.commitFix(this.heldT[k], this.heldV[k], this.heldS[k]);
      k++;
    }
    if (k > 0) {
      this.heldT.splice(0, k);
      this.heldV.splice(0, k);
      this.heldS.splice(0, k);
    }
  }

  /** Attribute a fix to the lap in progress (max speed, delta trace). */
  private commitFix(t: number, v: number, s: number) {
    if (this.phase !== "in_lap" || t < this.lapStartT) return;
    if (Number.isFinite(v) && v > this.lapMax) this.lapMax = v;
    const cl = this.track.centerline;
    const d = cl.wrap(s - this.track.gates[0].s);
    const bin = Math.floor(d / this.cfg.traceStepM);
    const el = t - this.lapStartT;
    // A noisy fix just behind the line right after the lap opened would map to
    // the end of the lap; it says nothing about progress, so skip it.
    if (d > cl.lengthM / 2 && el < 10) return;
    // Only forward progress extends the trace; each bin boundary gets the
    // time interpolated between the two fixes that straddle it.
    if (d > this.traceLastD && bin < this.trace.length) {
      const step = this.cfg.traceStepM;
      for (let b = this.traceLastBin + 1; b <= bin; b++) {
        const frac = (b * step - this.traceLastD) / (d - this.traceLastD);
        this.trace[b] = this.traceLastT + (el - this.traceLastT) * frac;
      }
      this.traceLastBin = Math.max(this.traceLastBin, bin);
      this.traceLastD = d;
      this.traceLastT = el;
    }
  }

  private startLap(t: number) {
    this.phase = "in_lap";
    this.lapNumber += 1;
    this.lapStartT = t;
    this.lastGateT = t;
    this.nextGate = this.nGates > 1 ? 1 : 0;
    this.missedLine = false;
    this.splits = Array(this.nGates).fill(null);
    this.lapMax = 0;
    this.trace.fill(NaN);
    this.trace[0] = 0;
    this.traceLastBin = 0;
    this.traceLastD = 0;
    this.traceLastT = 0;
    // Fixes already seen after the crossing belong to the new lap.
    for (let k = 0; k < this.heldT.length; k++) {
      if (this.heldT[k] >= t) this.commitFix(this.heldT[k], this.heldV[k], this.heldS[k]);
    }
    for (let k = this.heldT.length - 1; k >= 0; k--) {
      if (this.heldT[k] >= t) {
        this.heldT.splice(k, 1);
        this.heldV.splice(k, 1);
        this.heldS.splice(k, 1);
      }
    }
  }

  private handleCrossing(c: GateCrossing, events: TimingEvent[]) {
    this.stats.crossings++;
    if (this.onCrossing) this.onCrossing(c);
    // Fixes before the crossing belong to the lap that is closing.
    this.releaseHeld(c.t);
    if (c.gate === 0) {
      if (this.phase === "out_lap") {
        this.startLap(c.t);
        events.push({ type: "lap_start", t: c.t, lap: this.lapNumber });
        return;
      }
      const timeS = c.t - this.lapStartT;
      if (timeS < this.cfg.minLapS) {
        events.push({ type: "rejected_short_lap", t: c.t, timeS });
        return;
      }
      // A lap is valid only if every sector gate was seen in order AND the
      // start/finish line was not missed in between (which would merge two laps).
      const complete = this.nextGate === 0 && !this.missedLine;
      if (complete) this.splits[this.nGates - 1] = c.t - this.lastGateT;
      const rec: GpsLapRecord = {
        number: this.lapNumber,
        startT: this.lapStartT,
        endT: c.t,
        timeS,
        splits: this.splits.slice(),
        maxSpeedMs: this.lapMax,
        valid: complete,
      };
      this.laps.push(rec);
      if (rec.valid && (this.bestLap === null || rec.timeS < this.bestLap.timeS)) {
        this.bestLap = rec;
        this.bestTrace = this.trace.slice();
      }
      events.push({ type: "lap", t: c.t, record: rec });
      this.startLap(c.t);
      events.push({ type: "lap_start", t: c.t, lap: this.lapNumber });
      return;
    }
    if (this.phase === "out_lap") {
      events.push({ type: "ignored_before_start", t: c.t, gate: c.gate });
      return;
    }
    if (c.gate !== this.nextGate) {
      if (this.nextGate === 0 && c.gate === 1) this.missedLine = true;
      events.push({ type: "rejected_order", t: c.t, gate: c.gate, expected: this.nextGate });
      return;
    }
    const split = c.t - this.lastGateT;
    this.splits[c.gate - 1] = split;
    this.lastGateT = c.t;
    this.nextGate = (c.gate + 1) % this.nGates;
    events.push({ type: "sector", t: c.t, lap: this.lapNumber, sector: c.gate - 1, splitS: split });
  }

  previousLap(): GpsLapRecord | null {
    return this.laps.length ? this.laps[this.laps.length - 1] : null;
  }

  /** Live dashboard state at GNSS time `t` (defaults to the last fix). */
  live(t?: number): LiveState {
    const now = t ?? this.lastFixT;
    const inLap = this.phase === "in_lap";
    const prev = this.previousLap();
    const best = this.bestLap;
    let lapDist: number | null = null;
    let liveDelta: number | null = null;
    if (inLap && this.lastS !== null) {
      lapDist = this.track.centerline.wrap(this.lastS - this.track.gates[0].s);
      if (this.bestTrace && this.lastAcceptedT !== null && this.lastAcceptedT >= this.lapStartT) {
        const step = this.cfg.traceStepM;
        const b = Math.floor(lapDist / step);
        const f = lapDist / step - b;
        const t0 = this.bestTrace[b];
        const t1 = this.bestTrace[Math.min(b + 1, this.bestTrace.length - 1)];
        const ref = Number.isFinite(t1) ? t0 + (t1 - t0) * f : t0;
        if (Number.isFinite(ref)) liveDelta = this.lastAcceptedT - this.lapStartT - ref;
      }
    }
    const sectorIndex = inLap ? (this.nextGate === 0 ? this.nGates - 1 : this.nextGate - 1) : 0;
    return {
      phase: this.phase,
      lapNumber: this.lapNumber,
      lapStartT: inLap ? this.lapStartT : null,
      lapElapsedS: inLap && now !== null ? Math.max(0, now - this.lapStartT) : null,
      sectorIndex,
      currentSplits: this.splits.slice(),
      sectorElapsedS: inLap && now !== null ? Math.max(0, now - this.lastGateT) : null,
      lapDistM: lapDist,
      liveDeltaS: liveDelta,
      previousLap: prev,
      bestLap: best,
      previousDeltaS: prev && best && prev.valid ? prev.timeS - best.timeS : null,
      sectorDeltasS: this.splits.map((sp, i) => {
        const bs = best?.splits[i];
        return sp != null && bs != null ? sp - bs : null;
      }),
      lastS: this.lastS,
      lastCrossTrackM: this.lastE,
      lastSpeedMs: this.lastSpeed,
    };
  }
}
