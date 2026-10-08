/**
 * Deterministic GNSS simulator for validating the timing pipeline.
 *
 * Ground truth: a car drives the track centerline with a smooth lateral
 * offset (a racing line that differs lap to lap) and a smooth pace
 * variation (lap times differ). Distance is integrated with a midpoint
 * method at 20 sub-steps per fix; exact truth gate-crossing times are
 * interpolated inside the 5 ms sub-step.
 *
 * Measurement: fixes at `rateHz` with Gaussian east/north position noise of
 * σ = noiseM per axis, Doppler speed noise and course noise, plausible
 * sats/HDOP, and optional bad-quality fixes. Everything is driven by a
 * seeded PRNG, so the same config produces bit-identical fixes.
 */

import { Centerline } from "./centerline.ts";
import { LocalFrame, unitToCourse, type GeoPoint } from "./geo.ts";
import type { GnssFix } from "./fix.ts";
import type { CompiledTrack } from "./track.ts";

/** mulberry32 — small, fast, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = rng();
    const v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export type SimConfig = {
  laps: number;
  noiseM: number;
  rateHz: number;
  /** seed for measurement noise */
  seed: number;
  /** seed for the truth trajectory (racing line / pace phases) */
  truthSeed: number;
  speedNoiseMs: number;
  courseNoiseDeg: number;
  reportSpeed: boolean;
  reportCourse: boolean;
  /** probability a fix is reported with degraded quality (low sats / high HDOP) */
  badFixRate: number;
  /** probability a fix is dropped entirely */
  dropRate: number;
  lateralAmpM: number;
  /** GNSS time of the first fix, seconds */
  startT: number;
  /** distance before the start/finish line where the car starts */
  runInM: number;
  /** keep running this long after the last required crossing */
  runOutS: number;
  /** top speed scale, m/s */
  baseSpeedMs: number;
};

export const DEFAULT_SIM: SimConfig = {
  laps: 10,
  noiseM: 0,
  rateHz: 10,
  seed: 1,
  truthSeed: 42,
  speedNoiseMs: 0.1,
  courseNoiseDeg: 0.5,
  reportSpeed: true,
  reportCourse: true,
  badFixRate: 0,
  dropRate: 0,
  lateralAmpM: 2.5,
  startT: 345600,
  runInM: 400,
  runOutS: 4,
  baseSpeedMs: 48,
};

export type TruthSample = { s: number; e: number; speedMs: number };

export type SimResult = {
  /** truth crossing times per gate index (gate 0 includes the out-lap crossing) */
  gateTimes: number[][];
  fixCount: number;
  durationS: number;
};

/** Curvature-based speed per centerline segment, smoothed (same idea as the preview). */
function speedProfile(cl: Centerline, base: number): Float64Array {
  const n = cl.n;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const cross = cl.tx[a] * cl.ty[i] - cl.ty[a] * cl.tx[i];
    const dot = cl.tx[a] * cl.tx[i] + cl.ty[a] * cl.ty[i];
    const k = Math.abs(Math.atan2(cross, dot)) / ((cl.len[a] + cl.len[i]) / 2);
    raw[i] = 16 + (base - 16) * Math.pow(1 / (1 + k * 80), 0.65);
  }
  const sm = Float64Array.from(raw);
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < n; i++) {
      sm[i] = Math.min(
        raw[i] * 1.02,
        sm[i] * 0.45 + sm[(i - 1 + n) % n] * 0.3 + sm[(i + 1) % n] * 0.25,
      );
    }
  }
  // Physical limits: a car cannot gain or shed speed faster than its
  // traction allows. Forward pass = acceleration limit, backward = braking.
  const aAcc = 6; // m/s²
  const aBrk = 11; // m/s²
  for (let lap = 0; lap < 3; lap++) {
    for (let k = 0; k < n; k++) {
      const i = (k + 1) % n;
      const p = k % n;
      const lim = Math.sqrt(sm[p] * sm[p] + 2 * aAcc * cl.len[p]);
      if (sm[i] > lim) sm[i] = lim;
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = k;
      const nx = (k + 1) % n;
      const lim = Math.sqrt(sm[nx] * sm[nx] + 2 * aBrk * cl.len[i]);
      if (sm[i] > lim) sm[i] = lim;
    }
  }
  return sm;
}

/**
 * Run the simulator. `onFix` receives every emitted fix with its truth.
 * The compiled track's centerline/frame defines truth geometry, so truth
 * and measurement share one coordinate system.
 */
export function simulate(
  track: CompiledTrack,
  partial: Partial<SimConfig>,
  onFix: (fix: GnssFix, truth: TruthSample) => void,
): SimResult {
  const cfg = { ...DEFAULT_SIM, ...partial };
  const cl = track.centerline;
  const frame: LocalFrame = track.frame;
  const L = cl.lengthM;
  const trng = mulberry32(cfg.truthSeed);
  const nrng = mulberry32(cfg.seed);
  const ngauss = gaussian(nrng);
  const ph = [trng(), trng(), trng(), trng()].map((x) => x * 2 * Math.PI);
  const prof = speedProfile(cl, cfg.baseSpeedMs);

  // Speed is linearly interpolated between segment midpoints → continuous.
  const vAt = (S: number): number => {
    const s = cl.wrap(S);
    const i = cl.segmentAt(s);
    const mid = cl.cum[i] + cl.len[i] / 2;
    let j: number;
    let a: number;
    let b: number;
    if (s >= mid) {
      j = (i + 1) % cl.n;
      a = mid;
      b = cl.cum[i] + cl.len[i] + cl.len[j] / 2;
    } else {
      j = (i - 1 + cl.n) % cl.n;
      a = cl.cum[i] - cl.len[j] / 2;
      b = mid;
    }
    const u = (s - a) / (b - a);
    const v0 = s >= mid ? prof[i] : prof[j];
    const v1 = s >= mid ? prof[j] : prof[i];
    const pace =
      1.03 +
      0.015 * Math.sin((2 * Math.PI * S) / (1.73 * L) + ph[0]) +
      0.008 * Math.sin((2 * Math.PI * S) / (0.61 * L) + ph[1]);
    return (v0 + (v1 - v0) * u) / pace;
  };
  const eAt = (S: number): number =>
    cfg.lateralAmpM *
    (0.7 * Math.sin((2 * Math.PI * S) / 290 + ph[2]) +
      0.3 * Math.sin((2 * Math.PI * S) / 77 + ph[3]));
  // Smooth left normal: blend vertex normals along each segment so the
  // offset path has no kinks at centerline vertices (a kink would put
  // unphysical spikes into the truth velocity).
  const vnx = new Float64Array(cl.n);
  const vny = new Float64Array(cl.n);
  for (let i = 0; i < cl.n; i++) {
    const a = (i - 1 + cl.n) % cl.n;
    const x = -(cl.ty[a] + cl.ty[i]);
    const y = cl.tx[a] + cl.tx[i];
    const l = Math.hypot(x, y) || 1;
    vnx[i] = x / l;
    vny[i] = y / l;
  }
  const posAt = (S: number): { x: number; y: number } => {
    const p = cl.pointAt(S);
    const i = p.seg;
    const j = (i + 1) % cl.n;
    const u = (cl.wrap(S) - cl.cum[i]) / cl.len[i];
    let nx = vnx[i] + (vnx[j] - vnx[i]) * u;
    let ny = vny[i] + (vny[j] - vny[i]) * u;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const e = eAt(S);
    return { x: p.x + nx * e, y: p.y + ny * e };
  };

  const gates = track.gates;
  const gateTimes: number[][] = gates.map(() => []);
  const sub = 20;
  const h = 1 / (cfg.rateHz * sub);
  let S = gates[0].s - cfg.runInM; // unwrapped
  let step = 0;
  let fixCount = 0;
  let stopAt = Infinity;
  const needSF = cfg.laps + 1;
  for (;;) {
    const t = cfg.startT + step * h;
    if (step % sub === 0) {
      if (t > stopAt) break;
      // emit a fix
      const p = posAt(S);
      const ds = 0.05;
      const pa = posAt(S - ds);
      const pb = posAt(S + ds);
      const sdot = vAt(S);
      const vx = ((pb.x - pa.x) / (2 * ds)) * sdot;
      const vy = ((pb.y - pa.y) / (2 * ds)) * sdot;
      const vTrue = Math.hypot(vx, vy);
      const nx = cfg.noiseM > 0 ? ngauss() * cfg.noiseM : 0;
      const ny = cfg.noiseM > 0 ? ngauss() * cfg.noiseM : 0;
      const geo: GeoPoint = frame.toGeo(p.x + nx, p.y + ny);
      const vNoise = cfg.speedNoiseMs > 0 ? ngauss() * cfg.speedNoiseMs : 0;
      const cNoise = cfg.courseNoiseDeg > 0 ? ngauss() * cfg.courseNoiseDeg : 0;
      let sats = 10 + Math.floor(nrng() * 7);
      let hdop = 0.6 + nrng() * 0.6;
      if (cfg.badFixRate > 0 && nrng() < cfg.badFixRate) {
        if (nrng() < 0.5) sats = 3 + Math.floor(nrng() * 2);
        else hdop = 3 + nrng() * 5;
      }
      const drop = cfg.dropRate > 0 && nrng() < cfg.dropRate;
      if (!drop) {
        const fix: GnssFix = { t, lat: geo.lat, lon: geo.lon, sats, hdop, fixType: 3 };
        if (cfg.reportSpeed) fix.speedMs = Math.max(0, vTrue + vNoise);
        if (cfg.reportCourse) fix.courseDeg = (unitToCourse(vx, vy) + cNoise + 360) % 360;
        onFix(fix, { s: cl.wrap(S), e: eAt(S), speedMs: vTrue });
        fixCount++;
      }
    }
    // midpoint integration
    const v1 = vAt(S);
    const v2 = vAt(S + (v1 * h) / 2);
    const S2 = S + v2 * h;
    // Truth crossing = the physical path crossing the gate LINE (not the
    // centerline distance), interpolated inside the 5 ms sub-step.
    for (let g = 0; g < gates.length; g++) {
      const gt = gates[g];
      if (Math.abs(cl.delta(gt.s, cl.wrap(S))) > 40) continue;
      const mx = (gt.lx + gt.rx) / 2;
      const my = (gt.ly + gt.ry) / 2;
      const pa = posAt(S);
      const pb = posAt(S2);
      const fa = (pa.x - mx) * gt.fx + (pa.y - my) * gt.fy;
      const fb = (pb.x - mx) * gt.fx + (pb.y - my) * gt.fy;
      if (fa < 0 && fb >= 0) {
        gateTimes[g].push(t + (-fa / (fb - fa)) * h);
        if (g === 0 && gateTimes[0].length === needSF && stopAt === Infinity) {
          // finish the lap's sectors are already in; run out so the detector can finalize
          stopAt = t + cfg.runOutS;
        }
      }
    }
    S = S2;
    step++;
  }
  return { gateTimes, fixCount, durationS: step * h };
}
