/**
 * Deterministic acceleration-run simulator for the drag engine (tests and
 * C++ parity fixtures). Produces contract rows (recording.ts) exactly as the
 * device would log them — speed in km/h at 2 decimals — plus the TRUE
 * crossing times of every target, so accuracy can be measured, not assumed.
 *
 * Truth model (per run): standing start, a(v) = min(grip·g, P/(m·v)) − drag
 * − rolling resistance, a short zero-thrust gap at each gear change, then
 * braking to a stop. Integrated at 0.5 ms; sampled at `rateHz` with seeded
 * Gaussian Doppler noise.
 */

import { mulberry32 } from "./sim.ts";
import { LocalFrame } from "./geo.ts";
import type { ContractRow } from "./recording.ts";

export type DragSimRun = {
  powerKw: number;
  massKg: number;
  /** traction-limited acceleration, g */
  grip: number;
  /** speed at which the run lifts off and brakes, km/h */
  topKmh: number;
  /** road grade, % (+ uphill) */
  slopePct: number;
  /** gear-change speeds, km/h */
  shiftsKmh: number[];
  shiftS: number;
};

export type DragSimConfig = {
  rateHz: number;
  /** 1-σ Doppler speed noise, km/h (u-blox M8 spec ≈ 0.05 m/s = 0.18 km/h) */
  noiseKmh: number;
  seed: number;
  stillS: number;
  runs: DragSimRun[];
  /** [startS, durationS] windows (absolute session time) with no fixes */
  gaps?: [number, number][];
  /** [startS, durationS] windows reporting 4 satellites */
  lowSats?: [number, number][];
  /** omit speed entirely (position-only receiver) */
  noSpeed?: boolean;
};

export const DEFAULT_RUN: DragSimRun = {
  powerKw: 220,
  massKg: 1450,
  grip: 0.95,
  topKmh: 215,
  slopePct: 0,
  shiftsKmh: [58, 102, 148, 192],
  shiftS: 0.18,
};

export type DragTruth = {
  /** absolute session seconds the car started moving */
  t0: number;
  speedT: Map<number, number>; // km/h → seconds from t0
  distT: Map<number, { t: number; kmh: number }>; // m → seconds from t0, speed
};

const G = 9.80665;
const DT = 0.0005;

export function simulateDrag(
  cfg: DragSimConfig,
  speedTargetsKmh: number[],
  distanceTargetsM: number[],
): { rows: ContractRow[]; truth: DragTruth[] } {
  const rng = mulberry32(cfg.seed);
  const gauss = () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const frame = new LocalFrame({ lat: 8.98, lon: -79.52 });
  const rows: ContractRow[] = [];
  const truth: DragTruth[] = [];
  const period = 1 / cfg.rateHz;
  const t0Base = 50_000; // session clock, s
  let t = 0; // session time
  let x = 0; // along-road position, m
  let alt = 20;
  let nextSample = 0;

  const inWin = (w: [number, number][] | undefined) =>
    !!w && w.some(([a, d]) => t >= a && t < a + d);
  const sample = (v: number) => {
    while (t >= nextSample - 1e-12) {
      if (!inWin(cfg.gaps)) {
        const p = frame.toGeo(x, 0);
        const kmh = Math.max(0, v * 3.6 + cfg.noiseKmh * gauss());
        const low = inWin(cfg.lowSats);
        rows.push({
          timestampMs: Math.round((t0Base + nextSample) * 1000),
          lat: p.lat,
          lon: p.lon,
          speedKmh: cfg.noSpeed ? null : Math.round(kmh * 100) / 100,
          headingDeg: 90,
          satellites: low ? 4 : 12,
          hdop: low ? 3.5 : 0.8,
          fixQuality: 1,
          altitudeM: Math.round(alt * 10) / 10,
          mcuMs: null,
          line: -1,
        });
      }
      nextSample += period;
    }
  };
  const still = (s: number) => {
    const end = t + s;
    while (t < end) {
      sample(0);
      t += DT;
    }
  };

  still(cfg.stillS);
  for (const run of cfg.runs) {
    const tr: DragTruth = { t0: t0Base + t, speedT: new Map(), distT: new Map() };
    const start = t;
    const x0 = x;
    let v = 0;
    let shiftUntil = -1;
    const shifts = [...run.shiftsKmh];
    const grade = run.slopePct / 100;
    while (v * 3.6 < run.topKmh) {
      sample(v);
      if (shifts.length && v * 3.6 >= shifts[0]) {
        shifts.shift();
        shiftUntil = t + run.shiftS;
      }
      const thrust =
        t < shiftUntil
          ? 0
          : Math.min(run.grip * G, (run.powerKw * 1000) / (run.massKg * Math.max(v, 0.5)));
      const a = thrust - (0.32 * v * v) / run.massKg - 0.012 * G - grade * G;
      const v2 = Math.max(0, v + a * DT);
      const d = ((v + v2) / 2) * DT;
      for (const k of speedTargetsKmh)
        if (!tr.speedT.has(k) && v2 * 3.6 >= k)
          tr.speedT.set(k, t + ((k / 3.6 - v) / (v2 - v)) * DT - start);
      for (const D of distanceTargetsM)
        if (!tr.distT.has(D) && x + d - x0 >= D) {
          const f = (D - (x - x0)) / d;
          tr.distT.set(D, { t: t + f * DT - start, kmh: (v + f * (v2 - v)) * 3.6 });
        }
      x += d;
      alt += d * grade;
      v = v2;
      t += DT;
    }
    while (v > 0) {
      sample(v);
      const v2 = Math.max(0, v - 8 * DT);
      x += ((v + v2) / 2) * DT;
      v = v2;
      t += DT;
    }
    truth.push(tr);
    still(cfg.stillS);
  }
  return { rows, truth };
}
