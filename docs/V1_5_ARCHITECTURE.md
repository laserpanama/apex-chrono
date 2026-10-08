# Apex Chrono V1.5 — hardware-readiness architecture (Task 1 audit)

Baseline audited: `v1-gps-validation` @ `f33d80f`. This document defines the single V1.5 timing pipeline, maps the existing code onto it, and lists what currently prevents it. **No code was changed for Task 1.** The raw input format is specified in [`GNSS_DATA_CONTRACT.md`](GNSS_DATA_CONTRACT.md).

## 1. The single pipeline

```
 ┌───────────── sources (exactly one active) ─────────────┐
 │ 1. synthetic   deterministic simulator                  │
 │ 2. replay      recorded APEX_*.CSV (microSD → desktop)  │
 │ 3. live        BN-880 → ESP32-S3 UART                   │
 └──────────────────────────┬──────────────────────────────┘
                            │  contract row (GNSS_DATA_CONTRACT.md)
                            ▼
                 adapter: row → GnssFix (ms→s, km/h→m/s)        ── the only unit conversion
                            ▼
                 quality filter      checkFixQuality             fix.ts / apex::checkFixQuality
                            ▼
                 map matching        LocalFrame + MapMatcher     geo.ts, centerline.ts / apex::MapMatcher
                            ▼
                 gates               GateDetector                gates.ts / apex::GateDetector
                            ▼
                 lap/sector engine   GpsLapEngine                lap-engine.ts / apex::LapEngine
                            ▼
                 timing snapshot  ──▶ display (cockpit / 3.5" TFT)
                                  └─▶ logging (laps/events; the raw fixes are logged at the source tap)
```

The rules:

- **One engine.** `GpsLapEngine` (TS) and `apex::LapEngine` (C++) are the same algorithm, held equal by the parity test (`npm run firmware:test`, max |C++ − TS| = 0 s). No source gets its own timing logic.
- **Sources produce raw fixes only.** A source never decides laps, sectors or crossings.
- **The receiver timestamp is the only clock** (contract §3).
- **Raw logging taps the stream before the adapter.** It observes; it cannot change or block timing.

## 2. What exists today (audit)

| Stage | TypeScript (`src/lib/gnss`) | C++ (`firmware/lib/apex_timing/apex_timing.h`) | Verdict |
| --- | --- | --- | --- |
| Coordinate conversion | `geo.ts` `LocalFrame` (WGS84 radii), Vincenty-checked to < 5 cm / 3 km | `apex::LocalFrame` | Ready |
| Quality filter | `fix.ts` `checkFixQuality` | `apex::checkFixQuality` | Ready |
| Map matching | `centerline.ts` windowed + full-scan fallback, seam-safe | `apex::MapMatcher` | Ready |
| Gates | `gates.ts` state machine, adaptive refinement, guards | `apex::GateDetector` | Ready |
| Lap/sector engine | `lap-engine.ts` incl. `live()` snapshot, best lap, live delta | `apex::LapEngine` (no snapshot struct) | Ready (snapshot gap on C++) |
| Track definition | `track.ts` `GeoTrackDef` → `compileTrack` | `apex::Track::compile` | Ready; only synthetic tracks exist |
| Synthetic source | `sim.ts` (validation); `SessionEngine.gnssFix()` (browser) | — | Works, but two generators (B2) |
| Replay source | **none committed** | **none** | Missing (B1) |
| Live source | — | `firmware/src/main.cpp` (TinyGPSPlus, inline) | Works, not contract-shaped (B4) |
| Display | React cockpit via `store.ts` snapshot | serial `EVT,` lines only | TFT out of scope for Task 1 |
| Logging | browser CSV export (derived samples) | serial `FIX,` lines | Raw logging missing (B1, B4) |

Tests at `f33d80f`, re-run for this audit:

- `npm run typecheck`: passes
- `npm run test:timer`: 67/67
- `npm run firmware:test`: 3/3 parity PASS
- `npm run build`: passes
- `npm test`: 182/197. The 15 failures are the pre-existing template `scripts/` tests and are identical on `main`.

The 1000-lap validation (`docs/V1_VALIDATION_REPORT.md`) is unchanged and remains the software-simulation baseline. **No physical GNSS validation exists yet.**

## 3. What prevents the architecture

| # | Blocker | Where | Why it matters | Fix (task) |
| --- | --- | --- | --- | --- |
| B1 | No raw recording format, recorder, parser or replay tool on any committed branch | — | Source 2 does not exist; a track session could not be reproduced offline | Implement contract §6 writer (firmware) and parser + `replay:gps` (TS) — Task 2. Uncommitted work-in-progress for this exists only as a local `git stash` on `v1-gps-validation`; it is not part of this branch |
| B2 | Two synthetic fix generators with different noise and PRNG: `sim.ts` (validation, mulberry32, truth tracking) and `SessionEngine.gnssFix()` (browser, LCG, σ = 1.4 m) | `src/lib/gnss/sim.ts`, `src/lib/timer/engine.ts` | The browser synthetic source is not the validated one, and neither emits contract rows | One `GnssFixSource` interface; the browser draws fixes from the same generator — Task 2 |
| B3 | The browser `"synthetic"` timing mode bypasses the GNSS engine entirely (distance-wrap laps) | `SessionEngine.step` (non-GPS branch) | A fourth timing path outside the single engine | Keep it as a UI-only demo mode, explicitly outside the three sources, or retire it once B2 lands — Task 2 decision |
| B4 | Firmware mixes GNSS parsing, timing and output in `main.cpp` | `firmware/src/main.cpp` | `FIX,` lines are seconds-with-2-decimals, m/s, no header, `nan` for missing values: **not** the contract and not replayable as-is. Time is computed as `double` seconds of day instead of integer ms | Split into GNSS driver → contract row → adapter → engine. The logger taps the row — Task 2 |
| B5 | GGA fix quality is not captured; firmware sets `fixType = 3` whenever the location is valid | `main.cpp` | The `no_fix` filter can never trigger on hardware | Read GGA field 6 (`TinyGPSCustom` for `GNGGA`/`GPGGA`) into `fix_quality` — Task 2 |
| B6 | No source-independent timing snapshot on the C++ side (TS has `GpsLapEngine.live()`; C++ exposes only `liveDelta()`, `lastLap()`, `inLapNow()`) | `apex_timing.h` | Display/logging sinks on the MCU would reach into engine internals | Add an `apex::LiveState` mirroring `live()`, covered by the parity test — before display work |
| B7 | `.track` text format has a writer (`export-fixtures.ts`) and C++ readers, but no TS reader; the browser and firmware cannot load a real circuit except via serial paste | `src/lib/gnss`, `main.cpp` | Real-track replay and live tests need the same track file on desktop and MCU | TS `parseTrackFile` + `--track` for replay (Task 2); SD track loading later |
| B8 | The browser cockpit draws the car from synthetic `distM` on built-in tracks | `SessionEngine.pose()` | Replay or live of a surveyed circuit cannot be shown until the cockpit takes its geometry from the compiled track | Position the car from the map match; load the track geometry — after Task 2 |
| B9 | The engine boundary uses SI units (`t` in s, m/s) while the contract uses ms and km/h; there is no shared adapter yet | `fix.ts`, `apex_timing.h` | Each source could convert differently (rounding, NaN handling) | One `toGnssFix(row)` in TS and C++, parity-tested — Task 2 |
| B10 | Test runner requires Node with built-in TypeScript stripping (official Node ≥ 22.6). Distro builds without it fail with `ERR_NO_TYPESCRIPT`; `npm test` chains behind 15 pre-existing failures | `package.json` | CI/dev setup friction; the timer suite is not reached by `npm test` | Document the Node requirement; keep `npm run test:timer` as the authoritative timing suite |

None of these require changing the validated algorithms (coordinate conversion, map matching, gates, lap engine or their acceptance criteria). They are boundary and plumbing issues.

## 4. Task 2 scope (recording + replay)

1. Implement contract §6: a firmware raw logger with a fixed-size ring and non-blocking writes, where SD failure never stops timing; a TS parser with warnings; `npm run replay:gps -- <file> [--track …]`. (B1, B9)
2. Split the firmware into a GNSS driver (contract rows, integer `timestamp_ms`, GGA quality), the adapter, the engine, and the logger tap. (B4, B5)
3. Add a `GnssFixSource` interface with synthetic, replay and (on hardware) live implementations, all running through one `GpsLapEngine`. Unify the browser synthetic generator with `sim.ts`. (B2, B3 decision)
4. Golden synthetic dataset in the contract format, determinism tests (replay twice → identical), C++ ↔ TS byte-identical recording lines, and a 30-minute/18 000-fix performance check.
5. TS `.track` reader. (B7)

Out of scope until later tasks: the TFT display, IMU, SD track loading, the C++ `LiveState` (B6) and the real-track cockpit (B8).

## 5. Task 2 done on `v1.5-hardware-readiness`

The recording + replay half of Task 2 is implemented **on the TypeScript side**:

- `src/lib/gnss/recording.ts` — contract §6 writer (`CsvRecorder`, chunked, failure-tolerant: a dead sink is counted and never blocks/stops the engine), reader (`parseRecording`: header-by-name, unknown-column tolerant, gap/duplicate/backwards-timestamp diagnostics, low-SNR runs, malformed-row handling), adapters (`rowToFix`/`fixToRow`, the only contract↔engine conversion), and `replayRecording` which feeds the shared `GpsLapEngine`.
- `npm run replay:gps -- <file> [--track <id>]` — deterministic replay CLI (`src/lib/gnss/replay-cli.ts`).
- `npm run fixtures:recording` — regenerates the committed fixtures (`src/lib/gnss/export-recording-fixtures.ts`):
  - `fixtures/recording/golden_10hz.csv` — realistic 10 Hz session (12 laps, club, noise 2 m, degraded-quality + dropped fixes).
  - `fixtures/recording/stress_30min_18000.csv` — 10 Hz / 30 min / 18,000 fixes.
- Tests: `src/lib/gnss/__tests__/recording.test.ts` (13 tests) — deterministic replay (same file twice → identical laps/sectors/gates/timing), gap/duplicate/backwards detection with engine rejection, malformed handling, the 18,000-fix stress (replays in < 0.5 s), and the "logging failure never stops timing" guarantee.
- Remaining in Task 2 scope: firmware contract writer + GGA fix_quality + the driver split (B4/B5) and the TS `.track` reader (B7) are **not yet** in this change — the fixtures here use the synthetic tracks via `--track`/metadata.
