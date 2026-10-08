import type { Point, TrackDef } from "./tracks";
import { LocalFrame } from "../gnss/geo.ts";
import { compileTrack, type CompiledTrack } from "../gnss/track.ts";
import { geoTrackFromSynthetic, SYNTHETIC_ORIGIN } from "../gnss/synthetic.ts";
import { GpsLapEngine, type GpsLapRecord } from "../gnss/lap-engine.ts";
import type { GnssFix } from "../gnss/fix.ts";

/**
 * Timing source for the preview.
 * - "gps": laps/sectors come from the V1 GNSS pipeline (noisy 10 Hz fixes →
 *   map matching → geographic gates → GpsLapEngine), exactly as on hardware.
 * - "synthetic": the original distance-wrap logic, kept for UI work.
 */
export type TimingSource = "gps" | "synthetic";

export type Sample = {
  t: number;
  distM: number;
  lat: number;
  lon: number;
  speedKmh: number;
  heading: number;
  sats: number;
  hdop: number;
  gLong: number;
  gLat: number;
};

export type SectorSplit = {
  id: number;
  name: string;
  timeS: number | null;
  deltaS: number | null;
};

export type LapRecord = {
  number: number;
  timeS: number;
  /** null = that sector gate was not seen in order (GPS timing only) */
  splits: (number | null)[];
  maxSpeedKmh: number;
  valid: boolean;
};

// Same WGS84 local frame the GNSS layer uses, so simulated fixes round-trip exactly.
const FRAME = new LocalFrame(SYNTHETIC_ORIGIN);

export function toLatLon(p: Point): { lat: number; lon: number } {
  return FRAME.toGeo(p.x, p.y);
}

/** GNSS fix rate of the simulated receiver (BN-880 configured for 10 Hz). */
export const GNSS_RATE_HZ = 10;

function toLapRecord(r: GpsLapRecord): LapRecord {
  return {
    number: r.number,
    timeS: r.timeS,
    splits: r.splits.slice(),
    maxSpeedKmh: r.maxSpeedMs * 3.6,
    valid: r.valid,
  };
}

type Frame = {
  i: number;
  len: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
};

function framesOf(center: Point[]): { frames: Frame[]; cum: number[] } {
  const frames: Frame[] = [];
  const cum: number[] = [0];
  let acc = 0;
  for (let i = 0; i < center.length - 1; i++) {
    const a = center[i];
    const b = center[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-6;
    frames.push({
      i,
      len,
      tx: dx / len,
      ty: dy / len,
      nx: -dy / len,
      ny: dx / len,
    });
    acc += len;
    cum.push(acc);
  }
  return { frames, cum };
}

function curvature(frames: Frame[], idx: number): number {
  const a = frames[(idx - 1 + frames.length) % frames.length];
  const b = frames[idx % frames.length];
  const cross = a.tx * b.ty - a.ty * b.tx;
  const dot = a.tx * b.tx + a.ty * b.ty;
  const turn = Math.atan2(cross, dot);
  const ds = (a.len + b.len) / 2;
  return turn / ds;
}

function speedProfile(track: TrackDef): number[] {
  const { frames } = framesOf(track.center);
  const base = 48 * track.pace;
  const raw = frames.map((_, i) => {
    const k = Math.abs(curvature(frames, i));
    const corner = 1 / (1 + k * 80);
    return 16 + (base - 16) * Math.pow(corner, 0.65);
  });
  const sm = raw.slice();
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < sm.length; i++) {
      const prev = sm[(i - 1 + sm.length) % sm.length];
      const next = sm[(i + 1) % sm.length];
      sm[i] = Math.min(raw[i] * 1.02, sm[i] * 0.45 + prev * 0.3 + next * 0.25);
    }
  }
  return sm;
}

export type Pose = {
  x: number;
  y: number;
  heading: number;
  distM: number;
  speedMs: number;
  gLong: number;
  gLat: number;
  sectorIndex: number;
};

export class SessionEngine {
  track: TrackDef;
  frames: Frame[];
  cum: number[];
  speeds: number[];
  refTime: number[];
  refLapS: number;
  distM = 0;
  elapsed = 0;
  lapElapsed = 0;
  lapNumber = 0;
  armed = false;
  running = false;
  laps: LapRecord[] = [];
  bestS: number | null = null;
  lastS: number | null = null;
  sectorClock = 0;
  currentSplits: (number | null)[];
  bestSplits: (number | null)[];
  maxSpeedKmh = 0;
  lapMaxSpeed = 0;
  /** >1 is slower than the reference lap. */
  pace = 1.02;
  gpsNoiseM = 1.4;
  sats = 14;
  seed = 7;
  lastSpeedMs = 0;
  prevGLong = 0;
  timing: TimingSource = "gps";
  compiled: CompiledTrack;
  gps: GpsLapEngine;
  private fixClock = 0;
  private gpsSectorIndex = 0;

  constructor(track: TrackDef) {
    this.track = track;
    this.compiled = compileTrack(geoTrackFromSynthetic(track));
    this.gps = new GpsLapEngine(this.compiled);
    const built = framesOf(track.center);
    this.frames = built.frames;
    this.cum = built.cum;
    this.speeds = speedProfile(track);
    this.refTime = [0];
    let t = 0;
    for (let i = 0; i < this.frames.length; i++) {
      t += this.frames[i].len / Math.max(8, this.speeds[i]);
      this.refTime.push(t);
    }
    this.refLapS = this.refTime[this.refTime.length - 1];
    const n = track.sectors.length;
    this.currentSplits = Array(n).fill(null);
    this.bestSplits = Array(n).fill(null);
  }

  reset(track?: TrackDef) {
    if (track && track.id !== this.track.id) {
      const pace = this.pace;
      const next = new SessionEngine(track);
      next.pace = pace;
      next.timing = this.timing;
      return next;
    }
    this.gps = new GpsLapEngine(this.compiled);
    this.fixClock = 0;
    this.gpsSectorIndex = 0;
    this.distM = 0;
    this.elapsed = 0;
    this.lapElapsed = 0;
    this.lapNumber = 0;
    this.armed = false;
    this.running = false;
    this.laps = [];
    this.bestS = null;
    this.lastS = null;
    this.sectorClock = 0;
    this.currentSplits = Array(this.track.sectors.length).fill(null);
    this.bestSplits = Array(this.track.sectors.length).fill(null);
    this.maxSpeedKmh = 0;
    this.lapMaxSpeed = 0;
    this.lastSpeedMs = 0;
    return this;
  }

  arm() {
    this.running = true;
    this.armed = false;
    this.lapNumber = 0;
    this.lapElapsed = 0;
    this.sectorClock = 0;
    // A few seconds before the stripe so the first flying lap opens quickly.
    this.distM = this.track.lengthM * 0.93;
    this.lastSpeedMs = this.speedAt(this.distM);
    this.lapMaxSpeed = 0;
    this.gps = new GpsLapEngine(this.compiled);
    this.fixClock = 0;
  }

  pause() {
    this.running = false;
  }

  resume() {
    this.running = true;
    if (this.elapsed === 0) this.arm();
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed % 1000) / 1000;
  }

  private gauss() {
    const u = Math.max(1e-4, this.rand());
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private frameIndex(dist: number): { i: number; u: number; d: number } {
    const L = this.track.lengthM;
    const d = ((dist % L) + L) % L;
    let i = 0;
    const last = this.cum.length - 2;
    while (i < last && this.cum[i + 1] <= d) i++;
    const span = this.frames[i].len || 1;
    const u = Math.min(1, Math.max(0, (d - this.cum[i]) / span));
    return { i, u, d };
  }

  speedAt(dist: number): number {
    const { i } = this.frameIndex(dist);
    return Math.max(8, this.speeds[i] / this.pace);
  }

  refTimeAt(dist: number): number {
    const { i, u } = this.frameIndex(dist);
    return this.refTime[i] + (this.refTime[i + 1] - this.refTime[i]) * u;
  }

  /** Positive = behind the reference lap at this distance. */
  deltaS(): number | null {
    if (!this.armed) return null;
    // GPS timing confirms a line crossing ~1–3 s after the car passes it (the
    // crossing time is refined from fixes on both sides). In that window the
    // old lap is still open while distance has already wrapped; show no delta.
    if (
      this.timing === "gps" &&
      this.distM < this.track.lengthM * 0.25 &&
      this.lapElapsed > this.refLapS * 0.5
    )
      return null;
    return this.lapElapsed - this.refTimeAt(this.distM) * this.pace;
  }

  sectorIndex(dist: number): number {
    const d = ((dist % this.track.lengthM) + this.track.lengthM) % this.track.lengthM;
    let idx = 0;
    for (let i = 0; i < this.track.sectors.length; i++) {
      if (d + 1e-3 >= this.track.sectors[i].startM) idx = i;
    }
    return idx;
  }

  pose(): Pose {
    const { i, u, d } = this.frameIndex(this.distM);
    const f = this.frames[i];
    const a = this.track.center[i];
    const x = a.x + f.tx * f.len * u;
    const y = a.y + f.ty * f.len * u;
    const heading = (Math.atan2(f.tx, -f.ty) * 180) / Math.PI;
    const v = this.running || this.armed ? this.speedAt(d) : 0;
    const k = curvature(this.frames, i);
    const gLat = (v * v * k) / 9.81;
    return {
      x,
      y,
      heading,
      distM: d,
      speedMs: v,
      gLong: this.prevGLong,
      gLat: Math.max(-2.4, Math.min(2.4, gLat)),
      sectorIndex: this.sectorIndex(d),
    };
  }

  sample(): Sample {
    const p = this.pose();
    const jitter = this.running ? this.gpsNoiseM : 0;
    const geo = toLatLon({
      x: p.x + this.gauss() * jitter,
      y: p.y + this.gauss() * jitter,
    });
    const sats = this.running ? 11 + Math.floor(this.rand() * 6) : 14;
    const hdop = 0.55 + this.rand() * 0.35;
    return {
      t: this.elapsed,
      distM: p.distM,
      lat: geo.lat,
      lon: geo.lon,
      speedKmh: p.speedMs * 3.6,
      heading: (p.heading + 360) % 360,
      sats,
      hdop,
      gLong: p.gLong,
      gLat: p.gLat,
    };
  }

  /** One simulated receiver fix at the current pose (noisy position, Doppler speed/course). */
  gnssFix(): GnssFix {
    const p = this.pose();
    // True course over ground (0 = north, clockwise). `pose().heading` uses the
    // screen's y-down convention for the map arrow, so derive course from the
    // centerline tangent in east/north instead.
    const f = this.frames[this.frameIndex(this.distM).i];
    const course = ((Math.atan2(f.tx, f.ty) * 180) / Math.PI + 360) % 360;
    const geo = toLatLon({
      x: p.x + this.gauss() * this.gpsNoiseM,
      y: p.y + this.gauss() * this.gpsNoiseM,
    });
    return {
      t: this.elapsed,
      lat: geo.lat,
      lon: geo.lon,
      speedMs: Math.max(0, p.speedMs + this.gauss() * 0.1),
      courseDeg: course,
      sats: 11 + Math.floor(this.rand() * 6),
      hdop: 0.55 + this.rand() * 0.35,
      fixType: 3,
    };
  }

  step(dt: number): { crossed: boolean; sectorCrossed: number | null } {
    if (!this.running) return { crossed: false, sectorCrossed: null };
    if (this.timing === "gps") return this.stepGps(dt);
    const v0 = this.speedAt(this.distM);
    const beforeSector = this.armed ? this.sectorIndex(this.distM) : -1;
    const travel = v0 * dt;
    this.distM += travel;
    this.elapsed += dt;
    const gLong = (v0 - this.lastSpeedMs) / 9.81 / Math.max(dt, 0.016);
    this.prevGLong = Math.max(-1.8, Math.min(1.2, gLong));
    this.lastSpeedMs = v0;

    const spd = v0 * 3.6;
    if (spd > this.maxSpeedKmh) this.maxSpeedKmh = spd;
    if (spd > this.lapMaxSpeed) this.lapMaxSpeed = spd;

    let crossed = false;
    let sectorCrossed: number | null = null;
    const L = this.track.lengthM;

    if (this.distM >= L) {
      this.distM -= L;
      if (!this.armed) {
        this.armed = true;
        this.lapNumber = 1;
        this.lapElapsed = 0;
        this.sectorClock = 0;
        this.currentSplits = Array(this.track.sectors.length).fill(null);
        this.lapMaxSpeed = spd;
      } else {
        const n = this.track.sectors.length;
        const splits = this.currentSplits.map((v) => v ?? 0);
        splits[n - 1] = this.sectorClock;
        const lapTime = this.lapElapsed;
        const rec: LapRecord = {
          number: this.lapNumber,
          timeS: lapTime,
          splits,
          maxSpeedKmh: this.lapMaxSpeed,
          valid: true,
        };
        this.laps = [...this.laps, rec];
        this.lastS = lapTime;
        if (this.bestS === null || lapTime < this.bestS) {
          this.bestS = lapTime;
          this.bestSplits = splits.slice();
        }
        this.lapNumber += 1;
        this.lapElapsed = 0;
        this.sectorClock = 0;
        this.currentSplits = Array(n).fill(null);
        this.lapMaxSpeed = spd;
        crossed = true;
      }
    } else if (this.armed) {
      this.lapElapsed += dt;
      this.sectorClock += dt;
      const si = this.sectorIndex(this.distM);
      if (beforeSector >= 0 && si !== beforeSector) {
        this.currentSplits[beforeSector] = this.sectorClock;
        sectorCrossed = beforeSector + 1;
        this.sectorClock = dt * 0.15;
      }
    }
    return { crossed, sectorCrossed };
  }

  /**
   * GPS timing: the car still moves along the synthetic speed profile, but
   * laps and sectors are decided only by the GNSS pipeline from 10 Hz fixes
   * stamped with simulated GNSS time — never by distance wrap or frame time.
   */
  private stepGps(dt: number): { crossed: boolean; sectorCrossed: number | null } {
    const v0 = this.speedAt(this.distM);
    this.distM += v0 * dt;
    if (this.distM >= this.track.lengthM) this.distM -= this.track.lengthM;
    this.elapsed += dt;
    const gLong = (v0 - this.lastSpeedMs) / 9.81 / Math.max(dt, 0.016);
    this.prevGLong = Math.max(-1.8, Math.min(1.2, gLong));
    this.lastSpeedMs = v0;
    const spd = v0 * 3.6;
    if (spd > this.maxSpeedKmh) this.maxSpeedKmh = spd;

    let crossed = false;
    let sectorCrossed: number | null = null;
    this.fixClock += dt;
    const period = 1 / GNSS_RATE_HZ;
    while (this.fixClock >= period - 1e-9) {
      this.fixClock -= period;
      for (const ev of this.gps.push(this.gnssFix())) {
        if (ev.type === "lap") crossed = true;
        else if (ev.type === "sector") sectorCrossed = ev.sector + 1;
      }
    }
    this.syncFromGps();
    return { crossed, sectorCrossed };
  }

  private syncFromGps() {
    const live = this.gps.live(this.elapsed);
    const wasArmed = this.armed;
    this.armed = live.phase === "in_lap";
    this.lapNumber = live.lapNumber;
    this.lapElapsed = live.lapElapsedS ?? 0;
    this.gpsSectorIndex = live.sectorIndex;
    this.sectorClock = live.sectorElapsedS ?? 0;
    this.currentSplits = live.currentSplits.slice(0, this.track.sectors.length);
    if (this.gps.laps.length !== this.laps.length) {
      this.laps = this.gps.laps.map(toLapRecord);
      const prev = live.previousLap;
      this.lastS = prev ? prev.timeS : null;
    }
    const best = live.bestLap;
    this.bestS = best ? best.timeS : null;
    this.bestSplits = best ? best.splits.slice() : Array(this.track.sectors.length).fill(null);
    if (!wasArmed && this.armed) this.lapMaxSpeed = 0;
    if (this.armed) this.lapMaxSpeed = Math.max(this.lapMaxSpeed, this.lastSpeedMs * 3.6);
  }

  /** Sector the car is in for display: GPS state machine in GPS mode, distance otherwise. */
  currentSector(): number {
    if (this.timing === "gps") return this.armed ? this.gpsSectorIndex : 0;
    return this.sectorIndex(this.distM);
  }

  sectorRows(): SectorSplit[] {
    const liveIdx = this.armed ? this.currentSector() : -1;
    return this.track.sectors.map((s, i) => {
      const closed = this.currentSplits[i];
      const timeS = closed != null ? closed : i === liveIdx ? this.sectorClock : null;
      const best = this.bestSplits[i];
      return {
        id: s.id,
        name: s.name,
        timeS,
        deltaS: closed != null && best != null ? closed - best : null,
      };
    });
  }
}

export function formatLap(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--.---";
  const abs = Math.max(0, seconds);
  const m = Math.floor(abs / 60);
  const rem = abs - m * 60;
  const whole = Math.floor(rem);
  let ms = Math.round((rem - whole) * 1000);
  let w = whole;
  if (ms === 1000) {
    ms = 0;
    w += 1;
  }
  const carryM = w >= 60 ? m + 1 : m;
  const carryS = w >= 60 ? w - 60 : w;
  return `${String(carryM).padStart(2, "0")}:${String(carryS).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function formatDelta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—.—";
  if (Math.abs(seconds) < 0.0005) return "0.000";
  const sign = seconds > 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

export function formatSpeed(kmh: number): string {
  if (!Number.isFinite(kmh)) return "0";
  return String(Math.max(0, Math.round(kmh)));
}

export function csvFor(laps: LapRecord[], samples: Sample[]): string {
  const lines = [
    "type,t_s,lap,lat,lon,speed_kmh,heading_deg,sats,hdop,g_long,g_lat,dist_m,lap_time_s,sectors",
  ];
  for (const s of samples) {
    lines.push(
      [
        "sample",
        s.t.toFixed(2),
        "",
        s.lat.toFixed(7),
        s.lon.toFixed(7),
        s.speedKmh.toFixed(1),
        s.heading.toFixed(1),
        s.sats,
        s.hdop.toFixed(2),
        s.gLong.toFixed(3),
        s.gLat.toFixed(3),
        s.distM.toFixed(1),
        "",
        "",
      ].join(","),
    );
  }
  for (const lap of laps) {
    lines.push(
      [
        "lap",
        "",
        lap.number,
        "",
        "",
        lap.maxSpeedKmh.toFixed(1),
        "",
        "",
        "",
        "",
        "",
        "",
        lap.timeS.toFixed(3),
        lap.splits.map((x) => (x == null ? "" : x.toFixed(3))).join("|"),
      ].join(","),
    );
  }
  return lines.join("\n");
}
