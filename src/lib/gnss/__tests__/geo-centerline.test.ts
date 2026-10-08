import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalFrame, haversineM, courseToUnit, unitToCourse } from "../geo.ts";
import { Centerline, MapMatcher, projectPointToSegment } from "../centerline.ts";
import { ORIGIN } from "./fixtures.ts";

/** Vincenty inverse on WGS84 — independent ellipsoidal reference distance. */
function vincentyM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * rad));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
  const sU1 = Math.sin(U1),
    cU1 = Math.cos(U1),
    sU2 = Math.sin(U2),
    cU2 = Math.cos(U2);
  let lam = L;
  let sinS = 0,
    cosS = 0,
    sig = 0,
    cos2a = 0,
    cos2sm = 0;
  for (let i = 0; i < 200; i++) {
    const sl = Math.sin(lam),
      cl = Math.cos(lam);
    sinS = Math.sqrt((cU2 * sl) ** 2 + (cU1 * sU2 - sU1 * cU2 * cl) ** 2);
    if (sinS === 0) return 0;
    cosS = sU1 * sU2 + cU1 * cU2 * cl;
    sig = Math.atan2(sinS, cosS);
    const sinA = (cU1 * cU2 * sl) / sinS;
    cos2a = 1 - sinA * sinA;
    cos2sm = cos2a ? cosS - (2 * sU1 * sU2) / cos2a : 0;
    const C = (f / 16) * cos2a * (4 + f * (4 - 3 * cos2a));
    const prev = lam;
    lam =
      L + (1 - C) * f * sinA * (sig + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)));
    if (Math.abs(lam - prev) < 1e-13) break;
  }
  const u2 = (cos2a * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS =
    B *
    sinS *
    (cos2sm +
      (B / 4) *
        (cosS * (-1 + 2 * cos2sm * cos2sm) -
          (B / 6) * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)));
  return b * A * (sig - dS);
}

describe("coordinate conversion", () => {
  const frame = new LocalFrame(ORIGIN);

  it("origin maps to (0,0) and round-trips to < 1 mm", () => {
    const o = frame.toLocal(ORIGIN.lat, ORIGIN.lon);
    assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.y) < 1e-9);
    for (const [x, y] of [
      [0, 0],
      [1500, -800],
      [-2500, 2500],
      [0.3, 0.7],
    ]) {
      const g = frame.toGeo(x, y);
      const back = frame.toLocal(g.lat, g.lon);
      assert.ok(Math.hypot(back.x - x, back.y - y) < 1e-3, `round trip ${x},${y}`);
    }
  });

  it("east is +x, north is +y", () => {
    const e = frame.toLocal(ORIGIN.lat, ORIGIN.lon + 0.001);
    const n = frame.toLocal(ORIGIN.lat + 0.001, ORIGIN.lon);
    assert.ok(e.x > 100 && Math.abs(e.y) < 1e-9);
    assert.ok(n.y > 100 && Math.abs(n.x) < 1e-9);
  });

  it("local distances agree with WGS84 (Vincenty) within 5 cm over 3 km", () => {
    for (const [dx, dy] of [
      [3000, 0],
      [0, 3000],
      [2000, 2000],
      [-1200, 2600],
    ]) {
      const a = frame.toGeo(0, 0);
      const b = frame.toGeo(dx, dy);
      const flat = Math.hypot(dx, dy);
      const ref = vincentyM(a.lat, a.lon, b.lat, b.lon);
      assert.ok(Math.abs(flat - ref) < 0.05, `${dx},${dy}: flat ${flat} vs vincenty ${ref}`);
      // the spherical haversine is only ~0.5% accurate — it is not the reference
      assert.ok(Math.abs(haversineM(a, b) - ref) / ref < 0.01);
    }
  });

  it("metres per degree match WGS84 at the equator and 45°", () => {
    const eq = new LocalFrame({ lat: 0, lon: 0 });
    assert.ok(Math.abs(eq.mPerDegLat - 110574) < 2);
    assert.ok(Math.abs(eq.mPerDegLon - 111320) < 2);
    const mid = new LocalFrame({ lat: 45, lon: 0 });
    assert.ok(Math.abs(mid.mPerDegLat - 111132) < 2);
    assert.ok(Math.abs(mid.mPerDegLon - 78847) < 2);
  });

  it("handles the antimeridian", () => {
    const f = new LocalFrame({ lat: 0, lon: 179.9999 });
    const p = f.toLocal(0, -179.9999);
    assert.ok(p.x > 0 && p.x < 30, `x=${p.x}`);
  });

  it("course ↔ unit vector", () => {
    const n = courseToUnit(0);
    const e = courseToUnit(90);
    assert.ok(Math.abs(n.y - 1) < 1e-12 && Math.abs(e.x - 1) < 1e-12);
    assert.ok(Math.abs(unitToCourse(-1, 0) - 270) < 1e-9);
  });

  it("rejects invalid origins", () => {
    assert.throws(() => new LocalFrame({ lat: NaN, lon: 0 }));
    assert.throws(() => new LocalFrame({ lat: 89, lon: 0 }));
  });
});

describe("point-to-segment projection", () => {
  it("projects onto the interior", () => {
    const r = projectPointToSegment(5, 3, 0, 0, 10, 0);
    assert.equal(r.t, 0.5);
    assert.equal(r.x, 5);
    assert.equal(r.y, 0);
    assert.equal(r.dist2, 9);
  });
  it("clamps before A and after B", () => {
    const a = projectPointToSegment(-4, 3, 0, 0, 10, 0);
    assert.equal(a.t, 0);
    assert.equal(a.dist2, 25);
    const b = projectPointToSegment(13, -4, 0, 0, 10, 0);
    assert.equal(b.t, 1);
    assert.equal(b.dist2, 25);
  });
  it("degenerate segment returns endpoint", () => {
    const r = projectPointToSegment(3, 4, 1, 1, 1, 1);
    assert.equal(r.t, 0);
    assert.equal(r.dist2, 13);
  });
});

describe("centerline", () => {
  // 100 x 50 rectangle, CCW
  const rect = new Centerline([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
    { x: 0, y: 0 }, // explicit closing point is tolerated
  ]);

  it("closed-loop length and segment lookup", () => {
    assert.equal(rect.n, 4);
    assert.equal(rect.lengthM, 300);
    assert.equal(rect.segmentAt(0), 0);
    assert.equal(rect.segmentAt(120), 1);
    assert.equal(rect.segmentAt(299.9), 3);
    assert.equal(rect.segmentAt(300), 0);
    assert.equal(rect.segmentAt(-1), 3);
  });

  it("wrap and signed wraparound delta", () => {
    assert.equal(rect.wrap(-10), 290);
    assert.equal(rect.wrap(310), 10);
    assert.equal(rect.delta(5, 295), 10);
    assert.equal(rect.delta(295, 5), -10);
    assert.equal(rect.delta(100, 50), 50);
  });

  it("cross-track sign: left of travel is positive", () => {
    // travelling +x along y=0, left is +y
    const inside = rect.projectOnSegment(0, 40, 3);
    const outside = rect.projectOnSegment(0, 40, -3);
    assert.ok(Math.abs(inside.e - 3) < 1e-9);
    assert.ok(Math.abs(outside.e + 3) < 1e-9);
    assert.equal(inside.s, 40);
  });

  it("rejects degenerate input", () => {
    assert.throws(
      () =>
        new Centerline([
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]),
    );
    assert.throws(
      () =>
        new Centerline([
          { x: 0, y: 0 },
          { x: NaN, y: 1 },
          { x: 2, y: 2 },
        ]),
    );
  });
});

describe("map matching", () => {
  const rect = new Centerline([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
  ]);

  it("matches distance along centerline and cross-track", () => {
    const m = new MapMatcher(rect);
    const r = m.match(60, -2);
    assert.ok(Math.abs(r.s - 60) < 1e-9);
    assert.ok(Math.abs(r.crossTrackM + 2) < 1e-9);
    assert.equal(r.fullScan, true); // no history yet
    const r2 = m.match(100 + 1, 20);
    assert.ok(Math.abs(r2.s - 120) < 1e-9);
    assert.ok(Math.abs(r2.crossTrackM + 1) < 1e-9);
  });

  it("closed-loop wraparound: last segment → first segment", () => {
    // 1 m segments so the local window (not a full scan) handles the wrap.
    const pts = [];
    for (let x = 0; x < 100; x++) pts.push({ x, y: 0 });
    for (let y = 0; y < 50; y++) pts.push({ x: 100, y });
    for (let x = 100; x > 0; x--) pts.push({ x, y: 50 });
    for (let y = 50; y > 0; y--) pts.push({ x: 0, y });
    const rect = new Centerline(pts);
    const m = new MapMatcher(rect);
    const a = m.match(0.5, 10); // on the closing leg x=0, 10 m before the start
    assert.ok(Math.abs(a.s - 290) < 1e-9, `s=${a.s}`);
    const b = m.match(3, 0.4); // just past the start
    assert.ok(Math.abs(b.s - 3) < 1e-9);
    assert.equal(b.fullScan, false);
    assert.ok(Math.abs(rect.delta(b.s, a.s) - 13) < 1e-9);
  });

  it("local window keeps the match on the correct leg of a narrow loop", () => {
    // Two parallel 1 km straights 30 m apart, 4 m segments.
    const pts = [];
    for (let x = 0; x <= 1000; x += 4) pts.push({ x, y: 0 });
    for (let x = 1000; x >= 0; x -= 4) pts.push({ x, y: 30 });
    const cl = new Centerline(pts);
    const m = new MapMatcher(cl, { windowSegments: 8, fallbackDistanceM: 20 });
    m.match(500, 0); // establish history on the lower leg
    // 16 m above the lower leg, 14 m below the upper leg.
    const w = m.match(502, 16);
    assert.equal(w.fullScan, false);
    assert.ok(Math.abs(w.s - 502) < 1e-9, `windowed s=${w.s}`);
    assert.ok(Math.abs(w.crossTrackM - 16) < 1e-9);
    // A fresh matcher (no history) takes the nearest leg via full scan.
    const fresh = new MapMatcher(cl);
    const f = fresh.match(502, 16);
    assert.equal(f.fullScan, true);
    assert.ok(Math.abs(f.crossTrackM) < 14.0001 && f.s > 1000);
  });

  it("falls back to a full scan when the window result is implausible", () => {
    const pts = [];
    for (let x = 0; x <= 1000; x += 4) pts.push({ x, y: 0 });
    for (let x = 1000; x >= 0; x -= 4) pts.push({ x, y: 300 });
    const cl = new Centerline(pts);
    const m = new MapMatcher(cl, { windowSegments: 8, fallbackDistanceM: 25 });
    m.match(100, 0);
    const before = m.fullScans;
    const r = m.match(800, 1); // 700 m jump (e.g. after a long outage)
    assert.equal(r.fullScan, true);
    assert.equal(m.fullScans, before + 1);
    assert.ok(Math.abs(r.s - 800) < 1e-9);
    // and the next fix is windowed again
    assert.equal(m.match(804, 1).fullScan, false);
  });

  it("predicted distance re-centres the window", () => {
    const pts = [];
    for (let x = 0; x <= 2000; x += 4) pts.push({ x, y: 0 });
    pts.push({ x: 2000, y: 200 }, { x: 0, y: 200 });
    const cl = new Centerline(pts);
    const m = new MapMatcher(cl, { windowSegments: 4, fallbackDistanceM: 10 });
    m.match(100, 0);
    // 60 m further on — outside ±16 m of the last segment, inside the predicted window
    const r = m.match(160, 0.5, 160);
    assert.equal(r.fullScan, false);
    assert.ok(Math.abs(r.s - 160) < 1e-9);
  });
});
