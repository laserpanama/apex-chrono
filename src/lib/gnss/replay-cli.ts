/**
 * `npm run replay:gps -- <file.csv> [--track <id> | --track-file <file.track>]`
 *
 * Replay a recorded GNSS CSV (contract §6) through the SAME `GpsLapEngine` a
 * live BN-880 session uses, and print:
 *   - parse diagnostics (gaps, duplicate/backwards timestamps, malformed rows)
 *   - quality statistics (accepted / rejected by reason)
 *   - gate rejections
 *   - the full lap + sector sheet and the current best lap
 *
 * Tracks are resolved from the recording's `# track=<id>` metadata line, or
 * overridden with `--track <id>` (synthetic tracks: club, street, fast).
 * If the file names no track and none is given, it defaults to `club`.
 * A real circuit is given with `--track-file <file.track>` — the same `.track`
 * text the device loads over serial (see track-file.ts).
 *
 * Drag runs (0-100, 60 ft, 1/8, 1/4 mile — drag.ts) are always listed too:
 * they need no track. `--rollout` times them from 1 ft of movement
 * (drag-strip convention) instead of the standing start.
 *
 * Determinism: the same file always yields the same laps — this is the tool
 * you use to prove a live session reproduced bit-for-bit on the desktop.
 */

import { readFileSync } from "node:fs";
import { TRACKS, getTrack } from "../timer/tracks.ts";
import { compileTrack } from "./track.ts";
import { geoTrackFromSynthetic } from "./synthetic.ts";
import { parseTrackFile } from "./track-file.ts";
import { parseRecording, replayRecording, type ReplayWarning } from "./recording.ts";
import { recordingStats } from "./recording-stats.ts";
import { formatLap } from "../timer/engine.ts";
import { DragEngine, FT, distanceLabel, flagNames, rowToDragSample, speedLabel } from "./drag.ts";
import { phoneReplayOptions } from "./phone.ts";

const fmtT = (t: number) => t.toFixed(3);
const SPEED0 = "──.--";

function warnLine(w: ReplayWarning): string {
  switch (w.kind) {
    case "gap":
      return `GAP ${(w.dtMs / 1000).toFixed(2)} s at t=${fmtT(w.tMs / 1000)}s (line ${w.line})`;
    case "duplicate_time":
      return `duplicate timestamp t=${fmtT(w.tMs / 1000)}s (line ${w.line})`;
    case "backwards_time":
      return `backwards timestamp t=${fmtT(w.tMs / 1000)}s after ${fmtT(w.prevTMs / 1000)}s (line ${w.line})`;
    case "malformed":
      return `malformed row (${w.reason}, line ${w.line})`;
    case "zero_position":
      return `zero position (0,0) (line ${w.line})`;
    case "speed_out_of_range":
      return `speed out of range ${w.speedKmh} km/h (line ${w.line})`;
    case "low_sats_run":
      return `low-SNR run of ${w.count} fixes (sats < 6) ending line ${w.line}`;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file) {
    console.error(
      "usage: npm run replay:gps -- <file.csv> [--track club|street|fast | --track-file <file.track>] [--rollout]",
    );
    process.exit(2);
  }
  const ti = argv.indexOf("--track");

  const tf = argv.indexOf("--track-file");
  const trackFile = tf >= 0 ? argv[tf + 1] : undefined;
  if (tf >= 0 && !trackFile) {
    console.error("--track-file needs a path");
    process.exit(2);
  }

  const text = readFileSync(file, "utf8");
  // --track wins, then the recording's own `# track=<id>` line, then `club`.
  const metaTrack = parseRecording(text).meta.track;
  const trackId = ti >= 0 && argv[ti + 1] ? argv[ti + 1] : (metaTrack ?? "club");
  if (!trackFile && !TRACKS.some((t) => t.id === trackId)) {
    console.error(
      `unknown track "${trackId}" (built-in: ${TRACKS.map((t) => t.id).join(", ")}); use --track-file <file.track> for a real circuit`,
    );
    process.exit(2);
  }
  const track = trackFile
    ? compileTrack(parseTrackFile(readFileSync(trackFile, "utf8"), trackFile))
    : compileTrack(geoTrackFromSynthetic(getTrack(trackId)));
  // A CSV from the phone screen carries its own quality/gap settings (phone.ts).
  const phone = phoneReplayOptions(parseRecording(text).meta);
  const r = replayRecording(
    text,
    track,
    phone ? { engine: { quality: phone.quality }, gapThresholdMs: phone.gapThresholdMs } : {},
  );

  console.log(`Apex Chrono — GNSS replay of ${file}`);
  if (phone)
    console.log(
      `source: PHONE — no satellite count; HDOP column = accuracy in metres (max ${phone.quality.maxHdop} m); drag gap limit ${phone.gapThresholdMs} ms`,
    );
  console.log(
    `track: ${track.id} (${r.meta.track ?? "default"})${r.meta.date ? `  date: ${r.meta.date}` : ""}\n`,
  );

  // Parse diagnostics
  const n = r.rows.length;
  const minT = n ? r.rows[0].timestampMs : 0;
  const maxT = n ? r.rows[n - 1].timestampMs : 0;
  const durS = n ? (maxT - minT) / 1000 : 0;
  console.log(`rows parsed: ${n}  session ${durS.toFixed(1)} s`);
  // a phone reports no satellite count (row value 0): that is not a low-signal run
  for (const w of r.warnings)
    if (!(phone && w.kind === "low_sats_run")) console.log(`  warning: ${warnLine(w)}`);

  // Receiver health (test procedure §6 10 Hz, §10 stationary)
  const st = recordingStats(r.rows);
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  console.log("\nreceiver:");
  console.log(
    `  rate: ${f2(st.rateHz)} Hz  intervals at 100±10 ms: ${(st.nominalIntervalShare * 100).toFixed(2)}%  max interval: ${st.maxIntervalMs} ms  duplicates: ${st.duplicates}  backwards: ${st.backwards}`,
  );
  console.log(
    `  satellites min/median: ${st.satsMin}/${st.satsMedian}  HDOP median/p95: ${f2(st.hdopMedian)}/${f2(st.hdopP95)}  no-fix rows: ${st.noFixRows}`,
  );
  console.log(
    `  longest stationary run (< 2 km/h): ${st.stationaryRows} rows, ${f1(st.stationaryDurationS)} s, position p95 ${Number.isFinite(st.stationaryP95M) ? `${f2(st.stationaryP95M)} m` : "— (needs ≥ 50 rows)"}`,
  );

  // Quality stats
  const rej = r.stats.rejected;
  console.log("\nquality:");
  console.log(`  fixes: ${r.stats.fixes}  accepted: ${r.stats.accepted}`);
  const rejParts = (Object.entries(rej) as [keyof typeof rej, number][])
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`  rejected: ${rejParts.length ? rejParts.join(", ") : "none"}`);
  const gates = Object.entries(r.stats.gateRejections).filter(([, v]) => v > 0);
  console.log(
    `  gate rejections: ${gates.length ? gates.map(([k, v]) => `${k}=${v}`).join(", ") : "none"}`,
  );

  // Lap sheet
  console.log("\nlaps:");
  console.log(`  #  time        valid  max km/h  splits(s)`);
  for (const l of r.laps) {
    const splits = l.splits.map((s) => (s === null ? "——" : s.toFixed(3))).join("/");
    const kmh = Number.isFinite(l.maxSpeedMs) ? (l.maxSpeedMs * 3.6).toFixed(1) : SPEED0;
    console.log(
      `  ${String(l.number).padStart(2)}  ${formatLap(l.timeS)}  ${l.valid ? "yes" : "no"}  ${kmh.padStart(6)}  ${splits}`,
    );
  }
  if (r.bestLap) {
    console.log(
      `\nbest lap: ${formatLap(r.bestLap.timeS)}${r.bestLap.valid ? "" : " (invalid)"}  max ${(r.bestLap.maxSpeedMs * 3.6).toFixed(1)} km/h`,
    );
  } else {
    console.log("\nbest lap: —");
  }

  // Drag runs (independent of the track)
  const rollout = argv.includes("--rollout");
  const drag = new DragEngine({ ...(phone?.drag ?? {}), rolloutM: rollout ? FT : 0 });
  for (const row of r.rows) drag.push(rowToDragSample(row));
  drag.flush();
  const s2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  console.log(
    `\ndrag runs (${rollout ? "1 ft rollout" : "standing start, no rollout"}): ${drag.runs.length}`,
  );
  for (const d of drag.runs) {
    const c = drag.cfg;
    const parts = [
      ...c.speedTargetsKmh.map((k, i) => `${speedLabel(k)} ${s2(d.speedTimesS[i])}`),
      ...c.distanceTargetsM.map(
        (m, i) =>
          `${distanceLabel(m)} ${s2(d.distanceTimesS[i])}${Number.isFinite(d.trapKmh[i]) ? ` @${d.trapKmh[i].toFixed(1)}` : ""}`,
      ),
      ...c.rangesKmh.map(([lo, hi], i) => `${lo}-${hi} km/h ${s2(d.rangeTimesS[i])}`),
    ];
    console.log(
      `  #${d.number} ${d.valid ? "valid" : `INVALID (${flagNames(d.flags).join(", ")})`}  end=${d.endReason}  peak ${d.peakKmh.toFixed(1)} km/h  ${d.distanceM.toFixed(0)} m${Number.isFinite(d.slopePct) ? `  slope ${d.slopePct.toFixed(2)} %` : ""}`,
    );
    console.log(`     ${parts.join("  ")}`);
  }
}

main();
