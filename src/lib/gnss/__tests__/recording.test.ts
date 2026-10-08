import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CsvRecorder,
  MemorySink,
  parseRecording,
  replayRecording,
  fixToRow,
  rowToFix,
  formatRow,
  RECORDING_HEADER,
  type ContractRow,
  type ReplayResult,
} from "../recording.ts";
import { GpsLapEngine } from "../lap-engine.ts";
import { simulate } from "../sim.ts";
import { compileTrack } from "../track.ts";
import { geoTrackFromSynthetic } from "../synthetic.ts";
import { TRACKS } from "../../timer/tracks.ts";
import type { GnssFix } from "../fix.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/recording");
const club = compileTrack(geoTrackFromSynthetic(TRACKS.find((t) => t.id === "club")!));
const fast = compileTrack(geoTrackFromSynthetic(TRACKS.find((t) => t.id === "fast")!));

/** Determinism fingerprint: laps + sector events + gate crossings + timing, JSON-stable. */
function fingerprint(r: ReplayResult): string {
  return JSON.stringify({
    laps: r.laps.map((l) => ({
      n: l.number,
      t: l.timeS,
      s: l.splits,
      v: l.valid,
      m: l.maxSpeedMs,
    })),
    sectors: r.sectorEvents.map((e) => ({ t: e.t, lap: e.lap, s: e.sector, d: e.splitS })),
    gates: r.gateCrossings.map((c) => ({
      g: c.gate,
      t: c.t,
      n: c.nFixes,
      kmh: c.speedMs * 3.6,
    })),
    timing: r.timingEvents.map((e) => ({ type: e.type, t: e.t })),
  });
}

describe("recording format (contract §6)", () => {
  it("fixToRow → rowToFix round-trips the engine contract without loss", () => {
    const f: GnssFix = {
      t: 345600.05,
      lat: 8.98446955,
      lon: -79.518639,
      speedMs: 39.1,
      courseDeg: 242.2,
      sats: 15,
      hdop: 0.92,
      fixType: 3,
    };
    const row = fixToRow(f);
    assert.equal(row.timestampMs, 345600050);
    assert.equal(row.speedKmh, 140.76);
    const back = rowToFix(row);
    assert.equal(back.t, f.t);
    assert.equal(back.lat, f.lat);
    assert.equal(back.lon, f.lon);
    assert.equal(back.fixType, 3);
    assert.ok(Math.abs(back.speedMs! - f.speedMs!) < 1e-9);
  });

  it("formatRow uses fixed contract precision with empty for 'not reported'", () => {
    const row: ContractRow = {
      timestampMs: 1234567890,
      lat: 8.98369827,
      lon: -79.5197651,
      speedKmh: null,
      headingDeg: 240.2,
      satellites: 14,
      hdop: 0.874,
      fixQuality: 1,
      altitudeM: null,
      mcuMs: null,
      line: -1,
    };
    assert.equal(formatRow(row), "1234567890,8.98369827,-79.51976510,,240.2,14,0.87,1,,");
  });

  it("the golden fixture is a valid 10 Hz contract file", () => {
    const text = readFileSync(join(FIXTURES, "golden_10hz.csv"), "utf8");
    const p = parseRecording(text);
    assert.equal(p.meta.track, "club");
    assert.equal(p.rows[0].timestampMs, 345600000);
    // 10 Hz nominal step
    assert.ok(p.rows.length > 5000);
    for (let i = 1; i < p.rows.length; i++) {
      const dt = p.rows[i].timestampMs - p.rows[i - 1].timestampMs;
      assert.ok(dt >= 0, `non-monotonic at row ${i}`);
    }
    assert.ok(p.rows.some((r) => r.speedKmh !== null)); // Doppler reported
  });
});

describe("deterministic replay (same file, twice → identical)", () => {
  it("golden_10hz.csv replays to identical laps, sectors, gates and timing", () => {
    const text = readFileSync(join(FIXTURES, "golden_10hz.csv"), "utf8");
    const a = fingerprint(replayRecording(text, club));
    const b = fingerprint(replayRecording(text, club));
    assert.equal(a, b);
    // and there is actually a session to fingerprint
    const r = replayRecording(text, club);
    assert.ok(r.laps.length > 5, `laps=${r.laps.length}`);
    assert.ok(r.sectorEvents.length > 10, `sectors=${r.sectorEvents.length}`);
    assert.ok(r.gateCrossings.length > 5, `gates=${r.gateCrossings.length}`);
    assert.ok(r.bestLap);
  });

  it("recorder → parse → replay is closed and deterministic for a fresh stream", () => {
    const fixes: GnssFix[] = [];
    simulate(club, { laps: 4, noiseM: 1.5, seed: 3 }, (f) => fixes.push(f));
    const sink = new MemorySink();
    const rec = new CsvRecorder(sink, { meta: { track: "club" }, chunkRows: 7 });
    for (const f of fixes) rec.enqueue(fixToRow(f));
    rec.flush();
    const a = fingerprint(replayRecording(sink.toString(), club));
    const b = fingerprint(replayRecording(sink.toString(), club));
    assert.equal(a, b);
  });
});

describe("gap detection", () => {
  it("flags a gap > 100 ms and reports duplicates/backwards timestamps", () => {
    const text = [
      "# apex-chrono gnss v1",
      RECORDING_HEADER,
      "1000000,8.98,-79.52,100,0,12,0.8,3,,",
      "1000100,8.98,-79.52,100,0,12,0.8,3,,", // ok (100 ms)
      "1000500,8.98,-79.52,100,0,12,0.8,3,,", // gap 400 ms
      "1000500,8.98,-79.52,100,0,12,0.8,3,,", // duplicate
      "1000300,8.98,-79.52,100,0,12,0.8,3,,", // backwards
    ].join("\n");
    const p = parseRecording(text);
    const kinds = p.warnings.map((w) => w.kind);
    assert.ok(kinds.includes("gap"));
    assert.ok(kinds.includes("duplicate_time"));
    assert.ok(kinds.includes("backwards_time"));
  });

  it("rejects, never re-times, duplicate/backwards fixes in the engine", () => {
    const text = [
      "# apex-chrono gnss v1",
      RECORDING_HEADER,
      "1000000,8.9844,-79.5186,100,0,12,0.8,3,,",
      "1000100,8.9844,-79.5186,100,0,12,0.8,3,,",
      "1000100,8.9844,-79.5186,100,0,12,0.8,3,,", // duplicate
      "1000000,8.9844,-79.5186,100,0,12,0.8,3,,", // backwards
      "1000200,8.9845,-79.5186,100,0,12,0.8,3,,",
    ].join("\n");
    const r = replayRecording(text, club);
    assert.equal(r.stats.fixes, 5);
    assert.equal(r.stats.rejected.time, 2); // two dropped by the stream-order check
  });
});

describe("malformed-data handling", () => {
  it("skips unparseable rows with a warning and keeps timing on the rest", () => {
    const good = "1000000,8.9844,-79.5186,100,0,12,0.8,3,,";
    const text = [
      "# apex-chrono gnss v1",
      RECORDING_HEADER,
      good,
      "not,a,row", // malformed (missing numbers)
      "1000100,not_a_lat,-79.51,100,0,12,0.8,3,,", // malformed lat
      "1000200,8.9845,-79.5186,nope,0,12,0.8,3,,", // malformed speed → "not reported"
      good,
    ].join("\n");
    const p = parseRecording(text);
    assert.equal(p.malformedLines, 2);
    assert.ok(p.warnings.some((w) => w.kind === "malformed"));
    assert.equal(p.rows.length, 3);
    // the malformed speed row survived with speedKmh === null (not reported)
    assert.equal(p.rows[1].speedKmh, null);
  });

  it("flags zero positions, out-of-range speed and low-SNR runs without dropping", () => {
    const text = [
      "# apex-chrono gnss v1",
      RECORDING_HEADER,
      "1000000,0.0,0.0,500,0,12,0.8,3,,", // zero pos + speed out of range
      "1000100,8.9844,-79.5186,90,0,4,0.8,3,,", // low sats (run)
      "1000200,8.9844,-79.5186,90,0,5,0.8,3,,", // still low (run of 2)
      "1000300,8.9845,-79.5186,90,0,12,0.8,3,,", // recovered
    ].join("\n");
    const p = parseRecording(text);
    assert.ok(p.warnings.some((w) => w.kind === "zero_position"));
    assert.ok(p.warnings.some((w) => w.kind === "speed_out_of_range"));
    assert.ok(p.warnings.some((w) => w.kind === "low_sats_run" && w.count === 2));
    assert.equal(p.rows.length, 4); // all kept; the engine drops the bad ones
  });
});

describe("stress: 10 Hz / 30-minute / 18,000 fixes", () => {
  it("replays the full stress file quickly and keeps exact detections", () => {
    const text = readFileSync(join(FIXTURES, "stress_30min_18000.csv"), "utf8");
    const p = parseRecording(text);
    assert.equal(p.rows.length, 18000);
    const durMs = p.rows[p.rows.length - 1].timestampMs - p.rows[0].timestampMs;
    assert.ok(Math.abs(durMs / 1000 - 1800) < 5, `duration ${durMs / 1000}s`);
    const t0 = performance.now();
    const r = replayRecording(text, fast);
    const elapsedMs = performance.now() - t0;
    assert.equal(r.stats.fixes, 18000);
    assert.ok(r.laps.length > 30, `laps=${r.laps.length}`);
    assert.ok(r.laps.every((l) => l.valid));
    assert.ok(elapsedMs < 15000, `replay took ${elapsedMs.toFixed(0)} ms`);
    console.log(`stress: ${r.laps.length} laps in ${elapsedMs.toFixed(0)} ms`);
  });

  it("is deterministic at stress scale", () => {
    const text = readFileSync(join(FIXTURES, "stress_30min_18000.csv"), "utf8");
    assert.equal(
      fingerprint(replayRecording(text, fast)),
      fingerprint(replayRecording(text, fast)),
    );
  });
});

describe("logging failure never stops timing", () => {
  it("a failing sink is counted and the engine still produces identical laps", () => {
    const fixes: GnssFix[] = [];
    simulate(club, { laps: 4, noiseM: 1.5, seed: 5 }, (f) => fixes.push(f));
    // baseline: no logger
    const engA = new GpsLapEngine(club);
    for (const f of fixes) engA.push(f);
    engA.flush();
    // with a logger whose sink always throws after the 1st chunk
    let writes = 0;
    const rec = new CsvRecorder(
      {
        write() {
          writes++;
          throw new Error("SD write failed");
        },
      },
      { chunkRows: 16, failBeforeStop: 1000 },
    );
    const engB = new GpsLapEngine(club);
    for (const f of fixes) {
      rec.enqueue(fixToRow(f)); // turns into writes, which throw
      engB.push(f);
    }
    rec.flush();
    engB.flush();
    assert.ok(writes >= 2, `sink was exercised (${writes} writes)`);
    assert.ok(rec.failures >= 2, `failures counted (${rec.failures})`);
    assert.ok(rec.rowsLogged === 0); // none made it to the sink
    assert.deepEqual(
      engB.laps.map((l) => [l.number, l.timeS, l.splits, l.valid]),
      engA.laps.map((l) => [l.number, l.timeS, l.splits, l.valid]),
    );
  });

  it("a partially-failing logger (then recovers) logs the good rows and never blocks", () => {
    const row = (i: number): ContractRow => ({
      timestampMs: 1000000 + i * 100,
      lat: 8.9844,
      lon: -79.5186,
      speedKmh: 100,
      headingDeg: 0,
      satellites: 12,
      hdop: 0.8,
      fixQuality: 3,
      altitudeM: null,
      mcuMs: null,
      line: -1,
    });
    const outer = new MemorySink();
    // A sink that fails once (first write) then behaves normally.
    let first = true;
    const rec = new CsvRecorder(
      {
        write(c: string) {
          if (first) {
            first = false;
            throw new Error("first chunk lost");
          }
          outer.write(c);
        },
      },
      { chunkRows: 3, failBeforeStop: 100 },
    );
    for (let i = 0; i < 9; i++) rec.enqueue(row(i));
    rec.flush();
    assert.equal(rec.failures, 1); // only the header write threw
    assert.equal(rec.rowsLogged, 3); // the 3 data chunks got through
    assert.equal(
      outer
        .toString()
        .split("\n")
        .filter((l) => l).length,
      9,
    ); // all 9 rows recovered
  });
});
