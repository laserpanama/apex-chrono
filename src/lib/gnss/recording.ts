/**
 * GNSS recording + deterministic replay (V1.5 Task 2).
 *
 * A recording is the raw contract stream (GNSS_DATA_CONTRACT.md §1/§6) saved
 * to CSV. Recording taps the stream BEFORE the adapter and observationally —
 * it can never change or block timing. Replay feeds the recordings back
 * through the SAME `GpsLapEngine` a live receiver uses, so a session logged on
 * the track reproduces bit-identical laps/sectors/gates/timing on the desktop.
 *
 * Load-bearing guarantees (all covered by tests):
 *  - recording is an observer: a failing sink (dead SD, full FS) is counted
 *    and never propagates into the engine;
 *  - replay is deterministic: feeding the same CSV twice yields identical
 *    laps, sector events, gate crossings and timing;
 *  - duplicate/backwards timestamps are reported and rejected by the engine,
 *    never re-timed or re-ordered;
 *  - gaps are flagged for the operator and, where they cross a gate, let the
 *    gate state machine reject the crossing (the lap is lost, never invented).
 */

import {
  GpsLapEngine,
  type GpsLapRecord,
  type TimingEvent,
  type LapEngineConfig,
} from "./lap-engine.ts";
import { type GateCrossing, type GateRejectReason } from "./gates.ts";
import type { GnssFix, QualityVerdict } from "./fix.ts";
import type { CompiledTrack } from "./track.ts";

/** One contract row as parsed/recorded. `null` = "not reported" per contract §1. */
export type ContractRow = {
  timestampMs: number;
  lat: number;
  lon: number;
  /** km/h; null = not reported (receiver gave no Doppler speed) */
  speedKmh: number | null;
  /** degrees true; null = not reported */
  headingDeg: number | null;
  satellites: number;
  hdop: number;
  /** GGA quality; null = not reported */
  fixQuality: number | null;
  altitudeM: number | null;
  mcuMs: number | null;
  /** 1-based CSV line this row came from (for warnings). -1 = generated, not read. */
  line: number;
};

/** Fixed header (contract §6); readers must locate by name and ignore unknown columns. */
export const RECORDING_HEADER =
  "timestamp_ms,latitude,longitude,speed_kmh,heading_deg,satellites,hdop,fix_quality,altitude_m,mcu_ms";

const NUM = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : "");
/** Format fixed precision per contract §6 (matches the C++ snprintf writer). */
export function formatRow(r: ContractRow): string {
  return [
    Math.round(r.timestampMs),
    r.lat.toFixed(8),
    r.lon.toFixed(8),
    r.speedKmh !== null ? NUM(r.speedKmh, 2) : "",
    r.headingDeg !== null ? NUM(r.headingDeg, 1) : "",
    Math.round(r.satellites),
    r.hdop !== null ? NUM(r.hdop, 2) : "",
    r.fixQuality !== null ? String(Math.round(r.fixQuality)) : "",
    r.altitudeM !== null ? NUM(r.altitudeM, 1) : "",
    r.mcuMs !== null ? String(Math.round(r.mcuMs)) : "",
  ].join(",");
}

/** Adapter §2: a contract row → engine `GnssFix` (SI units). The ONLY conversion into the engine. */
export function rowToFix(r: ContractRow): GnssFix {
  const f: GnssFix = {
    t: r.timestampMs / 1000,
    lat: r.lat,
    lon: r.lon,
    sats: r.satellites,
    hdop: r.hdop,
  };
  if (r.speedKmh !== null) f.speedMs = r.speedKmh / 3.6;
  if (r.headingDeg !== null) f.courseDeg = r.headingDeg;
  // GGA can't tell 2D from 3D: 0 → no fix, ≥1 → 3. Empty → unknown (undefined).
  if (r.fixQuality !== null) f.fixType = r.fixQuality <= 0 ? 0 : 3;
  return f;
}

/** Adapter §2 (reverse): engine `GnssFix` → a recordable contract row. Never generates values. */
export function fixToRow(f: GnssFix): ContractRow {
  return {
    timestampMs: Math.round(f.t * 1000),
    lat: f.lat,
    lon: f.lon,
    speedKmh:
      f.speedMs !== undefined && Number.isFinite(f.speedMs)
        ? Math.round(f.speedMs * 3.6 * 100) / 100
        : null,
    headingDeg: f.courseDeg !== undefined && Number.isFinite(f.courseDeg) ? f.courseDeg : null,
    satellites: Math.round(f.sats),
    hdop: f.hdop,
    fixQuality: f.fixType === undefined ? null : f.fixType,
    altitudeM: null,
    mcuMs: null,
    line: -1,
  };
}

/** k=metadata: `# key=value` comment lines. */
export type RecordingMeta = Record<string, string>;

/** A parse/quality diagnostic produced while reading or replaying a recording. */
export type ReplayWarning =
  | { kind: "gap"; line: number; dtMs: number; tMs: number }
  | { kind: "duplicate_time"; line: number; tMs: number }
  | { kind: "backwards_time"; line: number; tMs: number; prevTMs: number }
  | { kind: "malformed"; line: number; reason: string }
  | { kind: "zero_position"; line: number }
  | { kind: "speed_out_of_range"; line: number; speedKmh: number }
  | { kind: "low_sats_run"; line: number; count: number };

export type ParseResult = {
  meta: RecordingMeta;
  rows: ContractRow[];
  warnings: ReplayWarning[];
  /** count of lines that were wholly unparseable (skipped, not turned into rows) */
  malformedLines: number;
};

const parseNum = (s: string): number | undefined => {
  const t = s.trim();
  if (t === "") return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * Parse a recording CSV (contract §6). Lines are located by header name;
 * unknown columns are ignored; malformed optional values become "not
 * reported" with a warning; a row missing a required scalar (lat/lon) or with
 * an unparseable timestamp is skipped with a warning. Duplicate / backwards
 * timestamps are flagged (never re-timed) and gaps > gapThresholdMs are warned.
 */
export function parseRecording(text: string, opts: { gapThresholdMs?: number } = {}): ParseResult {
  const gapThresholdMs = opts.gapThresholdMs ?? 100; // nominal 10 Hz interval; contract §4
  const meta: RecordingMeta = {};
  const warnings: ReplayWarning[] = [];
  const rows: ContractRow[] = [];
  let malformedLines = 0;
  // lowest sats we ever mention in a run warning (contract §5 default). Callers may filter.
  let lastMs: number | null = null;
  let lowLine = 0;
  let lowCount = 0;

  // locate header by name (first line containing timestamp_ms among non-comment lines)
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let headerIdx: number[] | null = null;
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const s = ln.trimEnd();
    if (s.startsWith("#")) {
      const m = s
        .slice(1)
        .trim()
        .match(/^(\w[\w-]*)=(.*)$/);
      if (m) meta[m[1]] = m[2];
      continue;
    }
    if (s.trim() === "") {
      dataStart = i + 1;
      continue;
    }
    const cols = s.split(",").map((c) => c.trim());
    const idx = cols.indexOf("timestamp_ms");
    if (idx >= 0) {
      headerIdx = cols.map((c) => {
        switch (c) {
          case "timestamp_ms":
            return 0;
          case "latitude":
            return 1;
          case "longitude":
            return 2;
          case "speed_kmh":
            return 3;
          case "heading_deg":
            return 4;
          case "satellites":
            return 5;
          case "hdop":
            return 6;
          case "fix_quality":
            return 7;
          case "altitude_m":
            return 8;
          case "mcu_ms":
            return 9;
          default:
            return -1;
        }
      });
      dataStart = i + 1;
      break;
    }
    throw new Error(`recording: no header row with timestamp_ms (line ${i + 1})`);
  }
  if (!headerIdx) throw new Error("recording: empty file, no header row");

  const cell = (cols: string[], role: number): string =>
    role >= 0 && role < cols.length ? cols[role].trim() : "";

  for (let i = dataStart; i < lines.length; i++) {
    const s = lines[i].trimEnd();
    if (s.trim() === "" || s.trimStart().startsWith("#")) continue;
    const line = i + 1;
    const cols = s.split(",");
    const tMsRaw = parseNum(cell(cols, headerIdx[0]));
    const latRaw = parseNum(cell(cols, headerIdx[1]));
    const lonRaw = parseNum(cell(cols, headerIdx[2]));
    if (tMsRaw === undefined || latRaw === undefined || lonRaw === undefined) {
      malformedLines++;
      warnings.push({
        kind: "malformed",
        line,
        reason: "missing required timestamp_ms/latitude/longitude",
      });
      continue;
    }
    const tMs = Math.round(tMsRaw);
    const lat = latRaw;
    const lon = lonRaw;

    // timestamp stream → gap / duplicate / backwards diagnostics (contract §3/§4)
    if (lastMs === null) lastMs = tMs;
    else if (tMs === lastMs) {
      warnings.push({ kind: "duplicate_time", line, tMs });
    } else if (tMs < lastMs) {
      warnings.push({ kind: "backwards_time", line, tMs, prevTMs: lastMs });
    } else if (tMs - lastMs > gapThresholdMs) {
      warnings.push({ kind: "gap", line, dtMs: tMs - lastMs, tMs });
    }
    // advance last good stream clock only on strictly-increasing rows
    if (tMs > (lastMs ?? -Infinity)) lastMs = tMs;

    const satsRaw = parseNum(cell(cols, headerIdx[5]));
    const hdopRaw = parseNum(cell(cols, headerIdx[6]));
    const fixQ = parseNum(cell(cols, headerIdx[7]));
    const altRaw = parseNum(cell(cols, headerIdx[8]));
    const mcuRaw = parseNum(cell(cols, headerIdx[9]));
    const speedKmh = parseNum(cell(cols, headerIdx[3]));
    const headingDeg = parseNum(cell(cols, headerIdx[4]));

    if (lat === 0 && lon === 0) warnings.push({ kind: "zero_position", line });
    if (speedKmh !== undefined && (speedKmh < 0 || speedKmh > 400)) {
      warnings.push({ kind: "speed_out_of_range", line, speedKmh });
    }

    // low-sats run bookkeeping (contract §5: runs below the satellite threshold)
    const minSats = 6;
    if (satsRaw !== undefined && satsRaw < minSats) {
      if (lowCount === 0) lowLine = line;
      lowCount++;
    } else if (lowCount > 0) {
      warnings.push({ kind: "low_sats_run", line: lowLine, count: lowCount });
      lowCount = 0;
    }

    rows.push({
      timestampMs: tMs,
      lat,
      lon,
      speedKmh: speedKmh ?? null,
      headingDeg: headingDeg ?? null,
      satellites: satsRaw === undefined ? 0 : Math.round(satsRaw),
      hdop: hdopRaw ?? 99.9,
      fixQuality: fixQ === undefined ? null : Math.round(fixQ),
      altitudeM: altRaw ?? null,
      mcuMs: mcuRaw === undefined ? null : Math.round(mcuRaw),
      line,
    });
  }
  // trailing low-sats whitespace run, if the stream ends while degraded
  if (lowCount > 0) warnings.push({ kind: "low_sats_run", line: lowLine, count: lowCount });
  return { meta, rows, warnings, malformedLines };
}

/** A single recording sink. Implementations must never throw into the engine. */
export interface RecordingSink {
  write(chunk: string): void;
  close?(): void;
}

/** Null / in-memory sink — collects what would be written. */
export class MemorySink implements RecordingSink {
  chunks: string[] = [];
  write(c: string) {
    this.chunks.push(c);
  }
  toString() {
    return this.chunks.join("");
  }
}

/**
 * The raw logger (contract §6). It observes the contract stream and buffers
 * into a bounded ring so a slow/failing sink can't stall the caller.
 * - `enqueue` never throws: sink errors go to `failures` (and after
 *   `failBeforeStop` consecutive failures, the logger stops trying but still
 *   counts — timing is untouched either way).
 * - The header + metadata are written on the first row (or via `open()`).
 */
export class CsvRecorder {
  /** cumulative sink failures (never thrown to the caller) */
  failures = 0;
  rowsLogged = 0;
  /** true once the sink has failed enough times to stop trying */
  stopped = false;
  private buffer: string[] = [];
  private opened = false;
  private consecutive = 0;
  private readonly sink: RecordingSink;
  private readonly chunkRows: number;
  private readonly failBeforeStop: number;
  private readonly meta: RecordingMeta;
  constructor(
    sink: RecordingSink,
    opts: { meta?: RecordingMeta; chunkRows?: number; failBeforeStop?: number } = {},
  ) {
    this.sink = sink;
    this.chunkRows = opts.chunkRows ?? 64;
    this.failBeforeStop = opts.failBeforeStop ?? 3;
    this.meta = opts.meta ?? {};
  }

  /** Declare the metadata/header now (idempotent). */
  open(meta: RecordingMeta = this.meta) {
    if (this.opened || this.stopped) return;
    this.opened = true;
    const lines: string[] = ["# apex-chrono gnss v1"];
    for (const [k, v] of Object.entries(meta)) lines.push(`# ${k}=${v}`);
    lines.push(RECORDING_HEADER);
    this.safeWrite(lines.join("\n") + "\n");
  }

  /** Record one contract row (observational; never throws). */
  enqueue(row: ContractRow) {
    if (this.stopped) return;
    this.open();
    this.buffer.push(formatRow(row));
    if (this.buffer.length >= this.chunkRows) this.flush();
  }

  /** Flush any buffered rows to the sink. Errors are counted, never thrown. */
  flush() {
    if (this.stopped || this.buffer.length === 0) return;
    const chunk = this.buffer.join("\n") + "\n";
    this.buffer.length = 0;
    this.safeWrite(chunk);
  }

  private safeWrite(chunk: string) {
    try {
      this.sink.write(chunk);
      this.consecutive = 0;
      this.rowsLogged++;
    } catch {
      this.failures++;
      this.consecutive++;
      if (this.consecutive >= this.failBeforeStop && this.failBeforeStop !== 0) {
        this.stopped = true; // give up on this sink; timing continues regardless
      }
    }
  }
}

/** Collect the end-to-end outcome of replaying one recording file. */
export type ReplayResult = {
  meta: RecordingMeta;
  rows: ContractRow[];
  warnings: ReplayWarning[];
  /** engine stats after replay */
  stats: {
    fixes: number;
    accepted: number;
    rejected: Record<QualityVerdict | "cross_track", number>;
    crossings: number;
    gateRejections: Record<GateRejectReason, number>;
  };
  laps: GpsLapRecord[];
  bestLap: GpsLapRecord | null;
  sectorEvents: Extract<TimingEvent, { type: "sector" }>[];
  timingEvents: TimingEvent[];
  gateCrossings: GateCrossing[];
};

/**
 * Replay a recording through the SHARED timing engine. Pass the compiled
 * track the session ran on (or one mapped from `meta.track`).
 * Determinism: two replays of the same text yield deep-equal `laps`,
 * `sectorEvents`, `gateCrossings` and `timingEvents`.
 */
export function replayRecording(
  text: string,
  track: CompiledTrack,
  opts: { engine?: Partial<LapEngineConfig>; gapThresholdMs?: number } = {},
): ReplayResult {
  const parsed = parseRecording(text, opts);
  const eng = new GpsLapEngine(track, opts.engine);
  const timingEvents: TimingEvent[] = [];
  const gateCrossings: GateCrossing[] = [];
  eng.onCrossing = (c) => gateCrossings.push(c);
  for (const row of parsed.rows) {
    for (const ev of eng.push(rowToFix(row))) timingEvents.push(ev);
  }
  for (const ev of eng.flush()) timingEvents.push(ev);
  const sectorEvents = timingEvents.filter(
    (e): e is Extract<TimingEvent, { type: "sector" }> => e.type === "sector",
  );
  return {
    meta: parsed.meta,
    rows: parsed.rows,
    warnings: parsed.warnings,
    stats: {
      fixes: eng.stats.fixes,
      accepted: eng.stats.accepted,
      rejected: { ...eng.stats.rejected },
      crossings: eng.stats.crossings,
      gateRejections: { ...eng.detector.rejections },
    },
    laps: eng.laps,
    bestLap: eng.bestLap,
    sectorEvents,
    timingEvents,
    gateCrossings,
  };
}
