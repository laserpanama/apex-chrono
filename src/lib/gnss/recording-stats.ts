/**
 * Receiver-health statistics for a recorded session (contract §6 rows).
 * Used by `replay:gps` and by docs/V1_5_TEST_PROCEDURE.md §6 (10 Hz) and
 * §10 (stationary): it reads only what the receiver reported, never the
 * timing engine.
 */

import { LocalFrame } from "./geo.ts";
import type { ContractRow } from "./recording.ts";

export type RecordingStats = {
  rows: number;
  durationS: number;
  rateHz: number;
  /** share of consecutive-row intervals within 100 ± 10 ms */
  nominalIntervalShare: number;
  maxIntervalMs: number;
  duplicates: number;
  backwards: number;
  satsMin: number;
  satsMedian: number;
  hdopMedian: number;
  hdopP95: number;
  noFixRows: number;
  /** longest run of rows below `stationaryKmh` */
  stationaryRows: number;
  stationaryDurationS: number;
  /** 95th-percentile horizontal distance from that run's mean position, metres; NaN if the run is < 50 rows */
  stationaryP95M: number;
};

const quantile = (sorted: number[], q: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]
    : NaN;

export function recordingStats(rows: ContractRow[], stationaryKmh = 2): RecordingStats {
  const n = rows.length;
  let duplicates = 0;
  let backwards = 0;
  let nominal = 0;
  let intervals = 0;
  let maxInterval = 0;
  for (let i = 1; i < n; i++) {
    const dt = rows[i].timestampMs - rows[i - 1].timestampMs;
    if (dt === 0) duplicates++;
    else if (dt < 0) backwards++;
    else {
      intervals++;
      if (dt >= 90 && dt <= 110) nominal++;
      if (dt > maxInterval) maxInterval = dt;
    }
  }
  const durationS = n > 1 ? (rows[n - 1].timestampMs - rows[0].timestampMs) / 1000 : 0;

  const sats = rows
    .map((r) => r.satellites)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const hdop = rows
    .map((r) => r.hdop)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  // Longest contiguous stationary run (a parked car, not several stops mixed).
  let best: [number, number] = [0, 0];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const v = i < n ? rows[i].speedKmh : null;
    const still = v !== null && Number.isFinite(v) && v < stationaryKmh;
    if (still && start < 0) start = i;
    if (!still && start >= 0) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = -1;
    }
  }
  const run = rows.slice(best[0], best[1]);
  let p95 = NaN;
  if (run.length >= 50) {
    const lat = run.reduce((a, r) => a + r.lat, 0) / run.length;
    const lon = run.reduce((a, r) => a + r.lon, 0) / run.length;
    const frame = new LocalFrame({ lat, lon });
    const d = run
      .map((r) => {
        const p = frame.toLocal(r.lat, r.lon);
        return Math.hypot(p.x, p.y);
      })
      .sort((a, b) => a - b);
    p95 = quantile(d, 0.95);
  }

  return {
    rows: n,
    durationS,
    rateHz: durationS > 0 ? (n - 1) / durationS : 0,
    nominalIntervalShare: intervals ? nominal / intervals : 0,
    maxIntervalMs: maxInterval,
    duplicates,
    backwards,
    satsMin: sats.length ? sats[0] : NaN,
    satsMedian: quantile(sats, 0.5),
    hdopMedian: quantile(hdop, 0.5),
    hdopP95: quantile(hdop, 0.95),
    noFixRows: rows.filter((r) => r.fixQuality !== null && r.fixQuality <= 0).length,
    stationaryRows: run.length,
    stationaryDurationS:
      run.length > 1 ? (run[run.length - 1].timestampMs - run[0].timestampMs) / 1000 : 0,
    stationaryP95M: p95,
  };
}
