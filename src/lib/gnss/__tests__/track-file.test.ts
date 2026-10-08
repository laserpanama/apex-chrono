import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatTrackFile,
  parseTrackFile,
  TrackFileError,
  MAX_TRACK_FILE_POINTS,
} from "../track-file.ts";
import { compileTrack, type GeoTrackDef } from "../track.ts";
import { geoTrackFromSynthetic } from "../synthetic.ts";
import { replayRecording } from "../recording.ts";
import { TRACKS } from "../../timer/tracks.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/recording");

function compiledShape(def: GeoTrackDef) {
  const ct = compileTrack(def);
  return {
    length: ct.centerline.lengthM,
    gates: ct.gates.map((g) => ({ kind: g.kind, s: g.s, w: g.halfWidthM, fx: g.fx, fy: g.fy })),
  };
}

describe(".track file (shared device/desktop track format)", () => {
  for (const t of TRACKS) {
    it(`round-trips the ${t.id} track to the same compiled geometry`, () => {
      const def = geoTrackFromSynthetic(t);
      const parsed = parseTrackFile(formatTrackFile(def), t.id);
      // toPrecision(17) is exact for doubles: geometry must match bit for bit.
      assert.deepEqual(compiledShape(parsed), compiledShape(def));
      assert.equal(parsed.gates.length, def.gates.length);
      assert.equal(parsed.gates[0].kind, "start_finish");
    });
  }

  it("replaying the golden recording with --track-file gives the same laps as the built-in track", () => {
    const club = geoTrackFromSynthetic(TRACKS.find((t) => t.id === "club")!);
    const text = readFileSync(join(FIXTURES, "golden_10hz.csv"), "utf8");
    const a = replayRecording(text, compileTrack(club));
    const b = replayRecording(
      text,
      compileTrack(parseTrackFile(formatTrackFile(club), "club.track")),
    );
    assert.ok(a.laps.length > 0);
    assert.deepEqual(
      b.laps.map((l) => [l.number, l.timeS, l.valid, l.splits]),
      a.laps.map((l) => [l.number, l.timeS, l.valid, l.splits]),
    );
  });

  it("accepts END, blank lines and CRLF like the device loader", () => {
    const club = geoTrackFromSynthetic(TRACKS.find((t) => t.id === "club")!);
    const text = ("\n" + formatTrackFile(club) + "END\nanything after END is ignored\n").replace(
      /\n/g,
      "\r\n",
    );
    assert.deepEqual(compiledShape(parseTrackFile(text)), compiledShape(club));
  });

  const base = [
    "origin 8.9 -79.5",
    "centerline 3",
    "8.9000 -79.5000",
    "8.9010 -79.5000",
    "8.9010 -79.5010",
    "gates 1",
    "SF 8.9001 -79.50005 8.9001 -79.49995",
  ];
  const bad: [string, string[], RegExp][] = [
    ["comment lines", ["# my track", ...base], /comments are not allowed/],
    ["missing origin", base.slice(1), /missing origin/],
    ["short point list", [...base.slice(0, 4), ...base.slice(5)], /declared 3 points but has 2/],
    ["extra point", [...base.slice(0, 5), "8.9 -79.5", ...base.slice(5)], /more centerline points/],
    ["non-numeric", [...base.slice(0, 2), "8.9x -79.5", ...base.slice(3)], /not a number/],
    [
      "latitude out of range",
      [...base.slice(0, 2), "98.9 -79.5", ...base.slice(3)],
      /out of range/,
    ],
    ["unknown gate kind", [...base.slice(0, 6), "GATE 1 2 3 4"], /SF\|SEC/],
    ["missing gate", [...base.slice(0, 5), "gates 2", base[6]], /gates declared 2 but has 1/],
    ["too many gates", [...base.slice(0, 5), "gates 17"], /more than 16 gates/],
    [
      "too many points",
      ["origin 8.9 -79.5", `centerline ${MAX_TRACK_FILE_POINTS + 1}`],
      /at most 1537/,
    ],
    ["stray line", [...base, "hello"], /more gates than the declared/],
  ];
  for (const [name, lines, re] of bad) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseTrackFile(lines.join("\n")),
        (e: unknown) => e instanceof TrackFileError && re.test(e.message),
      );
    });
  }

  it("a minimal hand-written file parses and compiles", () => {
    const def = parseTrackFile(base.join("\n"));
    assert.equal(def.centerline.length, 3);
    assert.doesNotThrow(() => compileTrack(def));
  });
});
