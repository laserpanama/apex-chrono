/**
 * `npm run firmware:fixtures` — export replay fixtures for the C++ port.
 *
 * For each scenario this writes the compiled-track definition, the exact
 * simulated fix stream, and the laps the TypeScript reference engine
 * produced from it. firmware/test_host/parity.cpp replays the same fixes
 * through firmware/lib/apex_timing and must reproduce the laps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKS } from "../timer/tracks.ts";
import { compileTrack } from "./track.ts";
import { formatTrackFile } from "./track-file.ts";
import { geoTrackFromSynthetic } from "./synthetic.ts";
import { simulate, type SimConfig } from "./sim.ts";
import { GpsLapEngine } from "./lap-engine.ts";
import type { GnssFix } from "./fix.ts";

const OUT = process.env.APEX_FIXTURE_OUT ?? "firmware/test_host/fixtures";
const num = (x: number | undefined) =>
  x === undefined || !Number.isFinite(x) ? "nan" : x.toPrecision(17);

const scenarios: {
  name: string;
  track: string;
  sim: Partial<SimConfig> & { laps: number; noiseM: number };
}[] = [
  { name: "club_3m_doppler", track: "club", sim: { laps: 6, noiseM: 3, seed: 101 } },
  {
    name: "street_1m5_position_only",
    track: "street",
    sim: { laps: 6, noiseM: 1.5, seed: 102, reportSpeed: false, reportCourse: false },
  },
  {
    name: "fast_10m_degraded",
    track: "fast",
    sim: { laps: 6, noiseM: 10, seed: 103, badFixRate: 0.05, dropRate: 0.02 },
  },
];

mkdirSync(OUT, { recursive: true });
for (const sc of scenarios) {
  const def = geoTrackFromSynthetic(TRACKS.find((t) => t.id === sc.track)!);
  const ct = compileTrack(def);
  writeFileSync(join(OUT, `${sc.name}.track`), formatTrackFile(def));

  const fixes: GnssFix[] = [];
  simulate(ct, sc.sim, (f) => fixes.push(f));
  writeFileSync(
    join(OUT, `${sc.name}.fixes.csv`),
    "t,lat,lon,speed_ms,course_deg,sats,hdop,fix_type\n" +
      fixes
        .map((f) =>
          [
            num(f.t),
            num(f.lat),
            num(f.lon),
            num(f.speedMs),
            num(f.courseDeg),
            f.sats,
            num(f.hdop),
            f.fixType ?? -1,
          ].join(","),
        )
        .join("\n") +
      "\n",
  );

  const eng = new GpsLapEngine(ct);
  for (const f of fixes) eng.push(f);
  eng.flush();
  writeFileSync(
    join(OUT, `${sc.name}.expected.csv`),
    "number,time_s,valid,max_speed_ms," +
      ct.gates.map((_, i) => `s${i + 1}`).join(",") +
      "\n" +
      eng.laps
        .map((l) =>
          [
            l.number,
            num(l.timeS),
            l.valid ? 1 : 0,
            num(l.maxSpeedMs),
            ...l.splits.map((s) => num(s ?? NaN)),
          ].join(","),
        )
        .join("\n") +
      "\n",
  );
  console.log(
    `${sc.name}: ${fixes.length} fixes, ${eng.laps.length} laps (${eng.laps.filter((l) => l.valid).length} valid)`,
  );
}
