import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordingStats } from "../recording-stats.ts";
import { LocalFrame } from "../geo.ts";
import type { ContractRow } from "../recording.ts";

const frame = new LocalFrame({ lat: 8.98, lon: -79.52 });

function row(
  tMs: number,
  x: number,
  y: number,
  speedKmh: number | null,
  over: Partial<ContractRow> = {},
): ContractRow {
  const p = frame.toGeo(x, y);
  return {
    timestampMs: tMs,
    lat: p.lat,
    lon: p.lon,
    speedKmh,
    headingDeg: null,
    satellites: 12,
    hdop: 0.9,
    fixQuality: 1,
    altitudeM: null,
    mcuMs: null,
    line: -1,
    ...over,
  };
}

describe("recordingStats (receiver health for the physical test)", () => {
  it("measures a clean 10 Hz stationary session: rate and position spread", () => {
    // 600 rows parked, evenly spread on a 1.5 m circle around the true point.
    const rows = Array.from({ length: 600 }, (_, i) => {
      const a = (i / 600) * 2 * Math.PI * 7;
      return row(1_000_000 + i * 100, 1.5 * Math.cos(a), 1.5 * Math.sin(a), 0.3);
    });
    const s = recordingStats(rows);
    assert.equal(s.rows, 600);
    assert.ok(Math.abs(s.rateHz - 10) < 1e-9);
    assert.equal(s.nominalIntervalShare, 1);
    assert.equal(s.maxIntervalMs, 100);
    assert.equal(s.stationaryRows, 600);
    assert.ok(Math.abs(s.stationaryDurationS - 59.9) < 1e-9);
    assert.ok(Math.abs(s.stationaryP95M - 1.5) < 0.01, `p95 ${s.stationaryP95M}`);
    assert.equal(s.duplicates, 0);
    assert.equal(s.backwards, 0);
  });

  it("flags gaps, duplicates, backwards time, no-fix rows and low satellites", () => {
    const rows = [
      row(0, 0, 0, 50),
      row(100, 1, 0, 50),
      row(100, 2, 0, 50), // duplicate
      row(600, 3, 0, 50), // 500 ms gap
      row(550, 4, 0, 50), // backwards
      row(650, 5, 0, 50, { fixQuality: 0, satellites: 4, hdop: 9.9 }),
    ];
    const s = recordingStats(rows);
    assert.equal(s.duplicates, 1);
    assert.equal(s.backwards, 1);
    assert.equal(s.maxIntervalMs, 500);
    assert.equal(s.noFixRows, 1);
    assert.equal(s.satsMin, 4);
    assert.ok(Number.isNaN(s.stationaryP95M)); // nothing parked
  });

  it("uses the longest stationary run only (several stops are not mixed)", () => {
    const rows: ContractRow[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) rows.push(row((t += 100), 0, 0, 0)); // stop A
    for (let i = 0; i < 20; i++) rows.push(row((t += 100), i * 3, 0, 40)); // drive
    for (let i = 0; i < 100; i++) rows.push(row((t += 100), 500 + (i % 2) * 0.4, 0, 0.5)); // stop B
    const s = recordingStats(rows);
    assert.equal(s.stationaryRows, 100);
    assert.ok(s.stationaryP95M < 0.25, `p95 ${s.stationaryP95M}`); // B alone, not A↔B (500 m)
  });
});
