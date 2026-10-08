/**
 * Phone as the sensor: the browser's Geolocation + DeviceMotion feeding the
 * SAME engines the device runs (GpsLapEngine, DragEngine). DOM-free so it is
 * unit-tested in Node; the screen is src/components/phone/PhoneScreen.tsx.
 *
 * What a phone does NOT give, and how it is handled (never invented):
 *  - satellites / HDOP: the browser reports neither. The contract row keeps
 *    `satellites = 0`, and the `hdop` column carries the browser's horizontal
 *    ACCURACY in metres instead. The engines are configured accordingly
 *    (minSats 0, maxHdop = max accuracy in metres). The exported CSV says so
 *    in its metadata (`# source=phone`, `# hdop_is_accuracy_m=1`), and
 *    `npm run replay:gps` applies the same configuration from it.
 *  - fix rate: whatever the phone delivers (often ~1 Hz in a browser). It is
 *    measured, shown, and used to size the drag gap limit; results at low
 *    rates are marked by the engines' own validity rules, not hidden.
 */

import { DragEngine, type DragConfig, type DragEvent } from "./drag.ts";
import { rowToDragSample } from "./drag.ts";
import { GpsLapEngine, type TimingEvent } from "./lap-engine.ts";
import { RECORDING_HEADER, formatRow, rowToFix, type ContractRow } from "./recording.ts";
import type { QualityConfig } from "./fix.ts";
import type { CompiledTrack } from "./track.ts";

/** Subset of the DOM GeolocationPosition the adapter reads. */
export type PhonePosition = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    speed: number | null;
    heading: number | null;
  };
};

/** Subset of the DOM DeviceMotionEvent the adapter reads. */
export type PhoneMotion = {
  /** epoch ms */
  tMs: number;
  acc: { x: number | null; y: number | null; z: number | null } | null;
  accG: { x: number | null; y: number | null; z: number | null } | null;
  rot: { alpha: number | null; beta: number | null; gamma: number | null } | null;
};

export type ImuRow = {
  tMs: number;
  /** linear acceleration (gravity removed), m/s² — NaN if the phone gives none */
  ax: number;
  ay: number;
  az: number;
  /** acceleration including gravity, m/s² */
  gxAcc: number;
  gyAcc: number;
  gzAcc: number;
  /** rotation rate, deg/s (alpha = about z, beta = about x, gamma = about y) */
  rAlpha: number;
  rBeta: number;
  rGamma: number;
};

export const PHONE_MAX_ACCURACY_M = 10;
/** fixes used to measure the rate before the drag engine is configured */
export const PHONE_WARMUP_FIXES = 10;

const n = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? NaN : v;

/** Geolocation position → contract row (§6). Missing values stay "not reported". */
export function positionToRow(p: PhonePosition): ContractRow {
  const c = p.coords;
  const speed = n(c.speed);
  const heading = n(c.heading);
  const alt = n(c.altitude);
  return {
    timestampMs: Math.round(p.timestamp),
    lat: c.latitude,
    lon: c.longitude,
    speedKmh: Number.isFinite(speed) ? Math.round(speed * 3.6 * 100) / 100 : null,
    headingDeg: Number.isFinite(heading) ? Math.round(heading * 10) / 10 : null,
    satellites: 0,
    hdop: Number.isFinite(c.accuracy) ? Math.round(c.accuracy * 100) / 100 : 99.9,
    fixQuality: 1,
    altitudeM: Number.isFinite(alt) ? Math.round(alt * 10) / 10 : null,
    mcuMs: null,
    line: -1,
  };
}

export function motionToImu(m: PhoneMotion): ImuRow {
  return {
    tMs: m.tMs,
    ax: n(m.acc?.x),
    ay: n(m.acc?.y),
    az: n(m.acc?.z),
    gxAcc: n(m.accG?.x),
    gyAcc: n(m.accG?.y),
    gzAcc: n(m.accG?.z),
    rAlpha: n(m.rot?.alpha),
    rBeta: n(m.rot?.beta),
    rGamma: n(m.rot?.gamma),
  };
}

/** Quality gate for phone fixes: no satellite count, `hdop` = accuracy in metres. */
export function phoneQuality(maxAccuracyM = PHONE_MAX_ACCURACY_M): QualityConfig {
  return { minSats: 0, maxHdop: maxAccuracyM, maxCrossTrackM: 25 };
}

/** Drag config for a measured fix interval: gaps are judged against the phone's own rate. */
export function phoneDragConfig(
  maxGapS: number,
  maxAccuracyM = PHONE_MAX_ACCURACY_M,
): Partial<DragConfig> {
  return { minSats: 0, maxHdop: maxAccuracyM, maxGapS };
}

/** 2.5 × the median fix interval, never below the device's 0.25 s. */
export function gapForIntervalMs(medianMs: number): number {
  if (!Number.isFinite(medianMs) || medianMs <= 0) return 2.5;
  return Math.max(0.25, Math.round(((2.5 * medianMs) / 1000) * 1000) / 1000);
}

/** Rolling fix rate over the last `window` intervals. */
export class RateMeter {
  private t: number[] = [];
  private window: number;
  constructor(window = 20) {
    this.window = window;
  }
  push(tMs: number) {
    this.t.push(tMs);
    if (this.t.length > this.window + 1) this.t.shift();
  }
  get count() {
    return this.t.length;
  }
  hz(): number {
    if (this.t.length < 2) return NaN;
    const span = this.t[this.t.length - 1] - this.t[0];
    return span > 0 ? ((this.t.length - 1) * 1000) / span : NaN;
  }
  medianIntervalMs(): number {
    if (this.t.length < 2) return NaN;
    const d: number[] = [];
    for (let i = 1; i < this.t.length; i++) d.push(this.t[i] - this.t[i - 1]);
    d.sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
  }
}

export type PhoneUpdate = {
  row: ContractRow | null;
  drag: DragEvent[];
  laps: TimingEvent[];
};

export class PhoneSession {
  readonly rows: ContractRow[] = [];
  readonly imu: ImuRow[] = [];
  readonly gnssRate = new RateMeter();
  readonly imuRate = new RateMeter(60);
  drag: DragEngine | null = null;
  dragMaxGapS = NaN;
  lap: GpsLapEngine | null = null;
  trackName: string | null = null;
  /** repeated / stale positions the browser re-delivered (same or older timestamp) */
  duplicates = 0;
  readonly startedMs: number;
  private imuCap: number;

  readonly maxAccuracyM: number;

  constructor(
    maxAccuracyM = PHONE_MAX_ACCURACY_M,
    opts: { startedMs?: number; imuCap?: number } = {},
  ) {
    this.maxAccuracyM = maxAccuracyM;
    this.startedMs = opts.startedMs ?? Date.now();
    this.imuCap = opts.imuCap ?? 200_000;
  }

  get lastRow(): ContractRow | null {
    return this.rows.length ? this.rows[this.rows.length - 1] : null;
  }

  ingestPosition(p: PhonePosition): PhoneUpdate {
    const out: PhoneUpdate = { row: null, drag: [], laps: [] };
    const row = positionToRow(p);
    const last = this.lastRow;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return out;
    if (last && row.timestampMs <= last.timestampMs) {
      this.duplicates++;
      return out;
    }
    this.rows.push(row);
    this.gnssRate.push(row.timestampMs);
    out.row = row;

    if (!this.drag && this.rows.length >= PHONE_WARMUP_FIXES) {
      // Rate is now known: configure drag and feed it everything so far, so a
      // desktop replay of the same CSV (which carries drag_max_gap_s) is identical.
      this.dragMaxGapS = gapForIntervalMs(this.gnssRate.medianIntervalMs());
      this.drag = new DragEngine(phoneDragConfig(this.dragMaxGapS, this.maxAccuracyM));
      for (const r of this.rows) out.drag.push(...this.drag.push(rowToDragSample(r)));
    } else if (this.drag) {
      out.drag.push(...this.drag.push(rowToDragSample(row)));
    }
    if (this.lap) out.laps.push(...this.lap.push(rowToFix(row)));
    return out;
  }

  ingestMotion(m: PhoneMotion): void {
    const r = motionToImu(m);
    if (!Number.isFinite(r.tMs)) return;
    this.imuRate.push(r.tMs);
    if (this.imu.length < this.imuCap) this.imu.push(r);
  }

  /** Start lap timing on a compiled track. Laps count from the next fixes on. */
  setTrack(track: CompiledTrack, name: string) {
    this.lap = new GpsLapEngine(track, { quality: phoneQuality(this.maxAccuracyM) });
    this.trackName = name;
  }

  finish(): PhoneUpdate {
    return {
      row: null,
      drag: this.drag ? this.drag.flush() : [],
      laps: this.lap ? this.lap.flush() : [],
    };
  }

  /** Contract CSV (§6) with the metadata replay:gps needs to reproduce this session. */
  gnssCsv(userAgent = ""): string {
    const meta = [
      `# source=phone`,
      `# hdop_is_accuracy_m=1`,
      `# max_accuracy_m=${this.maxAccuracyM}`,
      Number.isFinite(this.dragMaxGapS) ? `# drag_max_gap_s=${this.dragMaxGapS}` : null,
      `# date=${new Date(this.startedMs).toISOString()}`,
      this.trackName ? `# track_file=${this.trackName}` : null,
      userAgent ? `# device=${userAgent.replace(/[\r\n]/g, " ")}` : null,
    ].filter((x): x is string => x !== null);
    return `${meta.join("\n")}\n${RECORDING_HEADER}\n${this.rows.map(formatRow).join("\n")}\n`;
  }

  imuCsv(): string {
    const f = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : "");
    return (
      "t_ms,ax_ms2,ay_ms2,az_ms2,ax_g_ms2,ay_g_ms2,az_g_ms2,rot_alpha_dps,rot_beta_dps,rot_gamma_dps\n" +
      this.imu
        .map((r) =>
          [
            Math.round(r.tMs),
            f(r.ax, 3),
            f(r.ay, 3),
            f(r.az, 3),
            f(r.gxAcc, 3),
            f(r.gyAcc, 3),
            f(r.gzAcc, 3),
            f(r.rAlpha, 2),
            f(r.rBeta, 2),
            f(r.rGamma, 2),
          ].join(","),
        )
        .join("\n") +
      "\n"
    );
  }
}

/**
 * Replay settings for a CSV recorded by the phone screen (`# source=phone`),
 * so `replay:gps` times it with the same configuration the phone used.
 * Returns null for device recordings.
 */
export function phoneReplayOptions(meta: Record<string, string>): {
  quality: QualityConfig;
  drag: Partial<DragConfig>;
  gapThresholdMs: number;
} | null {
  if (meta.source !== "phone") return null;
  const acc = Number(meta.max_accuracy_m);
  const maxAcc = Number.isFinite(acc) && acc > 0 ? acc : PHONE_MAX_ACCURACY_M;
  const g = Number(meta.drag_max_gap_s);
  const gap = Number.isFinite(g) && g > 0 ? g : 2.5;
  return {
    quality: phoneQuality(maxAcc),
    drag: phoneDragConfig(gap, maxAcc),
    gapThresholdMs: Math.round(gap * 1000),
  };
}
