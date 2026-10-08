import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PhoneSession,
  RateMeter,
  gapForIntervalMs,
  phoneReplayOptions,
  positionToRow,
  type PhonePosition,
} from "../phone.ts";
import { DragEngine, DEFAULT_DRAG, rowToDragSample } from "../drag.ts";
import { simulateDrag, DEFAULT_RUN } from "../drag-sim.ts";
import { parseRecording, replayRecording, type ContractRow } from "../recording.ts";
import { compileTrack } from "../track.ts";
import { geoTrackFromSynthetic } from "../synthetic.ts";
import { TRACKS } from "../../timer/tracks.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/recording");

/** What a browser would hand us for a recorded row (accuracy from the row's hdop). */
function asPosition(r: ContractRow, accuracyM = 3): PhonePosition {
  return {
    timestamp: r.timestampMs,
    coords: {
      latitude: r.lat,
      longitude: r.lon,
      accuracy: accuracyM,
      altitude: r.altitudeM,
      speed: r.speedKmh === null ? null : r.speedKmh / 3.6,
      heading: r.headingDeg,
    },
  };
}

describe("phone source — adapter", () => {
  it("maps a Geolocation position to a contract row without inventing values", () => {
    const r = positionToRow({
      timestamp: 1_700_000_000_123.4,
      coords: {
        latitude: 8.98,
        longitude: -79.52,
        accuracy: 4.567,
        altitude: null,
        speed: null,
        heading: NaN,
      },
    });
    assert.equal(r.timestampMs, 1_700_000_000_123);
    assert.equal(r.speedKmh, null);
    assert.equal(r.headingDeg, null);
    assert.equal(r.altitudeM, null);
    assert.equal(r.satellites, 0); // not reported by browsers
    assert.equal(r.hdop, 4.57); // accuracy in metres, by design
    const s = positionToRow({
      timestamp: 1,
      coords: {
        latitude: 0.1,
        longitude: 0.1,
        accuracy: 3,
        altitude: 12.34,
        speed: 10,
        heading: 90.04,
      },
    });
    assert.equal(s.speedKmh, 36);
    assert.equal(s.headingDeg, 90);
    assert.equal(s.altitudeM, 12.3);
  });

  it("drops re-delivered positions (same or older timestamp)", () => {
    const ps = new PhoneSession();
    const p = (t: number): PhonePosition => ({
      timestamp: t,
      coords: {
        latitude: 8.9,
        longitude: -79.5,
        accuracy: 3,
        altitude: null,
        speed: 0,
        heading: null,
      },
    });
    ps.ingestPosition(p(1000));
    ps.ingestPosition(p(1000));
    ps.ingestPosition(p(900));
    ps.ingestPosition(p(2000));
    assert.equal(ps.rows.length, 2);
    assert.equal(ps.duplicates, 2);
  });

  it("measures the fix rate and sizes the drag gap from it", () => {
    const m = new RateMeter();
    for (let i = 0; i < 11; i++) m.push(i * 1000);
    assert.equal(m.hz(), 1);
    assert.equal(m.medianIntervalMs(), 1000);
    assert.equal(gapForIntervalMs(1000), 2.5);
    assert.equal(gapForIntervalMs(100), 0.25);
    assert.equal(gapForIntervalMs(40), 0.25); // never looser than the device at 10 Hz… nor tighter
  });
});

describe("phone source — drag", () => {
  it("10 Hz phone: same run as the device engine, and the exported CSV replays identically", () => {
    const { rows } = simulateDrag(
      { rateHz: 10, noiseKmh: 0.18, seed: 31, stillS: 3, runs: [DEFAULT_RUN] },
      DEFAULT_DRAG.speedTargetsKmh,
      DEFAULT_DRAG.distanceTargetsM,
    );
    const ps = new PhoneSession();
    for (const r of rows) ps.ingestPosition(asPosition(r));
    ps.finish();
    assert.equal(ps.dragMaxGapS, 0.25);
    assert.equal(ps.drag!.runs.length, 1);
    const live = ps.drag!.runs[0];
    assert.ok(live.valid);

    // Desktop replay of the downloaded CSV with the options its metadata carries.
    const parsed = parseRecording(ps.gnssCsv());
    const opt = phoneReplayOptions(parsed.meta)!;
    assert.ok(opt);
    const d = new DragEngine(opt.drag);
    for (const r of parsed.rows) d.push(rowToDragSample(r));
    d.flush();
    assert.deepEqual(d.runs, ps.drag!.runs);
  });

  it("1 Hz phone (typical browser): runs are detected but the launch is flagged, not trusted", () => {
    const { rows } = simulateDrag(
      { rateHz: 1, noiseKmh: 0.18, seed: 32, stillS: 15, runs: [DEFAULT_RUN] },
      DEFAULT_DRAG.speedTargetsKmh,
      DEFAULT_DRAG.distanceTargetsM,
    );
    const ps = new PhoneSession();
    for (const r of rows) ps.ingestPosition(asPosition(r));
    ps.finish();
    assert.equal(ps.dragMaxGapS, 2.5);
    assert.equal(ps.drag!.runs.length, 1);
    const r = ps.drag!.runs[0];
    assert.ok(!r.valid, "a 1 Hz launch must not be presented as a valid run");
  });

  it("poor accuracy (> 10 m) never arms", () => {
    const { rows } = simulateDrag(
      { rateHz: 10, noiseKmh: 0.18, seed: 33, stillS: 3, runs: [DEFAULT_RUN] },
      DEFAULT_DRAG.speedTargetsKmh,
      DEFAULT_DRAG.distanceTargetsM,
    );
    const ps = new PhoneSession();
    for (const r of rows) ps.ingestPosition(asPosition(r, 25));
    ps.finish();
    assert.equal(ps.drag!.runs.length, 0);
  });

  it("device recordings get no phone options", () => {
    assert.equal(phoneReplayOptions({ track: "club" }), null);
  });
});

describe("phone source — laps", () => {
  it("golden 10 Hz recording fed as phone positions gives the same laps as the device replay", () => {
    const club = compileTrack(geoTrackFromSynthetic(TRACKS.find((t) => t.id === "club")!));
    const text = readFileSync(join(FIXTURES, "golden_10hz.csv"), "utf8");
    const device = replayRecording(text, club);
    const ps = new PhoneSession();
    ps.setTrack(club, "club");
    // The golden file has deliberately degraded stretches (low sats / high HDOP)
    // the device rejects; a phone reports those as poor accuracy instead.
    for (const r of parseRecording(text).rows)
      ps.ingestPosition(asPosition(r, r.satellites < 6 || r.hdop > 2.5 ? 30 : 2));
    ps.finish();
    assert.ok(device.laps.length > 0);
    assert.deepEqual(
      ps.lap!.laps.map((l) => [l.number, l.timeS, l.valid]),
      device.laps.map((l) => [l.number, l.timeS, l.valid]),
    );
  });
});
