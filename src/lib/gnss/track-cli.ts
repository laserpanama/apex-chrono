/**
 * `npm run track:check -- <file.track>`
 *
 * Validates a real-circuit `.track` file before test day: parses it with the
 * same strict rules the device loader needs, compiles it with the same
 * `compileTrack` the replay uses, and prints the numbers worth eyeballing
 * (length, gate positions along the lap, gate widths, point spacing).
 * Exit code 0 = the device and the desktop will load the same track.
 */

import { readFileSync } from "node:fs";
import { compileTrack } from "./track.ts";
import { parseTrackFile, MAX_TRACK_FILE_POINTS } from "./track-file.ts";

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npm run track:check -- <file.track>");
    process.exit(2);
  }
  let def;
  let ct;
  try {
    def = parseTrackFile(readFileSync(file, "utf8"), file);
    ct = compileTrack(def);
  } catch (e) {
    console.error(`TRACK INVALID: ${(e as Error).message}`);
    process.exit(1);
  }

  const cl = ct.centerline;
  const pts = def.centerline.map((p) => ct.frame.toLocal(p.lat, p.lon));
  let minSeg = Infinity;
  let maxSeg = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (d > 0) minSeg = Math.min(minSeg, d);
    maxSeg = Math.max(maxSeg, d);
  }
  const closeGap = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);

  console.log(`track file: ${file}`);
  console.log(
    `centerline: ${def.centerline.length} points (device max ${MAX_TRACK_FILE_POINTS}), lap length ${cl.lengthM.toFixed(1)} m`,
  );
  console.log(
    `point spacing: ${minSeg.toFixed(1)}–${maxSeg.toFixed(1)} m, last→first ${closeGap.toFixed(1)} m`,
  );
  console.log(
    `gates: ${ct.gates.length} (${ct.gates.length <= 1 ? 1 : ct.gates.length} sector(s) per lap)`,
  );
  for (const g of ct.gates) {
    const sRel = (((g.s - ct.gates[0].s) % cl.lengthM) + cl.lengthM) % cl.lengthM;
    console.log(
      `  ${g.kind === "start_finish" ? "SF " : "SEC"} ${g.name.padEnd(13)} at ${sRel.toFixed(1).padStart(7)} m from S/F, width ${(2 * g.halfWidthM).toFixed(1)} m, midpoint ${g.centerE.toFixed(1)} m off centerline`,
    );
  }
  const warn: string[] = [];
  if (maxSeg > 50)
    warn.push(
      `a centerline segment is ${maxSeg.toFixed(0)} m long: corners may be cut; add points`,
    );
  if (closeGap > 50)
    warn.push(
      `last point is ${closeGap.toFixed(0)} m from the first: the loop closes with a long straight`,
    );
  for (const g of ct.gates) {
    if (2 * g.halfWidthM < 8)
      warn.push(
        `${g.name} is only ${(2 * g.halfWidthM).toFixed(1)} m wide: make it span the whole track plus margin`,
      );
    if (Math.abs(g.centerE) > 10)
      warn.push(`${g.name} midpoint is ${g.centerE.toFixed(1)} m off the centerline`);
  }
  for (const w of warn) console.log(`warning: ${w}`);
  console.log(
    "TRACK OK — paste the whole file into the device serial monitor after each boot; it answers TRACK,OK,...",
  );
}

main();
