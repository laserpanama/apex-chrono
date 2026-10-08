/**
 * `.track` text format — the one track definition the device and the desktop
 * share (closes V1_5_ARCHITECTURE.md B7 for replay).
 *
 *   origin <lat> <lon>
 *   centerline <N>
 *   <lat> <lon>            × N   (closed loop, in the direction of travel)
 *   gates <G>
 *   SF  <leftLat> <leftLon> <rightLat> <rightLon>
 *   SEC <leftLat> <leftLon> <rightLat> <rightLon>   × (G − 1), in driving order
 *   END
 *
 * The firmware reads this exact text over serial (TimerService::loadTrackFrom)
 * and the parity fixtures are written with `formatTrackFile`. The parser is
 * deliberately as strict as the firmware is fragile: anything the device
 * would silently misread (comments, short point lists, extra tokens) is an
 * error here, so a file that passes `npm run track:check` loads the same way
 * on both sides.
 */

import type { GeoPoint } from "./geo.ts";
import { MAX_GATES, type GeoGateDef, type GeoTrackDef } from "./track.ts";

/** Firmware limit: APEX_MAX_CENTER_PTS (1536) + an optional repeated closing point. */
export const MAX_TRACK_FILE_POINTS = 1537;

const num = (x: number) => (Number.isFinite(x) ? x.toPrecision(17) : "nan");

export function formatTrackFile(def: GeoTrackDef): string {
  const origin = def.origin ?? def.centerline[0];
  const lines: string[] = [];
  lines.push(`origin ${num(origin.lat)} ${num(origin.lon)}`);
  lines.push(`centerline ${def.centerline.length}`);
  for (const p of def.centerline) lines.push(`${num(p.lat)} ${num(p.lon)}`);
  lines.push(`gates ${def.gates.length}`);
  for (const g of def.gates) {
    lines.push(
      `${g.kind === "start_finish" ? "SF" : "SEC"} ${num(g.left.lat)} ${num(g.left.lon)} ${num(g.right.lat)} ${num(g.right.lon)}`,
    );
  }
  return lines.join("\n") + "\n";
}

export class TrackFileError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

function parseCoord(tok: string, what: string, lineNo: number, lat: boolean): number {
  const v = Number(tok);
  if (tok === "" || !Number.isFinite(v))
    throw new TrackFileError(`${what} is not a number: "${tok}"`, lineNo);
  const lim = lat ? 90 : 180;
  if (Math.abs(v) > lim) throw new TrackFileError(`${what} out of range: ${v}`, lineNo);
  return v;
}

function parsePoint(a: string, b: string, what: string, lineNo: number): GeoPoint {
  return {
    lat: parseCoord(a, `${what} latitude`, lineNo, true),
    lon: parseCoord(b, `${what} longitude`, lineNo, false),
  };
}

function parseCount(tok: string | undefined, what: string, lineNo: number): number {
  const n = Number(tok);
  if (tok === undefined || !Number.isInteger(n) || n < 0) {
    throw new TrackFileError(`${what} count must be a non-negative integer`, lineNo);
  }
  return n;
}

export function parseTrackFile(text: string, id = "track-file", name = id): GeoTrackDef {
  const raw = text.split(/\r?\n/);
  let origin: GeoPoint | undefined;
  const centerline: GeoPoint[] = [];
  const gates: GeoGateDef[] = [];
  let wantPts = -1;
  let wantGates = -1;
  let mode: "head" | "points" | "gates" = "head";

  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    const line = raw[i].trim();
    if (line === "") continue;
    if (line === "END") break;
    if (line.startsWith("#")) {
      throw new TrackFileError(
        "comments are not allowed (the device loader would misread them)",
        lineNo,
      );
    }
    const tok = line.split(/\s+/);

    if (tok[0] === "origin") {
      if (tok.length !== 3) throw new TrackFileError("expected: origin <lat> <lon>", lineNo);
      if (origin) throw new TrackFileError("origin given twice", lineNo);
      origin = parsePoint(tok[1], tok[2], "origin", lineNo);
      continue;
    }
    if (tok[0] === "centerline") {
      if (tok.length !== 2) throw new TrackFileError("expected: centerline <N>", lineNo);
      if (wantPts >= 0) throw new TrackFileError("centerline given twice", lineNo);
      wantPts = parseCount(tok[1], "centerline", lineNo);
      if (wantPts > MAX_TRACK_FILE_POINTS) {
        throw new TrackFileError(
          `centerline has ${wantPts} points; the device accepts at most ${MAX_TRACK_FILE_POINTS}`,
          lineNo,
        );
      }
      mode = "points";
      continue;
    }
    if (tok[0] === "gates") {
      if (tok.length !== 2) throw new TrackFileError("expected: gates <G>", lineNo);
      if (wantGates >= 0) throw new TrackFileError("gates given twice", lineNo);
      if (mode === "points" && centerline.length !== wantPts) {
        throw new TrackFileError(
          `centerline declared ${wantPts} points but has ${centerline.length}`,
          lineNo,
        );
      }
      wantGates = parseCount(tok[1], "gates", lineNo);
      if (wantGates > MAX_GATES) throw new TrackFileError(`more than ${MAX_GATES} gates`, lineNo);
      mode = "gates";
      continue;
    }

    if (mode === "points") {
      if (centerline.length >= wantPts) {
        throw new TrackFileError(`more centerline points than the declared ${wantPts}`, lineNo);
      }
      if (tok.length !== 2) throw new TrackFileError("expected: <lat> <lon>", lineNo);
      centerline.push(
        parsePoint(tok[0], tok[1], `centerline point ${centerline.length + 1}`, lineNo),
      );
      continue;
    }
    if (mode === "gates") {
      if (gates.length >= wantGates)
        throw new TrackFileError(`more gates than the declared ${wantGates}`, lineNo);
      if (tok.length !== 5 || (tok[0] !== "SF" && tok[0] !== "SEC")) {
        throw new TrackFileError(
          "expected: SF|SEC <leftLat> <leftLon> <rightLat> <rightLon>",
          lineNo,
        );
      }
      const k = gates.length;
      gates.push({
        id: k === 0 ? "sf" : `s${k}`,
        name: k === 0 ? "Start/Finish" : `Sector ${k}`,
        kind: tok[0] === "SF" ? "start_finish" : "sector",
        left: parsePoint(tok[1], tok[2], `gate ${k + 1} left`, lineNo),
        right: parsePoint(tok[3], tok[4], `gate ${k + 1} right`, lineNo),
      });
      continue;
    }
    throw new TrackFileError(`unexpected line "${line}"`, lineNo);
  }

  if (!origin) throw new TrackFileError("missing origin line", 0);
  if (wantPts < 0) throw new TrackFileError("missing centerline section", 0);
  if (centerline.length !== wantPts) {
    throw new TrackFileError(
      `centerline declared ${wantPts} points but has ${centerline.length}`,
      0,
    );
  }
  if (wantGates < 0) throw new TrackFileError("missing gates section", 0);
  if (gates.length !== wantGates) {
    throw new TrackFileError(`gates declared ${wantGates} but has ${gates.length}`, 0);
  }
  return { id, name, origin, centerline, gates };
}
