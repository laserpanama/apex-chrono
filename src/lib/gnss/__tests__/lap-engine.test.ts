import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GpsLapEngine, type TimingEvent } from "../lap-engine.ts";
import { simulate, mulberry32 } from "../sim.ts";
import { runScenario } from "../validate.ts";
import { compileTrack } from "../track.ts";
import { geoTrackFromSynthetic } from "../synthetic.ts";
import { TRACKS } from "../../timer/tracks.ts";
import type { GnssFix } from "../fix.ts";
import { circleTrack } from "./fixtures.ts";

const club = compileTrack(geoTrackFromSynthetic(TRACKS[0]));

function runEngine(
  track = club,
  sim: Parameters<typeof simulate>[1] = { laps: 4, noiseM: 0 },
  drop?: (f: GnssFix) => boolean,
) {
  const eng = new GpsLapEngine(track);
  const events: TimingEvent[] = [];
  const res = simulate(track, sim, (f) => {
    if (drop && drop(f)) return;
    events.push(...eng.push(f));
  });
  events.push(...eng.flush());
  return { eng, events, res };
}

describe("sector / lap state machine", () => {
  it("first start/finish crossing opens lap 1 without recording a lap", () => {
    const eng = new GpsLapEngine(club);
    const ev: TimingEvent[] = [];
    let opened: TimingEvent | null = null;
    const res = simulate(club, { laps: 1, noiseM: 0 }, (f) => {
      const e = eng.push(f);
      ev.push(...e);
      if (!opened) opened = e.find((x) => x.type === "lap_start") ?? null;
    });
    assert.ok(opened, "lap_start emitted");
    assert.equal((opened as unknown as { lap: number }).lap, 1);
    assert.ok(Math.abs((opened as unknown as { t: number }).t - res.gateTimes[0][0]) < 0.01);
    assert.equal(eng.laps.length, 1); // exactly one closed lap after 2 S/F crossings
  });

  it("closes laps with GNSS-timestamp lap times and sector splits that sum to the lap", () => {
    const { eng, res } = runEngine();
    assert.equal(eng.laps.length, 4);
    const sf = res.gateTimes[0];
    eng.laps.forEach((lap, k) => {
      const truth = sf[k + 1] - sf[k];
      assert.ok(Math.abs(lap.timeS - truth) < 0.01, `lap ${k + 1}: ${lap.timeS} vs ${truth}`);
      assert.equal(lap.valid, true);
      assert.equal(lap.splits.length, club.gates.length);
      const sum = lap.splits.reduce<number>((a, b) => a + (b ?? NaN), 0);
      assert.ok(Math.abs(sum - lap.timeS) < 1e-9);
      assert.ok(lap.maxSpeedMs > 20 && lap.maxSpeedMs < 60);
      assert.equal(lap.number, k + 1);
    });
  });

  it("best / previous lap and deltas", () => {
    const { eng } = runEngine(club, { laps: 6, noiseM: 0 });
    const best = eng.laps.reduce((a, b) => (b.timeS < a.timeS ? b : a));
    assert.equal(eng.bestLap, best);
    const live = eng.live();
    assert.equal(live.previousLap, eng.laps[eng.laps.length - 1]);
    assert.ok(
      Math.abs((live.previousDeltaS ?? NaN) - (live.previousLap!.timeS - best.timeS)) < 1e-12,
    );
    assert.equal(live.phase, "in_lap");
    assert.equal(live.lapNumber, 7);
  });

  it("live delta vs best lap is near zero when the same pace repeats", () => {
    // Circle at constant speed → every lap identical → delta ≈ 0 mid-lap.
    const track = circleTrack();
    const eng = new GpsLapEngine(track);
    const L = track.centerline.lengthM;
    const v = 30;
    let delta: number | null = null;
    for (let k = 0; k < Math.round(((3.5 * L) / v) * 10); k++) {
      const t = 5000 + k * 0.1;
      const s = track.gates[0].s - 50 + v * k * 0.1;
      const p = track.centerline.pointAt(s);
      const g = track.frame.toGeo(p.x, p.y);
      eng.push({
        t,
        lat: g.lat,
        lon: g.lon,
        speedMs: v,
        courseDeg: (Math.atan2(p.tx, p.ty) * 180) / Math.PI,
        sats: 12,
        hdop: 0.8,
      });
      if (eng.laps.length >= 2) delta = eng.live().liveDeltaS;
    }
    assert.ok(eng.bestLap);
    assert.ok(delta !== null && Math.abs(delta) < 0.05, `delta=${delta}`);
  });

  it("rejects a sector gate crossed out of order and marks the lap invalid", () => {
    // Drop every fix for 3 s around the 2nd lap's sector-1 gate: S1 is missed,
    // so the S2 crossing is out of order and must be rejected.
    const truth = simulate(club, { laps: 3, noiseM: 0 }, () => {}).gateTimes;
    const tMiss = truth[1].find((t) => t > truth[0][1])!;
    const { eng, events } = runEngine(
      club,
      { laps: 3, noiseM: 0 },
      (f) => Math.abs(f.t - tMiss) < 1.5,
    );
    const rej = events.filter((e) => e.type === "rejected_order");
    assert.equal(rej.length, 1);
    assert.equal((rej[0] as { gate: number }).gate, 2);
    assert.equal(eng.laps.length, 3);
    assert.equal(eng.laps[1].valid, false);
    assert.equal(eng.laps[1].splits[0], null);
    assert.equal(eng.laps[0].valid, true);
    assert.equal(eng.laps[2].valid, true);
    assert.notEqual(eng.bestLap, eng.laps[1]);
  });

  it("sector crossings before the first start/finish are ignored", () => {
    const { events } = runEngine(club, { laps: 1, noiseM: 0, runInM: 1200 });
    assert.ok(events.some((e) => e.type === "ignored_before_start"));
  });

  it("timing depends only on GNSS timestamps, not on the time base", () => {
    const a = runEngine(club, { laps: 3, noiseM: 1.5, startT: 1000 }).eng.laps.map((l) => l.timeS);
    const b = runEngine(club, { laps: 3, noiseM: 1.5, startT: 501000 }).eng.laps.map(
      (l) => l.timeS,
    );
    a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-6));
  });

  it("works without Doppler speed/course (position-only receivers)", () => {
    const { eng, res } = runEngine(club, {
      laps: 3,
      noiseM: 0,
      reportSpeed: false,
      reportCourse: false,
    });
    assert.equal(eng.laps.length, 3);
    const sf = res.gateTimes[0];
    eng.laps.forEach((lap, k) => assert.ok(Math.abs(lap.timeS - (sf[k + 1] - sf[k])) < 0.01));
    assert.ok(eng.laps.every((l) => l.maxSpeedMs > 20));
  });

  it("tolerates degraded and dropped fixes", () => {
    const r = runScenario(club, { laps: 20, noiseM: 1.5, badFixRate: 0.05, dropRate: 0.02 });
    assert.ok(r.qualityRejected > 0);
    assert.equal(r.missedLaps, 0);
    assert.equal(r.duplicateLaps, 0);
  });
});

describe("GPS jumps and the start/finish seam", () => {
  it("along-track distance is continuous and forward through the start/finish seam", () => {
    const eng = new GpsLapEngine(club);
    const L = club.centerline.lengthM;
    let prev: number | null = null;
    let crossedSeam = 0;
    let maxStep = 0;
    simulate(club, { laps: 2, noiseM: 0, speedNoiseMs: 0, courseNoiseDeg: 0 }, (f) => {
      eng.push(f);
      const m = eng.lastMatch!;
      assert.ok(Number.isFinite(m.s) && Number.isFinite(m.e));
      assert.ok(m.s >= 0 && m.s < L);
      if (prev !== null) {
        const d = club.centerline.delta(m.s, prev);
        assert.ok(d > 0, `s went backwards: ${prev} → ${m.s}`);
        if (d > maxStep) maxStep = d;
        if (m.s < prev) crossedSeam++;
      }
      prev = m.s;
    });
    assert.ok(crossedSeam >= 2, "drove through the seam");
    assert.ok(maxStep < 8, `max per-fix step ${maxStep} m at 10 Hz`);
  });

  it("isolated multi-metre jumps (multipath spikes) create no false or duplicate laps", () => {
    const truth = simulate(club, { laps: 10, noiseM: 1.5 }, () => {}).gateTimes;
    const eng = new GpsLapEngine(club);
    let k = 0;
    simulate(club, { laps: 10, noiseM: 1.5 }, (f) => {
      k++;
      // every 37th fix: 35 m jump (along and across track, alternating), including near gates
      if (k % 37 === 0) {
        const p = club.frame.toLocal(f.lat, f.lon);
        const j = k % 74 === 0 ? { x: 35, y: 0 } : { x: 0, y: -35 };
        const g = club.frame.toGeo(p.x + j.x, p.y + j.y);
        eng.push({ ...f, lat: g.lat, lon: g.lon });
      } else eng.push(f);
    });
    eng.flush();
    assert.equal(eng.laps.length, 10);
    eng.laps.forEach((lap, i) =>
      assert.ok(Math.abs(lap.timeS - (truth[0][i + 1] - truth[0][i])) < 0.1),
    );
    assert.ok(eng.laps.every((l) => l.valid));
  });

  it("a 2 s outage away from the gates does not disturb timing; matcher recovers", () => {
    const truth = simulate(club, { laps: 3, noiseM: 0.5 }, () => {}).gateTimes;
    const mid = (truth[0][1] + truth[1][1]) / 2; // between S/F and sector 1 of lap 1
    const { eng } = runEngine(
      club,
      { laps: 3, noiseM: 0.5 },
      (f) => f.t > mid - 1 && f.t < mid + 1,
    );
    assert.equal(eng.laps.length, 3);
    assert.ok(eng.laps.every((l) => l.valid));
    eng.laps.forEach((lap, i) =>
      assert.ok(Math.abs(lap.timeS - (truth[0][i + 1] - truth[0][i])) < 0.03),
    );
  });

  it("all-bad-HDOP stretch across the line: that lap is lost, never invented", () => {
    const truth = simulate(club, { laps: 4, noiseM: 0.5 }, () => {}).gateTimes;
    const tLine = truth[0][2];
    const eng = new GpsLapEngine(club);
    simulate(club, { laps: 4, noiseM: 0.5 }, (f) =>
      eng.push(Math.abs(f.t - tLine) < 1.5 ? { ...f, hdop: 6 } : f),
    );
    eng.flush();
    // S/F crossing #3 is unobservable → laps 2 and 3 merge into one ~2-lap record. Its sectors were all
    // seen in order the first time round, so only the "sector 1 while waiting for S/F" rule can catch it.
    const sfDetected = eng.laps.length + 1;
    assert.equal(sfDetected, truth[0].length - 1);
    const merged = eng.laps[1];
    assert.ok(merged.timeS > 1.8 * eng.laps[0].timeS);
    assert.equal(merged.valid, false);
    assert.notEqual(eng.bestLap, merged);
    assert.ok(eng.detector.rejections.gap >= 1);
    assert.ok(eng.stats.rejected.hdop > 20);
  });
});

describe("GNSS noise scenarios (CI subset, 40 laps each)", () => {
  // Generous bounds for the quick suite; the full 1000-lap run is `npm run validate:gps`.
  const bounds: Record<number, number> = {
    0: 0.01,
    0.5: 0.03,
    1.5: 0.08,
    3: 0.15,
    5: 0.25,
    10: 0.5,
  };
  for (const noiseM of [0, 0.5, 1.5, 3, 5, 10]) {
    it(`${noiseM} m noise: every lap and sector detected once, P95 lap error < ${bounds[noiseM]} s`, () => {
      const r = runScenario(club, { laps: 40, noiseM, seed: 11 });
      assert.equal(r.truthLaps, 40);
      assert.equal(r.missedLaps, 0);
      assert.equal(r.duplicateLaps, 0);
      assert.equal(r.missedSectors, 0);
      assert.equal(r.duplicateSectors, 0);
      assert.ok(r.lapError.p95AbsS < bounds[noiseM], `p95=${r.lapError.p95AbsS}`);
    });
  }
});

describe("determinism", () => {
  const hashFixes = (seed: number) => {
    const h = createHash("sha256");
    simulate(club, { laps: 2, noiseM: 3, seed }, (f) => {
      h.update(`${f.t},${f.lat},${f.lon},${f.speedMs},${f.courseDeg},${f.sats},${f.hdop};`);
    });
    return h.digest("hex");
  };
  it("same seed → bit-identical fixes", () => assert.equal(hashFixes(5), hashFixes(5)));
  it("different seed → different fixes", () => assert.notEqual(hashFixes(5), hashFixes(6)));
  it("same seed → identical scenario results", () => {
    const a = runScenario(club, { laps: 15, noiseM: 5, seed: 3 });
    const b = runScenario(club, { laps: 15, noiseM: 5, seed: 3 });
    assert.deepEqual({ ...a, runtimeMs: 0 }, { ...b, runtimeMs: 0 });
  });
  it("PRNG is reproducible", () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    for (let i = 0; i < 100; i++) assert.equal(r1(), r2());
  });
});

describe("all synthetic tracks compile and time cleanly", () => {
  for (const t of TRACKS) {
    it(t.id, () => {
      const ct = compileTrack(geoTrackFromSynthetic(t));
      assert.equal(ct.gates.length, t.sectors.length);
      const r = runScenario(ct, { laps: 10, noiseM: 1.5 });
      assert.equal(r.missedLaps, 0);
      assert.equal(r.duplicateLaps, 0);
      assert.equal(r.validLaps, 10);
    });
  }
});
