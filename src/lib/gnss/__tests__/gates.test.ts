import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GateDetector, type GateCrossing } from "../gates.ts";
import { checkFixQuality, DEFAULT_QUALITY } from "../fix.ts";
import { GpsLapEngine } from "../lap-engine.ts";
import { compileTrack, perpendicularGate, type GeoTrackDef } from "../track.ts";
import { LocalFrame } from "../geo.ts";
import { Centerline } from "../centerline.ts";
import { circleTrack, fixAt, ORIGIN } from "./fixtures.ts";

const track = circleTrack();
const L = track.centerline.lengthM;

/** Drive forward at constant v from s0 for `secs` at 10 Hz into a detector. */
function drive(
  det: GateDetector,
  opts: {
    t0?: number;
    s0: number;
    v?: number;
    secs: number;
    e?: number;
    courseFlip?: boolean;
    jitter?: (k: number) => number;
  },
) {
  const out: GateCrossing[] = [];
  const v = opts.v ?? 30;
  const t0 = opts.t0 ?? 1000;
  const n = Math.round(opts.secs * 10);
  for (let k = 0; k <= n; k++) {
    const t = t0 + k * 0.1;
    const s = opts.s0 + v * k * 0.1 + (opts.jitter ? opts.jitter(k) : 0);
    out.push(...det.push(fixAt(track, t, s, v, opts.e ?? 0, opts.courseFlip)));
  }
  return { out, tEnd: t0 + n * 0.1, sEnd: opts.s0 + v * n * 0.1 };
}

describe("GPS quality filtering", () => {
  const ok = { t: 1, lat: 9, lon: -79, sats: 10, hdop: 0.9, fixType: 3 };
  it("accepts a good fix", () => assert.equal(checkFixQuality(ok, DEFAULT_QUALITY, 0), "ok"));
  it("rejects low sats, high HDOP, no fix, NaN, repeated/backwards time", () => {
    assert.equal(checkFixQuality({ ...ok, sats: 4 }, DEFAULT_QUALITY, 0), "sats");
    assert.equal(checkFixQuality({ ...ok, hdop: 3.1 }, DEFAULT_QUALITY, 0), "hdop");
    assert.equal(checkFixQuality({ ...ok, fixType: 0 }, DEFAULT_QUALITY, 0), "no_fix");
    assert.equal(checkFixQuality({ ...ok, lat: NaN }, DEFAULT_QUALITY, 0), "not_finite");
    assert.equal(checkFixQuality({ ...ok, lat: 91 }, DEFAULT_QUALITY, 0), "not_finite");
    assert.equal(checkFixQuality(ok, DEFAULT_QUALITY, 1), "time");
    assert.equal(checkFixQuality(ok, DEFAULT_QUALITY, 2), "time");
  });
  it("engine drops bad fixes and off-track fixes before they reach the gates", () => {
    const eng = new GpsLapEngine(track);
    const p = track.centerline.pointAt(10);
    const g = track.frame.toGeo(p.x, p.y);
    const far = track.frame.toGeo(p.x - p.ty * 60, p.y + p.tx * 60);
    eng.push({ t: 1, lat: g.lat, lon: g.lon, sats: 3, hdop: 1 });
    eng.push({ t: 2, lat: g.lat, lon: g.lon, sats: 10, hdop: 9 });
    eng.push({ t: 3, lat: far.lat, lon: far.lon, sats: 10, hdop: 1 });
    eng.push({ t: 4, lat: g.lat, lon: g.lon, sats: 10, hdop: 1 });
    eng.push({ t: 4, lat: g.lat, lon: g.lon, sats: 10, hdop: 1 });
    assert.equal(eng.stats.rejected.sats, 1);
    assert.equal(eng.stats.rejected.hdop, 1);
    assert.equal(eng.stats.rejected.cross_track, 1);
    assert.equal(eng.stats.rejected.time, 1);
    assert.equal(eng.stats.accepted, 1);
  });
});

describe("gate crossing", () => {
  it("detects one crossing with an accurate refined time", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    // start 100 m before S/F at 30 m/s → crossing at t0 + 100/30
    const { out } = drive(det, { s0: sf - 100 + L, secs: 8 });
    const sfc = out.filter((c) => c.gate === 0);
    assert.equal(sfc.length, 1);
    const expected = 1000 + 100 / 30;
    assert.ok(Math.abs(sfc[0].t - expected) < 0.002, `t=${sfc[0].t} expected ${expected}`);
    assert.equal(sfc[0].method, "doppler");
  });

  it("does not trigger when driving the wrong way", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    let out: GateCrossing[] = [];
    for (let k = 0; k < 80; k++) {
      out = out.concat(det.push(fixAt(track, 1000 + k * 0.1, sf + 100 - 3 * k, 30, 0, true)));
    }
    assert.equal(out.length, 0);
  });

  it("direction filter rejects a crossing whose course points backwards", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    const { out } = drive(det, { s0: sf - 100 + L, secs: 8, courseFlip: true });
    assert.equal(out.filter((c) => c.gate === 0).length, 0);
    assert.ok(det.rejections.wrong_direction >= 1);
  });

  it("speed filter rejects a crawl across the line", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    const { out } = drive(det, { s0: sf - 5 + L, v: 1.5, secs: 8 });
    assert.equal(out.length, 0);
    assert.ok(det.rejections.slow >= 1);
  });

  it("movement threshold rejects a stationary car with jitter", () => {
    const det = new GateDetector(track, { minSpeedMs: 0 });
    const sf = track.gates[0].s;
    // speed reported 5 m/s but position just jitters ±0.6 m around the line
    let out: GateCrossing[] = [];
    for (let k = 0; k < 60; k++) {
      const s = sf + (k % 2 === 0 ? -0.6 : 0.6);
      out = out.concat(det.push({ ...fixAt(track, 1000 + k * 0.1, s, 5), speedMs: 5 }));
    }
    assert.equal(out.length, 0);
    assert.ok(det.rejections.no_movement >= 1);
  });

  it("rejects a crossing outside the gate width", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    const { out } = drive(det, { s0: sf - 100 + L, secs: 8, e: 22 }); // gate half-width 12 + 5 margin
    assert.equal(out.length, 0);
    assert.ok(det.rejections.outside_gate >= 1);
  });

  it("rejects a crossing across a data gap", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    const out: GateCrossing[] = [];
    for (let k = 0; k < 30; k++)
      out.push(...det.push(fixAt(track, 1000 + k * 0.1, sf - 120 + 3 * k, 30)));
    // 3 s outage across the line
    for (let k = 0; k < 30; k++)
      out.push(...det.push(fixAt(track, 1006 + k * 0.1, sf + 60 + 3 * k, 30)));
    assert.equal(out.length, 0);
    assert.ok(det.rejections.gap >= 1);
  });

  it("suppresses duplicates from along-track jitter at the line", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    // ±4 m alternating jitter makes s cross the line several times
    const { out } = drive(det, {
      s0: sf - 60 + L,
      v: 20,
      secs: 8,
      jitter: (k) => (k % 2 ? 4 : -4),
    });
    assert.equal(out.filter((c) => c.gate === 0).length, 1);
  });

  it("cooldown rejects a second crossing too soon after the first", () => {
    const det = new GateDetector(track, { cooldownS: 30, rearmDistanceM: 80 });
    const sf = track.gates[0].s;
    const a = drive(det, { s0: sf - 100 + L, secs: 8 }); // crosses, ends ~140 m past
    assert.equal(a.out.length, 1);
    // teleport back before the line (e.g. pit-lane loop) and cross again 5 s later
    const b = drive(det, { t0: a.tEnd + 0.1, s0: sf - 100 + L, secs: 8 });
    assert.equal(b.out.filter((c) => c.gate === 0).length, 0);
    assert.ok(det.rejections.cooldown >= 1);
  });

  it("re-arms after the car has left the gate zone", () => {
    const det = new GateDetector(track);
    const sf = track.gates[0].s;
    const lap = drive(det, { s0: sf - 100 + L, secs: L / 30 + 6 });
    assert.equal(lap.out.filter((c) => c.gate === 0).length, 2);
    const t = lap.out.filter((c) => c.gate === 0).map((c) => c.t);
    assert.ok(Math.abs(t[1] - t[0] - L / 30) < 0.002);
  });
});

describe("track compilation", () => {
  const frame = new LocalFrame(ORIGIN);
  const local = Array.from({ length: 120 }, (_, i) => {
    const a = (2 * Math.PI * i) / 120;
    return { x: 150 * Math.cos(a), y: 150 * Math.sin(a) };
  });
  const cl = new Centerline(local);
  const g = (s: number, i: number) =>
    perpendicularGate(cl, frame, s, 10, {
      id: `g${i}`,
      name: `g${i}`,
      kind: i === 0 ? "start_finish" : "sector",
    });
  const base: GeoTrackDef = {
    id: "t",
    name: "t",
    origin: ORIGIN,
    centerline: local.map((p) => frame.toGeo(p.x, p.y)),
    gates: [g(0, 0), g(300, 1), g(600, 2)],
  };
  it("compiles gates onto the centerline in driving order", () => {
    const ct = compileTrack(base);
    assert.equal(ct.gates.length, 3);
    assert.ok(Math.abs(ct.gates[1].s - 300) < 0.5);
    assert.ok(Math.abs(ct.gates[0].halfWidthM - 10) < 1e-6);
  });
  it("rejects out-of-order sector gates", () => {
    assert.throws(
      () => compileTrack({ ...base, gates: [g(0, 0), g(600, 1), g(300, 2)] }),
      /out of driving order/,
    );
  });
  it("rejects a gate whose left/right are swapped (wrong forward direction)", () => {
    const bad = { ...g(300, 1) };
    [bad.left, bad.right] = [bad.right, bad.left];
    assert.throws(() => compileTrack({ ...base, gates: [g(0, 0), bad] }), /forward direction/);
  });
  it("rejects a gate that does not cross the centerline", () => {
    const off = {
      id: "x",
      name: "x",
      kind: "sector" as const,
      left: frame.toGeo(500, 500),
      right: frame.toGeo(500, 520),
    };
    assert.throws(() => compileTrack({ ...base, gates: [g(0, 0), off] }), /does not cross/);
  });
  it("requires start/finish first", () => {
    assert.throws(() => compileTrack({ ...base, gates: [g(300, 1)] }), /start_finish/);
  });
});
