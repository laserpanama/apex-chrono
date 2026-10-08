/**
 * `npm run validate:gps` — full GNSS noise validation.
 *
 * Runs the deterministic simulator through the real GpsLapEngine:
 *   - main matrix: every synthetic track × {0, 0.5, 1.5, 3, 5, 10} m × LAPS laps,
 *     10 Hz, Doppler speed + course reported (BN-880 / u-blox M8 behaviour)
 *   - supplementary: position-only receiver, and a degraded-quality stream
 *
 * Writes docs/V1_VALIDATION_REPORT.md and docs/v1-validation-results.json and
 * exits non-zero if any acceptance criterion of the main matrix fails.
 *
 * Env: APEX_LAPS (default 1000), APEX_SEED (default 2026), APEX_OUT (default docs).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKS } from "../timer/tracks.ts";
import { compileTrack } from "./track.ts";
import { geoTrackFromSynthetic } from "./synthetic.ts";
import { runScenario, type ScenarioResult } from "./validate.ts";
import { DEFAULT_GATE_CONFIG } from "./gates.ts";
import { DEFAULT_QUALITY } from "./fix.ts";

const LAPS = Number(process.env.APEX_LAPS ?? 1000);
const SEED = Number(process.env.APEX_SEED ?? 2026);
const OUT = process.env.APEX_OUT ?? "docs";
const NOISE = [0, 0.5, 1.5, 3, 5, 10];

/**
 * Acceptance criteria for the main matrix. Detection must be exact up to 5 m
 * (1σ per axis). Timing limits follow the noise-limited bound for a 10 Hz
 * receiver (≈ 2.8·σ / (v·√(2K))) at the slowest start/finish speed in the
 * synthetic set, plus margin.
 */
const P95_LIMIT_S: Record<number, number> = {
  0: 0.01,
  0.5: 0.025,
  1.5: 0.06,
  3: 0.12,
  5: 0.2,
  10: 0.4,
};

type Verdict = { pass: boolean; failures: string[] };

function judge(r: ScenarioResult): Verdict {
  const f: string[] = [];
  if (r.truthLaps !== LAPS) f.push(`truth laps ${r.truthLaps} ≠ ${LAPS}`);
  if (r.noiseM <= 5) {
    if (r.missedLaps) f.push(`${r.missedLaps} missed laps`);
    if (r.missedSectors) f.push(`${r.missedSectors} missed sectors`);
  } else {
    if (r.missedLaps > Math.floor(LAPS * 0.001)) f.push(`${r.missedLaps} missed laps (> 0.1%)`);
  }
  if (r.duplicateLaps) f.push(`${r.duplicateLaps} duplicate laps`);
  if (r.duplicateSectors) f.push(`${r.duplicateSectors} duplicate sectors`);
  if (!(r.lapError.p95AbsS <= P95_LIMIT_S[r.noiseM])) {
    f.push(
      `P95 lap error ${(r.lapError.p95AbsS * 1000).toFixed(1)} ms > ${P95_LIMIT_S[r.noiseM] * 1000} ms`,
    );
  }
  return { pass: f.length === 0, failures: f };
}

/**
 * Fitness-for-racing envelope, independent of the pass/fail thresholds above.
 * Detection errors are disqualifying regardless of timing accuracy (a lap
 * timer that invents or drops laps is worse than an imprecise one).
 *   GREEN  : 0 missed/duplicate laps & sectors, P95 lap error ≤ 50 ms, max ≤ 100 ms
 *   YELLOW : 0 missed/duplicate laps & sectors, P95 ≤ 150 ms
 *   RED    : any detection error, or P95 > 150 ms
 * 50 ms ≈ the smallest lap-to-lap difference a club driver acts on; beyond
 * 150 ms P95 lap comparisons are dominated by timer error.
 */
type Band = "GREEN" | "YELLOW" | "RED";
function band(r: ScenarioResult): Band {
  const detectionErrors = r.missedLaps + r.duplicateLaps + r.missedSectors + r.duplicateSectors;
  if (detectionErrors > 0 || !(r.lapError.p95AbsS <= 0.15)) return "RED";
  if (r.lapError.p95AbsS <= 0.05 && r.lapError.maxAbsS <= 0.1) return "GREEN";
  return "YELLOW";
}

const ms = (s: number) => (Number.isFinite(s) ? (s * 1000).toFixed(1) : "—");
const m2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

function row(r: ScenarioResult, v?: Verdict): string {
  return [
    r.track,
    r.noiseM,
    r.truthLaps,
    r.detectedLaps,
    r.matchedLaps,
    r.missedLaps,
    r.duplicateLaps,
    r.duplicateStartFinish,
    r.truthSectorCrossings,
    r.detectedSectorCrossings,
    r.missedSectors,
    r.duplicateSectors,
    ms(r.lapError.meanS),
    ms(r.lapError.medianAbsS),
    ms(r.lapError.meanAbsS),
    ms(r.lapError.p95AbsS),
    ms(r.lapError.maxAbsS),
    ms(r.sectorError.p95AbsS),
    m2(r.crossTrackResidualM.meanAbsS),
    m2(r.crossTrackResidualM.p95AbsS),
    m2(r.crossTrackResidualM.maxAbsS),
    m2(r.alongTrackErrorM.p95AbsS),
    m2(r.maxSpeedErrorKmh.p95AbsS),
    (r.runtimeMs / 1000).toFixed(1),
    band(r),
    v ? (v.pass ? "PASS" : "FAIL") : "info",
  ].join(" | ");
}

const HEADER =
  "track | noise σ (m) | laps generated | laps detected | laps matched | missed laps | dup laps | false S/F crossings | sector crossings expected | sector crossings detected | missed sectors | dup sectors | mean lap err (ms) | median abs (ms) | mean abs (ms) | P95 abs (ms) | max abs (ms) | sector P95 (ms) | cross-track err mean (m) | cross-track err P95 (m) | cross-track err max (m) | along-track P95 (m) | max-speed err P95 (km/h) | runtime (s) | band | verdict";
const SEP = HEADER.split("|")
  .map(() => "---")
  .join("|");

const started = Date.now();
const compiled = TRACKS.map((t) => compileTrack(geoTrackFromSynthetic(t)));
const main: { r: ScenarioResult; v: Verdict }[] = [];
console.log(`Apex Chrono V1 GNSS validation — ${LAPS} laps/scenario, 10 Hz, seed ${SEED}\n`);
console.log(HEADER);
for (const ct of compiled) {
  for (const noiseM of NOISE) {
    const r = runScenario(ct, { laps: LAPS, noiseM, seed: SEED });
    const v = judge(r);
    main.push({ r, v });
    console.log(row(r, v) + (v.pass ? "" : `  ← ${v.failures.join("; ")}`));
  }
}

console.log("\nSupplementary: position-only receiver (no Doppler speed/course), club");
const posOnly: ScenarioResult[] = [];
for (const noiseM of NOISE) {
  const r = runScenario(compiled[0], {
    laps: LAPS,
    noiseM,
    seed: SEED,
    reportSpeed: false,
    reportCourse: false,
  });
  posOnly.push(r);
  console.log(row(r));
}

console.log(
  "\nSupplementary: degraded stream (3 m, 5% bad-quality fixes, 2% dropped fixes), all tracks",
);
const degraded: ScenarioResult[] = [];
for (const ct of compiled) {
  const r = runScenario(ct, {
    laps: LAPS,
    noiseM: 3,
    seed: SEED,
    badFixRate: 0.05,
    dropRate: 0.02,
  });
  degraded.push(r);
  console.log(row(r) + ` (quality-rejected ${r.qualityRejected})`);
}

const allPass = main.every((x) => x.v.pass);
const runtimeS = (Date.now() - started) / 1000;
const totalLaps = [...main.map((x) => x.r), ...posOnly, ...degraded].reduce(
  (a, r) => a + r.truthLaps,
  0,
);
console.log(
  `\n${allPass ? "PASS" : "FAIL"}: main matrix ${main.filter((x) => x.v.pass).length}/${main.length} scenarios passed. ${totalLaps} simulated laps in ${runtimeS.toFixed(1)} s.`,
);

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "v1-validation-results.json"),
  JSON.stringify(
    {
      generatedBy: "npm run validate:gps",
      laps: LAPS,
      seed: SEED,
      rateHz: 10,
      node: process.version,
      gateConfig: DEFAULT_GATE_CONFIG,
      qualityConfig: DEFAULT_QUALITY,
      p95LimitsS: P95_LIMIT_S,
      allPass,
      main: main.map((x) => ({ ...x.r, verdict: x.v })),
      positionOnly: posOnly,
      degraded,
    },
    null,
    2,
  ) + "\n",
);

const md: string[] = [];
md.push("# Apex Chrono V1 — GNSS validation report");
md.push("");
md.push(
  "Generated by `npm run validate:gps`. Every number below is copied from that run; re-run the command to reproduce it bit-for-bit (deterministic seed).",
);
md.push("");
md.push(`- Laps per scenario: **${LAPS}** (plus one out-lap crossing)`);
md.push(`- Fix rate: **10 Hz**, GNSS timestamps`);
md.push(`- Noise seed: **${SEED}** (development used seed 1; the unit tests use seed 11)`);
md.push(`- Node: ${process.version}`);
md.push(`- Runtime: ${runtimeS.toFixed(1)} s for ${totalLaps} simulated laps`);
md.push(
  `- Overall verdict (main matrix): **${allPass ? "PASS" : "FAIL"}** — ${main.filter((x) => x.v.pass).length}/${main.length} scenarios`,
);
md.push("");
md.push("## What is simulated");
md.push("");
md.push(
  "- Truth: the car follows the centerline with a smooth lateral offset of up to ±2.5 m (different every lap) and a smooth pace variation (lap times differ). Speed comes from corner curvature with 6 m/s² acceleration and 11 m/s² braking limits.",
);
md.push(
  "- Truth crossing time: the instant the offset path crosses the physical gate line, interpolated inside a 5 ms integration step.",
);
md.push(
  "- Measurement: Gaussian east/north position noise with σ = noise level **per axis** (white, uncorrelated between fixes), Doppler speed noise 0.1 m/s, course noise 0.5°, 10–16 satellites, HDOP 0.6–1.2.",
);
md.push(
  "- Everything after the simulator is the production code path: `GpsLapEngine.push(fix)` → quality filter → `LocalFrame` → `MapMatcher` → `GateDetector` → lap state machine.",
);
md.push("");
md.push("## Acceptance criteria (main matrix)");
md.push("");
md.push("- Noise ≤ 5 m: 0 missed laps, 0 missed sectors. 10 m: ≤ 0.1% missed laps.");
md.push("- All levels: 0 duplicate laps, 0 duplicate sectors.");
md.push(
  `- P95 absolute lap-time error ≤ ${NOISE.map((n) => `${P95_LIMIT_S[n] * 1000} ms @ ${n} m`).join(", ")}.`,
);
md.push(
  "- These limits were chosen from the noise-limited bound for a 10 Hz receiver with margin. Development runs (seed 1) were visible when they were chosen, which is why this report uses an independent seed.",
);
md.push("");
md.push("## Engineering envelope (measured)");
md.push("");
md.push(
  "Band rules (written before this report run from racing requirements; earlier development runs on seed 1 were visible when they were written): GREEN = 0 missed/duplicate laps and sectors, P95 lap error ≤ 50 ms and max ≤ 100 ms; YELLOW = 0 detection errors and P95 ≤ 150 ms; RED = any detection error or P95 > 150 ms.",
);
md.push("");
md.push("noise σ (m) | " + compiled.map((c) => c.id).join(" | ") + " | position-only (club)");
md.push("---|" + compiled.map(() => "---").join("|") + "|---");
for (const n of NOISE) {
  const cells = compiled.map((c) => {
    const r = main.find((x) => x.r.track === c.id && x.r.noiseM === n)!.r;
    return `${band(r)} (P95 ${ms(r.lapError.p95AbsS)} ms)`;
  });
  const po = posOnly.find((r) => r.noiseM === n)!;
  md.push(`${n} | ${cells.join(" | ")} | ${band(po)} (P95 ${ms(po.lapError.p95AbsS)} ms)`);
}
const worstBand = (n: number) => {
  const bs = main.filter((x) => x.r.noiseM === n).map((x) => band(x.r));
  return bs.includes("RED") ? "RED" : bs.includes("YELLOW") ? "YELLOW" : "GREEN";
};
const firstNonGreen = NOISE.find((n) => worstBand(n) !== "GREEN");
md.push("");
md.push(
  `Worst band across tracks per noise level: ${NOISE.map((n) => `${n} m → ${worstBand(n)}`).join(", ")}. ` +
    (firstNonGreen === undefined
      ? "Timing stays GREEN at every tested level."
      : `Timing first leaves GREEN at **${firstNonGreen} m** σ (detection remains exact at every level).`),
);
md.push("");
md.push("## Summary (main matrix)");
md.push("");
md.push(
  "track | noise σ (m) | laps | missed | duplicate | sector misses | mean error (ms) | P95 error (ms) | max error (ms) | P95 cross-track err (m) | band",
);
md.push("---|---|---|---|---|---|---|---|---|---|---");
for (const { r } of main) {
  md.push(
    [
      r.track,
      r.noiseM,
      `${r.matchedLaps}/${r.truthLaps}`,
      r.missedLaps,
      r.duplicateLaps,
      r.missedSectors,
      ms(r.lapError.meanS),
      ms(r.lapError.p95AbsS),
      ms(r.lapError.maxAbsS),
      m2(r.crossTrackResidualM.p95AbsS),
      band(r),
    ].join(" | "),
  );
}
md.push("");
md.push("## Main matrix — Doppler speed + course reported (BN-880 / u-blox M8 behaviour)");
md.push("");
md.push(HEADER);
md.push(SEP);
for (const x of main) md.push(row(x.r, x.v));
const failed = main.filter((x) => !x.v.pass);
if (failed.length) {
  md.push("");
  md.push("### Failures");
  md.push("");
  for (const x of failed) md.push(`- ${x.r.track} @ ${x.r.noiseM} m: ${x.v.failures.join("; ")}`);
}
md.push("");
md.push("## Supplementary — position-only receiver (no Doppler), Club Circuit");
md.push("");
md.push(
  "Not part of the pass/fail verdict. Shows what is lost if the receiver's speed/course fields are unavailable: crossing times then come from a quadratic fit of position only, and max speed is derived from 1 s position differences.",
);
md.push("");
md.push(HEADER);
md.push(SEP);
for (const r of posOnly) md.push(row(r));
md.push("");
md.push("## Supplementary — degraded stream (3 m noise, 5% bad-quality fixes, 2% dropped fixes)");
md.push("");
md.push(HEADER + " | quality-rejected fixes");
md.push(SEP + "|---");
for (const r of degraded) md.push(row(r) + ` | ${r.qualityRejected}`);
md.push("");
md.push("## Map-matching and filter counters (main matrix)");
md.push("");
md.push(
  "track | noise σ (m) | fixes | full scans | cross-track-rejected fixes | cross-track resid mean abs (m) | along-track mean abs (m) | gate rejections",
);
md.push("---|---|---|---|---|---|---|---");
for (const { r } of main) {
  const rej = Object.entries(r.gateRejections)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  md.push(
    [
      r.track,
      r.noiseM,
      r.fixes,
      r.fullScans,
      r.crossTrackRejected,
      m2(r.crossTrackResidualM.meanAbsS),
      m2(r.alongTrackErrorM.meanAbsS),
      rej || "none",
    ].join(" | "),
  );
}
md.push("");
md.push("## Column definitions");
md.push("");
md.push(
  "- **laps matched**: closed laps whose start and end crossings both match consecutive truth start/finish crossings within 1 s.",
);
md.push(
  "- **missed / dup laps**: truth laps with no matching detected lap / detected laps that match no truth lap.",
);
md.push(
  "- **missed / dup sectors**: truth sector-gate crossings inside the timed window with no detection / detections that match no truth crossing.",
);
md.push("- **false S/F crossings**: accepted start/finish crossings that match no truth crossing.");
md.push(
  "- **lap err**: detected lap time − truth lap time (signed mean, median |·|, mean |·|, P95 |·| nearest-rank, max |·|).",
);
md.push(
  "- **cross-track err**: map-matched cross-track − true lateral offset of the car, per accepted fix (mean |·|, P95 |·|, max |·|).",
);
md.push(
  "- **along-track**: map-matched distance − true distance along the centerline, per accepted fix.",
);
md.push("- **max-speed err**: lap max speed − truth max speed at fix epochs.");
md.push("");
md.push("## Limits of this evidence");
md.push("");
md.push(
  "- Synthetic tracks and white noise. Real GNSS error is time-correlated (multipath, slowly drifting bias); correlated error mostly cancels in a lap time but is not modelled here.",
);
md.push(
  "- No antenna shadowing, no receiver latency, no 2D/3D fix transitions beyond the degraded-stream test.",
);
md.push(
  "- This validates the algorithm, not the BN-880. The hardware verdict needs logged laps on a real circuit with a reference timer (transponder or light beam).",
);
md.push("");
writeFileSync(join(OUT, "V1_VALIDATION_REPORT.md"), md.join("\n"));
console.log(
  `Wrote ${join(OUT, "V1_VALIDATION_REPORT.md")} and ${join(OUT, "v1-validation-results.json")}`,
);
process.exitCode = allPass ? 0 : 1;
