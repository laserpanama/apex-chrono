import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DragEngine,
  DragFlag,
  DEFAULT_DRAG,
  FT,
  MPH,
  rowToDragSample,
  type DragSample,
} from "../drag.ts";
import { simulateDrag, DEFAULT_RUN } from "../drag-sim.ts";

const S = (t: number, kmh: number, over: Partial<DragSample> = {}): DragSample => ({
  t,
  speedMs: kmh / 3.6,
  sats: 12,
  hdop: 0.8,
  fixType: 1,
  altM: NaN,
  ...over,
});

/** v = a·(t − tLaunch) up to vTopKmh, then brake at 8 m/s² to 0; sampled at hz from t=100. */
function constAccel(a: number, tLaunch: number, hz = 10, vTopKmh = 270, stillS = 2): DragSample[] {
  const out: DragSample[] = [];
  const vTop = vTopKmh / 3.6;
  const tTop = tLaunch + vTop / a;
  for (let i = 0; ; i++) {
    const t = 100 - stillS + i / hz;
    let v: number;
    if (t <= tLaunch) v = 0;
    else if (t <= tTop) v = a * (t - tLaunch);
    else v = vTop - 8 * (t - tTop);
    if (v <= 0 && t > tTop) break;
    out.push({ t, speedMs: v, sats: 12, hdop: 0.8, fixType: 1, altM: NaN });
  }
  return out;
}

function run(samples: DragSample[], cfg = {}) {
  const e = new DragEngine(cfg);
  const events = samples.flatMap((s) => e.push(s));
  events.push(...e.flush());
  return { e, events };
}

const idx = (kmh: number) => DEFAULT_DRAG.speedTargetsKmh.indexOf(kmh);

describe("drag engine — exact under constant acceleration", () => {
  for (const [hz, tLaunch] of [
    [10, 100],
    [10, 100.03],
    [25, 100.017],
    [5, 100.11],
  ] as const) {
    it(`${hz} Hz, launch at t=${tLaunch}: every target exact (rate-independent)`, () => {
      const a = 5;
      const { e } = run(constAccel(a, tLaunch, hz));
      assert.equal(e.runs.length, 1);
      const r = e.runs[0];
      assert.ok(r.valid, `flags ${r.flags}`);
      assert.ok(Math.abs(r.t0 - tLaunch) < 1e-9, `t0 ${r.t0}`);
      for (const [k, kmh] of DEFAULT_DRAG.speedTargetsKmh.entries())
        assert.ok(Math.abs(r.speedTimesS[k] - kmh / 3.6 / a) < 1e-9, `${kmh}: ${r.speedTimesS[k]}`);
      for (const [k, D] of DEFAULT_DRAG.distanceTargetsM.entries()) {
        const tt = Math.sqrt((2 * D) / a);
        assert.ok(Math.abs(r.distanceTimesS[k] - tt) < 1e-9, `${D} m: ${r.distanceTimesS[k]}`);
        assert.ok(Math.abs(r.trapKmh[k] - a * tt * 3.6) < 1e-7);
      }
      assert.ok(Math.abs(r.rangeTimesS[0] - (200 - 100) / 3.6 / a) < 1e-9);
      assert.ok(r.peakKmh <= 270 + 1e-9 && r.peakKmh > 262, `peak ${r.peakKmh}`);
      assert.equal(r.endReason, "lift");
    });
  }

  it("1 ft rollout: times start when the car has moved 0.3048 m", () => {
    const a = 5;
    const { e } = run(constAccel(a, 100.03), { rolloutM: FT });
    const r = e.runs[0];
    const tRoll = Math.sqrt((2 * FT) / a);
    assert.ok(Math.abs(r.tStart - (100.03 + tRoll)) < 1e-9);
    assert.ok(Math.abs(r.speedTimesS[idx(100)] - (100 / 3.6 / a - tRoll)) < 1e-9);
    assert.ok(Math.abs(r.distanceTimesS[2] - (Math.sqrt((2 * 1320 * FT) / a) - tRoll)) < 1e-9);
  });

  it("emits armed → launch → targets in order → end, with live elapsed time", () => {
    const e = new DragEngine();
    const types: string[] = [];
    let sawElapsed = false;
    for (const s of constAccel(5, 100.03)) {
      for (const ev of e.push(s))
        types.push(ev.type === "speed" || ev.type === "distance" ? ev.type[0] : ev.type);
      if (e.state === "running" && e.elapsedS() > 1) sawElapsed = true;
    }
    assert.equal(types[0], "armed");
    assert.equal(types[1], "launch");
    assert.equal(types.at(-1), "end");
    assert.equal(types.filter((x) => x === "s").length, 5);
    assert.equal(types.filter((x) => x === "d").length, 3);
    assert.ok(sawElapsed);
  });
});

describe("drag engine — arming, validity, end of run", () => {
  it("does not arm without a full stop of armHoldS (rolling start ignored)", () => {
    const { e } = run(constAccel(5, 100.03, 10, 270, 0.5));
    assert.equal(e.runs.length, 0);
  });

  it("needs a fresh stop to re-arm; two runs numbered 1, 2", () => {
    const a = constAccel(5, 100.03);
    const lastT = a.at(-1)!.t;
    const b = constAccel(4, 100.03).map((s) => ({ ...s, t: s.t - 98 + lastT + 0.1 }));
    const { e } = run([...a, ...b]);
    assert.deepEqual(
      e.runs.map((r) => [r.number, r.valid]),
      [
        [1, true],
        [2, true],
      ],
    );
    assert.ok(Math.abs(e.runs[1].speedTimesS[idx(100)] - 100 / 3.6 / 4) < 1e-9);
  });

  it("a GNSS gap ends the run as invalid; targets after the gap are not invented", () => {
    const s = constAccel(5, 100.03).filter((x) => !(x.t > 104 && x.t < 104.5));
    const { e } = run(s);
    const r = e.runs[0];
    assert.equal(r.endReason, "gap");
    assert.ok(!r.valid && r.flags & DragFlag.gap);
    assert.ok(Number.isFinite(r.speedTimesS[idx(60)])); // 103.36 s, before the gap
    assert.ok(Number.isNaN(r.speedTimesS[idx(100)]));
    assert.ok(Number.isNaN(r.distanceTimesS[2]));
  });

  it("low satellites mid-run: run kept, marked invalid (quality)", () => {
    const s = constAccel(5, 100.03).map((x) => (x.t > 102 && x.t < 102.4 ? { ...x, sats: 4 } : x));
    const r = run(s).e.runs[0];
    assert.equal(r.flags, DragFlag.quality);
    assert.ok(!r.valid);
    assert.ok(Math.abs(r.speedTimesS[idx(100)] - 100 / 3.6 / 5) < 1e-9);
  });

  it("no Doppler speed: never arms (positions alone are not used)", () => {
    const s = constAccel(5, 100.03).map((x) => ({ ...x, speedMs: NaN }));
    assert.equal(run(s).e.runs.length, 0);
  });

  it("missed launch (first moving fix already fast) is flagged late_launch", () => {
    const s = [...Array(20)].map((_, i) => S(100 + i * 0.1, 0));
    s.push(S(102, 25), S(102.1, 28), S(102.2, 10));
    const r = run(s).e.runs[0];
    assert.ok(r.flags & DragFlag.lateLaunch);
  });

  it("time that does not advance is ignored and counted", () => {
    const s = constAccel(5, 100.03);
    s.splice(40, 0, { ...s[39] });
    const { e } = run(s);
    assert.equal(e.rejectedTime, 1);
    assert.ok(e.runs[0].valid);
  });

  it("bad quality while stopped prevents arming", () => {
    const s = constAccel(5, 100.03).map((x) => (x.t < 100 ? { ...x, hdop: 5 } : x));
    assert.equal(run(s).e.runs.length, 0);
  });

  it("rejects a range whose ends are not speed targets", () => {
    assert.throws(() => new DragEngine({ rangesKmh: [[80, 120]] }));
  });

  it("converts contract rows like the firmware (km/h, ms, empty = not reported)", () => {
    const s = rowToDragSample({
      timestampMs: 123456,
      speedKmh: 36,
      satellites: 9,
      hdop: 1.1,
      fixQuality: null,
      altitudeM: null,
    });
    assert.equal(s.t, 123.456);
    assert.equal(s.speedMs, 10);
    assert.equal(s.fixType, -1);
    assert.ok(Number.isNaN(s.altM));
  });
});

describe("drag engine — accuracy on simulated BN-880Q-class data", () => {
  const targets = DEFAULT_DRAG.speedTargetsKmh;
  const dists = DEFAULT_DRAG.distanceTargetsM;
  for (const hz of [10, 25]) {
    it(`${hz} Hz, 0.18 km/h Doppler noise, gear shifts: within budget of truth`, () => {
      let worstSpeed = 0;
      let worstDist = 0;
      let worstTrap = 0;
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const { rows, truth } = simulateDrag(
          { rateHz: hz, noiseKmh: 0.18, seed, stillS: 3, runs: [DEFAULT_RUN] },
          targets,
          dists,
        );
        const { e } = run(rows.map(rowToDragSample));
        assert.equal(e.runs.length, 1, `seed ${seed}`);
        const r = e.runs[0];
        assert.ok(r.valid);
        for (const [k, kmh] of targets.entries())
          worstSpeed = Math.max(worstSpeed, Math.abs(r.speedTimesS[k] - truth[0].speedT.get(kmh)!));
        for (const [k, D] of dists.entries()) {
          worstDist = Math.max(worstDist, Math.abs(r.distanceTimesS[k] - truth[0].distT.get(D)!.t));
          worstTrap = Math.max(worstTrap, Math.abs(r.trapKmh[k] - truth[0].distT.get(D)!.kmh));
        }
      }
      // Budgets are for the SIMULATION (ideal antenna, Gaussian noise). Real
      // hardware is validated separately (docs/DRAG_MODE.md §5).
      assert.ok(worstSpeed < 0.1, `speed targets worst ${worstSpeed.toFixed(4)} s`);
      assert.ok(worstDist < 0.03, `distance targets worst ${worstDist.toFixed(4)} s`);
      assert.ok(worstTrap < 1.0, `trap worst ${worstTrap.toFixed(3)} km/h`);
    });
  }

  it("2 % uphill grade is reported as slope ≈ +2 %", () => {
    const { rows } = simulateDrag(
      { rateHz: 10, noiseKmh: 0.18, seed: 9, stillS: 3, runs: [{ ...DEFAULT_RUN, slopePct: 2 }] },
      targets,
      dists,
    );
    const r = run(rows.map(rowToDragSample)).e.runs[0];
    assert.ok(Math.abs(r.slopePct - 2) < 0.1, `slope ${r.slopePct}`);
  });

  it("0-60 mph target is 96.56 km/h", () => {
    assert.ok(Math.abs(60 * MPH - 96.56064) < 1e-9);
  });
});
