/**
 * `npm run fixtures:recording` — write the committed recording fixtures.
 *
 *  - `fixtures/recording/golden_10hz.csv`  a 12-lap, 10 Hz, noisy session on
 *    the `club` circuit, including degraded-quality fixes and drops, stored
 *    in the contract format (§6). This is the golden fixture the determinism
 *    test replays twice and compares bit-for-bit.
 *  - `fixtures/recording/stress_30min_18000.csv`  a synthetic 10 Hz
 *    **30-minute / 18,000-fix** stream on `fast` used by the stress test.
 *
 * Both are generated deterministically (fixed seeds) so the committed files
 * are reproducible, and the recorder → parser → replay layer is exercised
 * end to end (rows flow through the real `CsvRecorder` into a memory sink).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKS } from "../timer/tracks.ts";
import { compileTrack } from "./track.ts";
import { geoTrackFromSynthetic } from "./synthetic.ts";
import { simulate, type SimConfig } from "./sim.ts";
import { CsvRecorder, MemorySink, fixToRow } from "./recording.ts";
import type { GnssFix } from "./fix.ts";

const OUT = join(import.meta.dirname, "../../../fixtures/recording");
mkdirSync(OUT, { recursive: true });

function record(trackId: string, fixes: GnssFix[], chunkRows = 64): string {
  const sink = new MemorySink();
  const rec = new CsvRecorder(sink, { meta: { track: trackId }, chunkRows });
  for (const f of fixes) rec.enqueue(fixToRow(f));
  rec.flush();
  return sink.toString();
}

// ── golden: 12 laps, club, 10 Hz, light noise + degraded/dropped fixes ──
{
  const ct = compileTrack(geoTrackFromSynthetic(TRACKS.find((t) => t.id === "club")!));
  const fixes: GnssFix[] = [];
  const sim: Partial<SimConfig> & { laps: number; noiseM: number } = {
    laps: 12,
    noiseM: 2.0,
    rateHz: 10,
    seed: 11,
    truthSeed: 77,
    badFixRate: 0.02,
    dropRate: 0.01,
  };
  simulate(ct, sim, (f) => fixes.push(f));
  const text = record("club", fixes);
  writeFileSync(join(OUT, "golden_10hz.csv"), text);
  const dataRows = text.split("\n").filter((l) => l && !l.startsWith("#")).length - 1; // minus header
  console.log(`golden_10hz.csv: ${fixes.length} fixes, ${dataRows} data rows`);
}

// ── stress: 30 minutes / 18,000 fixes on `fast`, 10 Hz ──
{
  const ct = compileTrack(geoTrackFromSynthetic(TRACKS.find((t) => t.id === "fast")!));
  const fixes: GnssFix[] = [];
  const sim: Partial<SimConfig> & { laps: number; noiseM: number } = {
    laps: 100,
    noiseM: 1.5,
    rateHz: 10,
    seed: 2026,
    truthSeed: 1,
  };
  simulate(ct, sim, (f) => {
    if (fixes.length < 18000) fixes.push(f);
  });
  writeFileSync(join(OUT, "stress_30min_18000.csv"), record("fast", fixes, 512));
  console.log(
    `stress_30min_18000.csv: ${fixes.length} fixes (~${(fixes.length / 10 / 60).toFixed(0)} min at 10 Hz)`,
  );
}
