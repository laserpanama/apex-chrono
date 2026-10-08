/**
 * `npm run firmware:fixtures` — export replay fixtures for the C++ port.
 *
 * For each scenario this writes the compiled-track definition, the exact
 * simulated fix stream, and the laps the TypeScript reference engine
 * produced from it. firmware/test_host/parity.cpp replays the same fixes
 * through firmware/lib/apex_timing and must reproduce the laps.
 * Drag scenarios (below) do the same for firmware/lib/apex_drag, checked by
 * firmware/test_host/drag_parity.cpp.
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
import { DragEngine, DEFAULT_DRAG, FT, rowToDragSample, type DragEvent } from "./drag.ts";
import { simulateDrag, DEFAULT_RUN, type DragSimConfig } from "./drag-sim.ts";
import { RECORDING_HEADER, formatRow, parseRecording } from "./recording.ts";

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

// ── Drag engine parity (firmware/lib/apex_drag/DragEngine.h) ──
// Each scenario: <name>.csv (contract rows exactly as the device logs them),
// <name>.dragcfg (non-default config), <name>.drag_expected.csv (runs) and
// <name>.drag_events.csv (every event, in order).
const dragScenarios: { name: string; sim: DragSimConfig; rolloutM: number }[] = [
  {
    name: "drag_10hz_three_cars",
    rolloutM: 0,
    sim: {
      rateHz: 10,
      noiseKmh: 0.18,
      seed: 201,
      stillS: 3,
      runs: [
        DEFAULT_RUN,
        {
          ...DEFAULT_RUN,
          powerKw: 90,
          massKg: 1150,
          grip: 0.8,
          topKmh: 165,
          shiftsKmh: [45, 80, 120],
        },
        { ...DEFAULT_RUN, powerKw: 400, massKg: 1600, grip: 1.1, topKmh: 250 },
      ],
    },
  },
  {
    name: "drag_25hz_uphill",
    rolloutM: 0,
    sim: {
      rateHz: 25,
      noiseKmh: 0.18,
      seed: 202,
      stillS: 3,
      runs: [{ ...DEFAULT_RUN, slopePct: 1.5 }, DEFAULT_RUN],
    },
  },
  {
    name: "drag_10hz_rollout",
    rolloutM: FT,
    sim: { rateHz: 10, noiseKmh: 0.18, seed: 203, stillS: 3, runs: [DEFAULT_RUN, DEFAULT_RUN] },
  },
  {
    name: "drag_10hz_degraded",
    rolloutM: 0,
    sim: {
      rateHz: 10,
      noiseKmh: 0.3,
      seed: 204,
      stillS: 3,
      runs: [DEFAULT_RUN, DEFAULT_RUN, DEFAULT_RUN],
      gaps: [[8, 0.4]],
      lowSats: [[34, 0.5]],
    },
  },
];

for (const sc of dragScenarios) {
  const cfg = { ...DEFAULT_DRAG, rolloutM: sc.rolloutM };
  const { rows } = simulateDrag(sc.sim, cfg.speedTargetsKmh, cfg.distanceTargetsM);
  const csv = `${RECORDING_HEADER}\n${rows.map(formatRow).join("\n")}\n`;
  writeFileSync(join(OUT, `${sc.name}.csv`), csv);
  writeFileSync(join(OUT, `${sc.name}.dragcfg`), `rollout_m ${num(sc.rolloutM)}\n`);
  // Replay the TEXT, like the device and the C++ test see it.
  const eng = new DragEngine(cfg);
  const events: DragEvent[] = [];
  for (const r of parseRecording(csv).rows) events.push(...eng.push(rowToDragSample(r)));
  events.push(...eng.flush());
  const ends = ["lift", "stopped", "timeout", "gap", "no_speed", "flush"];
  writeFileSync(
    join(OUT, `${sc.name}.drag_expected.csv`),
    "number,valid,flags,end,t0,t_start,peak_kmh,distance_m,duration_s,slope_pct," +
      cfg.speedTargetsKmh.map((_, i) => `s${i + 1}`).join(",") +
      "," +
      cfg.distanceTargetsM.map((_, i) => `d${i + 1},trap${i + 1}`).join(",") +
      "," +
      cfg.rangesKmh.map((_, i) => `r${i + 1}`).join(",") +
      "\n" +
      eng.runs
        .map((r) =>
          [
            r.number,
            r.valid ? 1 : 0,
            r.flags,
            ends.indexOf(r.endReason),
            num(r.t0),
            num(r.tStart),
            num(r.peakKmh),
            num(r.distanceM),
            num(r.durationS),
            num(r.slopePct),
            ...r.speedTimesS.map(num),
            ...r.distanceTimesS.flatMap((d, i) => [num(d), num(r.trapKmh[i])]),
            ...r.rangeTimesS.map(num),
          ].join(","),
        )
        .join("\n") +
      "\n",
  );
  const types = ["armed", "launch", "speed", "distance", "end"];
  writeFileSync(
    join(OUT, `${sc.name}.drag_events.csv`),
    "type,t,index,time_s,trap_kmh\n" +
      events
        .map((e) =>
          [
            types.indexOf(e.type),
            num(e.t),
            e.type === "speed" || e.type === "distance" ? e.index : -1,
            e.type === "speed" || e.type === "distance"
              ? num(e.timeS)
              : e.type === "launch"
                ? num(e.t0)
                : "nan",
            e.type === "distance" ? num(e.trapKmh) : "nan",
          ].join(","),
        )
        .join("\n") +
      "\n",
  );
  console.log(
    `${sc.name}: ${rows.length} rows, ${eng.runs.length} drag runs (${eng.runs.filter((r) => r.valid).length} valid), ${events.length} events`,
  );
}
