import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionEngine, csvFor } from "../../timer/engine.ts";
import { TRACKS } from "../../timer/tracks.ts";

/** Drive the browser preview engine the way the store does (≤ 50 ms slices). */
function run(engine: SessionEngine, seconds: number) {
  let crossings = 0;
  let sectors = 0;
  for (let t = 0; t < seconds; t += 0.05) {
    const ev = engine.step(0.05);
    if (ev.crossed) crossings++;
    if (ev.sectorCrossed != null) sectors++;
  }
  return { crossings, sectors };
}

describe("browser SessionEngine on GPS timing", () => {
  it("defaults to the GNSS pipeline and produces laps from 10 Hz fixes", () => {
    const e = new SessionEngine(TRACKS[0]);
    assert.equal(e.timing, "gps");
    e.arm();
    const lapS = e.refLapS * e.pace;
    const { crossings, sectors } = run(e, lapS * 3.5);
    assert.ok(e.laps.length >= 2, `laps=${e.laps.length}`);
    assert.equal(crossings, e.laps.length);
    assert.ok(sectors >= 2 * (TRACKS[0].sectors.length - 1));
    for (const lap of e.laps) {
      // car follows the speed profile exactly; GNSS noise only moves the timing slightly
      assert.ok(Math.abs(lap.timeS - lapS) < 0.25, `lap ${lap.timeS} vs ${lapS}`);
      assert.equal(lap.valid, true);
      assert.ok(lap.splits.every((s) => s != null && s > 0));
    }
    assert.equal(e.bestS, Math.min(...e.laps.map((l) => l.timeS)));
    assert.ok(e.armed);
    assert.ok(e.lapElapsed >= 0 && e.lapElapsed < lapS + 5);
    assert.ok(csvFor(e.laps, []).includes("lap,"));
  });

  it("synthetic timing is still available for UI work", () => {
    const e = new SessionEngine(TRACKS[1]);
    e.timing = "synthetic";
    e.arm();
    run(e, e.refLapS * e.pace * 2.5);
    assert.ok(e.laps.length >= 1);
    assert.ok(e.laps.every((l) => l.splits.every((s) => typeof s === "number")));
  });

  it("pause/resume does not corrupt GNSS timing", () => {
    const ref = new SessionEngine(TRACKS[0]);
    ref.arm();
    run(ref, ref.refLapS * ref.pace * 3.2);
    const e = new SessionEngine(TRACKS[0]);
    e.arm();
    run(e, e.refLapS * e.pace * 1.4);
    e.pause();
    const frozen = { laps: e.laps.length, elapsed: e.elapsed, fixes: e.gps.stats.fixes };
    for (let i = 0; i < 400; i++)
      assert.deepEqual(e.step(0.05), { crossed: false, sectorCrossed: null });
    assert.equal(e.elapsed, frozen.elapsed);
    assert.equal(e.gps.stats.fixes, frozen.fixes); // no fixes while paused
    e.resume();
    run(e, e.refLapS * e.pace * 1.8);
    assert.ok(e.laps.length >= 2);
    // same seed/path → identical laps whether or not we paused in the middle
    e.laps.forEach((lap, i) =>
      assert.ok(Math.abs(lap.timeS - ref.laps[i].timeS) < 1e-9, `lap ${i + 1}`),
    );
    assert.ok(e.gps.stats.rejected.time === 0);
  });

  it("reset clears GPS state and keeps the timing source", () => {
    let e = new SessionEngine(TRACKS[0]);
    e.arm();
    run(e, e.refLapS * 2.5);
    assert.ok(e.laps.length > 0);
    e = e.reset();
    assert.equal(e.laps.length, 0);
    assert.equal(e.gps.laps.length, 0);
    e = e.reset(TRACKS[2]);
    assert.equal(e.timing, "gps");
    assert.equal(e.compiled.id, "fast");
  });
});
