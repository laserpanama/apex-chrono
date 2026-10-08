/**
 * Validation harness: run the deterministic simulator through the real
 * GpsLapEngine and score detection + timing against ground truth.
 */

import { GpsLapEngine, type LapEngineConfig, type GpsLapRecord } from "./lap-engine.ts";
import type { GateCrossing } from "./gates.ts";
import { simulate, type SimConfig } from "./sim.ts";
import type { CompiledTrack } from "./track.ts";

export type ErrorStats = {
  n: number;
  meanS: number;
  /** signed median */
  medianS: number;
  meanAbsS: number;
  medianAbsS: number;
  stdS: number;
  p95AbsS: number;
  maxAbsS: number;
};

export type ScenarioResult = {
  track: string;
  noiseM: number;
  mode: "doppler" | "position";
  rateHz: number;
  fixes: number;
  truthLaps: number;
  detectedLaps: number;
  matchedLaps: number;
  validLaps: number;
  missedLaps: number;
  duplicateLaps: number;
  truthSectorCrossings: number;
  /** accepted sector-gate crossings inside the timed window */
  detectedSectorCrossings: number;
  matchedSectorCrossings: number;
  missedSectors: number;
  duplicateSectors: number;
  missedStartFinish: number;
  duplicateStartFinish: number;
  orderRejections: number;
  lapError: ErrorStats;
  sectorError: ErrorStats;
  maxSpeedErrorKmh: ErrorStats;
  crossTrackResidualM: ErrorStats;
  /** raw |cross-track| reported by the map matcher (includes the true lateral offset) */
  crossTrackAbsM: ErrorStats;
  alongTrackErrorM: ErrorStats;
  qualityRejected: number;
  crossTrackRejected: number;
  fullScans: number;
  gateRejections: Record<string, number>;
  runtimeMs: number;
};

export function errorStats(xs: ArrayLike<number>): ErrorStats {
  const n = xs.length;
  if (n === 0) {
    return {
      n: 0,
      meanS: NaN,
      medianS: NaN,
      meanAbsS: NaN,
      medianAbsS: NaN,
      stdS: NaN,
      p95AbsS: NaN,
      maxAbsS: NaN,
    };
  }
  let sum = 0;
  let sumAbs = 0;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sum += xs[i];
    abs[i] = Math.abs(xs[i]);
    sumAbs += abs[i];
  }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (xs[i] - mean) ** 2;
  abs.sort();
  const signed = Float64Array.from(xs as ArrayLike<number>).sort();
  const med = (a: Float64Array) => (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2);
  // P95 = nearest-rank (ceil(0.95·n)-th smallest |error|)
  const p95 = abs[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return {
    n,
    meanS: mean,
    medianS: med(signed),
    meanAbsS: sumAbs / n,
    medianAbsS: med(abs),
    stdS: Math.sqrt(v / n),
    p95AbsS: p95,
    maxAbsS: abs[n - 1],
  };
}

/** Greedy nearest matching of detected times to truth times within tol. */
function matchTimes(truth: number[], det: number[], tol: number) {
  const used = new Int32Array(truth.length).fill(-1);
  let dup = 0;
  const detToTruth: number[] = [];
  let j = 0;
  for (let k = 0; k < det.length; k++) {
    const t = det[k];
    while (j < truth.length - 1 && truth[j + 1] <= t) j++;
    let best = -1;
    let bd = Infinity;
    for (const c of [j - 1, j, j + 1]) {
      if (c < 0 || c >= truth.length) continue;
      const d = Math.abs(truth[c] - t);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best >= 0 && bd <= tol && used[best] < 0) {
      used[best] = k;
      detToTruth.push(best);
    } else {
      dup++;
      detToTruth.push(-1);
    }
  }
  let missed = 0;
  for (let i = 0; i < used.length; i++) if (used[i] < 0) missed++;
  return { missed, dup, detToTruth };
}

export function runScenario(
  track: CompiledTrack,
  sim: Partial<SimConfig> & { laps: number; noiseM: number },
  engineCfg: Partial<LapEngineConfig> = {},
): ScenarioResult {
  const started = Date.now();
  const engine = new GpsLapEngine(track, engineCfg);
  const crossings: GateCrossing[] = [];
  engine.onCrossing = (c) => crossings.push(c);
  const L = track.centerline.lengthM;
  const xtRes: number[] = [];
  const xtAbs: number[] = [];
  const atErr: number[] = [];
  let orderRejections = 0;
  const truthT: number[] = [];
  const truthV: number[] = [];
  const res = simulate(track, sim, (fix, truth) => {
    const ev = engine.push(fix);
    for (const e of ev) if (e.type === "rejected_order") orderRejections++;
    truthT.push(fix.t);
    truthV.push(truth.speedMs);
    const m = engine.lastMatch;
    if (m && m.t === fix.t && m.accepted) {
      xtRes.push(m.e - truth.e);
      xtAbs.push(Math.abs(m.e));
      let d = (m.s - truth.s) % L;
      if (d > L / 2) d -= L;
      else if (d < -L / 2) d += L;
      atErr.push(d);
    }
  });
  for (const e of engine.flush()) if (e.type === "rejected_order") orderRejections++;

  const nG = track.gates.length;
  const tol = 1.0;
  const sf = res.gateTimes[0];
  // Sector truth only counts inside the timed window (first S/F → last S/F).
  const truthFor = (g: number) =>
    g === 0 ? sf : res.gateTimes[g].filter((t) => t > sf[0] && t < sf[sf.length - 1]);
  const perGate = Array.from({ length: nG }, (_, g) => {
    const det = crossings
      .filter(
        (c) => c.gate === g && (g === 0 || (c.t > sf[0] - tol && c.t < sf[sf.length - 1] + tol)),
      )
      .map((c) => c.t);
    return matchTimes(truthFor(g), det, tol);
  });
  const truthLaps = sf.length - 1;
  // Truth lap k runs sf[k] → sf[k+1].
  const truthLapTime = (k: number) => sf[k + 1] - sf[k];
  const lapErr: number[] = [];
  const secErr: number[] = [];
  const spdErr: number[] = [];
  let matched = 0;
  const matchedTruth = new Set<number>();
  const nearestIdx = (arr: number[], t: number) => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i] - t);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return bd <= tol ? best : -1;
  };
  // Truth max speed per truth lap, from the truth speed at each fix epoch.
  const truthLapMax = new Float64Array(Math.max(0, truthLaps));
  {
    let k = 0;
    for (let i = 0; i < truthT.length; i++) {
      while (k < truthLaps && truthT[i] >= sf[k + 1]) k++;
      if (k >= truthLaps) break;
      if (truthT[i] >= sf[k] && truthV[i] > truthLapMax[k]) truthLapMax[k] = truthV[i];
    }
  }
  let duplicateLaps = 0;
  for (const lap of engine.laps as GpsLapRecord[]) {
    const k = nearestIdx(sf, lap.startT);
    const k2 = nearestIdx(sf, lap.endT);
    if (k < 0 || k2 !== k + 1 || matchedTruth.has(k)) {
      duplicateLaps++;
      continue;
    }
    matchedTruth.add(k);
    matched++;
    lapErr.push(lap.timeS - truthLapTime(k));
    spdErr.push((lap.maxSpeedMs - truthLapMax[k]) * 3.6);
    if (lap.valid) {
      const bounds = [sf[k]];
      for (let g = 1; g < nG; g++) {
        const gi = res.gateTimes[g].findIndex((t) => t > sf[k] && t < sf[k + 1]);
        bounds.push(gi >= 0 ? res.gateTimes[g][gi] : NaN);
      }
      bounds.push(sf[k + 1]);
      for (let i = 0; i < nG; i++) {
        const truthSplit = bounds[i + 1] - bounds[i];
        const sp = lap.splits[i];
        if (sp != null && Number.isFinite(truthSplit)) secErr.push(sp - truthSplit);
      }
    }
  }
  let missedSectors = 0;
  let dupSectors = 0;
  let truthSectorCrossings = 0;
  let detectedSectorCrossings = 0;
  let matchedSectorCrossings = 0;
  for (let g = 1; g < nG; g++) {
    truthSectorCrossings += truthFor(g).length;
    detectedSectorCrossings += perGate[g].detToTruth.length;
    matchedSectorCrossings += perGate[g].detToTruth.filter((k) => k >= 0).length;
    missedSectors += perGate[g].missed;
    dupSectors += perGate[g].dup;
  }
  const qualityRejected = Object.entries(engine.stats.rejected)
    .filter(([k]) => k !== "cross_track" && k !== "ok")
    .reduce((a, [, v]) => a + v, 0);
  return {
    track: track.id,
    noiseM: sim.noiseM,
    mode: sim.reportSpeed === false ? "position" : "doppler",
    rateHz: sim.rateHz ?? 10,
    fixes: res.fixCount,
    truthLaps,
    detectedLaps: engine.laps.length,
    matchedLaps: matched,
    validLaps: engine.laps.filter((l) => l.valid).length,
    missedLaps: truthLaps - matched,
    duplicateLaps,
    truthSectorCrossings,
    detectedSectorCrossings,
    matchedSectorCrossings,
    missedSectors,
    duplicateSectors: dupSectors,
    missedStartFinish: perGate[0].missed,
    duplicateStartFinish: perGate[0].dup,
    orderRejections,
    lapError: errorStats(lapErr),
    sectorError: errorStats(secErr),
    maxSpeedErrorKmh: errorStats(spdErr),
    crossTrackResidualM: errorStats(xtRes),
    crossTrackAbsM: errorStats(xtAbs),
    alongTrackErrorM: errorStats(atErr),
    qualityRejected,
    crossTrackRejected: engine.stats.rejected.cross_track,
    fullScans: engine.matcher.fullScans,
    gateRejections: { ...engine.detector.rejections },
    runtimeMs: Date.now() - started,
  };
}
