# Apex Chrono — GNSS data contract (V1.5)

This is the contract between the GNSS receiver and the timing engine. Every input source has to produce exactly this stream:

- the live BN-880 on the ESP32-S3
- a recorded microSD file replayed offline
- the synthetic simulator

The timing engine (`src/lib/gnss`, and its C++ twin `firmware/lib/apex_timing`) consumes nothing else.

Status: **implemented for V1.5** — the recording file (§6) is written by the TS `CsvRecorder` (`src/lib/gnss/recording.ts`), parsed by `parseRecording`, and replayed through the shared timing engine by `npm run replay:gps -- <file>`. Committed fixtures live in `fixtures/recording/`.

## 1. One fix = one row

A *fix* is one navigation solution from the receiver: one epoch, normally every 100 ms at 10 Hz. It is the raw observation. Lap times, sector times, distance and deltas are **derived** results and never part of the contract.

### Required fields

| Field | Type | Unit / range | Meaning | BN-880 (NMEA) source |
| --- | --- | --- | --- | --- |
| `timestamp_ms` | integer (int64) | ms, strictly increasing within a session | Receiver UTC **time of fix** | GGA/RMC `hhmmss.ss` → ms of day (see §3) |
| `latitude` | decimal | degrees WGS84, −90…90, + = north | Position | GGA/RMC lat + N/S |
| `longitude` | decimal | degrees WGS84, −180…180, + = east | Position | GGA/RMC lon + E/W |
| `speed_kmh` | decimal or empty | km/h, ≥ 0 | Ground speed reported by the receiver (Doppler) | RMC knots × 1.852 |
| `heading_deg` | decimal or empty | degrees true, 0 ≤ h < 360, 0 = north, clockwise | Course over ground reported by the receiver | RMC course |
| `satellites` | integer | count, ≥ 0 | Satellites used in the solution | GGA field 7 |
| `hdop` | decimal | dimensionless, ≥ 0 | Horizontal dilution of precision | GGA field 8 |

### Optional fields

These are cheap to keep and the replay parser accepts them.

| Field | Type | Meaning |
| --- | --- | --- |
| `fix_quality` | integer or empty | NMEA GGA quality: 0 invalid, 1 GPS, 2 DGPS, 4/5 RTK, 6 dead reckoning |
| `altitude_m` | decimal or empty | GGA altitude above mean sea level, m. Not used for timing |
| `mcu_ms` | integer or empty | ESP32 `millis()` when the fix was parsed. **Diagnostic only** (receiver-to-MCU latency, logger stalls). It is never a clock for timing |

Rules for all fields:

- **Empty means "not reported".** `0` is a value, not a missing marker. The exceptions: `satellites` = 0 and `hdop` = 99.9 are what the driver writes when the receiver gave nothing, and the quality filter rejects both.
- **No derived values in raw fields.** If the receiver reports no speed, `speed_kmh` stays empty. Do not fill it from position differences; the engine derives speed itself when it has to.
- **Positions are not corrected, smoothed or snapped** before logging.

## 2. Units at the engine boundary

The engine's internal `GnssFix` (`src/lib/gnss/fix.ts`, `apex::GnssFix`) uses SI units. Exactly one adapter converts the contract row into it, and every source must go through that adapter:

| Contract | Engine (`GnssFix`) | Conversion |
| --- | --- | --- |
| `timestamp_ms` | `t` (s, float64) | `t = timestamp_ms / 1000` |
| `speed_kmh` | `speedMs` (m/s) | `speed_kmh / 3.6`; empty → undefined/NAN |
| `heading_deg` | `courseDeg` | unchanged; empty → undefined/NAN |
| `satellites` | `sats` | unchanged |
| `hdop` | `hdop` | unchanged |
| `fix_quality` | `fixType` | empty → unknown (−1/undefined), 0 → 0 (no fix), ≥ 1 → 3. GGA cannot tell 2D from 3D |

Float64 holds `timestamp_ms / 1000` with sub-microsecond resolution for more than 100 years of milliseconds, so the conversion loses no timing precision.

## 3. Timestamps

1. **Authority.** `timestamp_ms` is the only clock for timing. Browser frame time, `Date.now()`, `performance.now()` and `millis()` must never enter the timing engine. This is enforced in TS by tests that shift the time base and require identical laps.
2. **Origin.** UTC milliseconds since midnight of the session's first fix. Each UTC midnight rollover inside a session adds 86 400 000, so the value stays monotonic. The rollover is detected when the time of day falls by more than 12 h. Absolute date is not part of the row; the recording file header carries it *(Task 2)*.
3. **Resolution.** NMEA time has 10 ms resolution, so values are multiples of 10 ms. At 10 Hz the nominal step is exactly 100 ms.
4. **Ordering.** The stream must be strictly increasing.
   - **Duplicate** (Δt = 0) and **backwards** (Δt < 0) fixes are **rejected** by the engine's quality filter (`time`). They are never re-timed or reordered, and a recorder or replay reports them as warnings.
   - Rows are replayed in **file order**, exactly as recorded.
5. **No synthesis.** Missing epochs are not interpolated or invented by any source.

## 4. Gaps

The nominal interval is Δt = 100 ms. A gap is Δt > 100 ms between consecutive accepted fixes.

| Gap | Effect in the engine (current defaults) | Reporting |
| --- | --- | --- |
| ≤ 0.5 s | None. Map matching dead-reckons the search window with speed × Δt | — |
| > 0.5 s | No effect on its own | Replay warns: `GNSS gap of X.XX seconds at t=…` *(Task 2)* |
| > 1.0 s across a gate (`maxGapS`) | That gate crossing is rejected (`gap`). The lap is lost, never invented: a missed S/F merges two laps, which are then marked **invalid** | Gate rejection counter |
| Long outage | The map matcher falls back to a full scan on the next fix | `fullScans` counter |

## 5. Validity — what the engine accepts

Applied in this order (`checkFixQuality`, then the map matcher). Current defaults, unchanged from V1:

| Check | Default | Reject reason |
| --- | --- | --- |
| lat/lon/t finite, \|lat\| ≤ 90, \|lon\| ≤ 180 | — | `not_finite` |
| `fix_quality` / `fixType` present and < 2D | — | `no_fix` |
| `satellites` | ≥ 6 | `sats` |
| `hdop` | ≤ 2.5 | `hdop` |
| `timestamp_ms` strictly increasing | — | `time` |
| distance from the track centerline after map matching | ≤ 25 m | `cross_track` (map-match failure) |

Rejected fixes are counted and dropped by the engine, but they must still be **kept in a recording**: the raw file records everything the receiver said, and filtering is the engine's job. Checks the recorder/replay should *warn* about, without dropping:

- (0, 0) positions
- `speed_kmh` < 0 or > 400
- jumps much larger than speed × Δt
- runs of fixes below the satellite threshold

## 6. Recording file *(Task 2)*

- CSV, UTF-8, `,` separator, `.` decimal separator, LF line endings (CRLF accepted on read).
- Optional leading comment lines start with `#`; `# key=value` lines are metadata. The first line is `# apex-chrono gnss v1`. Recommended keys: `track`, `firmware`, `receiver`, `date` (UTC `YYYY-MM-DD`).
- Then one header row naming the columns: required first, optional after, in the order of §1. Readers must locate columns **by header name** and ignore unknown columns.
- Fixed write precision: `timestamp_ms` integer; lat/lon 8 decimals (≈ 1.1 mm); `speed_kmh` 2; `heading_deg` 1; `hdop` 2; `altitude_m` 1.
- One file per session, named from the first dated fix: `APEX_YYYYMMDD_HHMM.CSV` (UTC), with `_2`, `_3`, … appended on a name collision.

Example:

```
# apex-chrono gnss v1
# track=club
timestamp_ms,latitude,longitude,speed_kmh,heading_deg,satellites,hdop,fix_quality,altitude_m,mcu_ms
36000000,8.98369827,-79.51976510,156.41,240.2,14,0.87,1,12.0,4180
36000100,8.98370632,-79.51978083,158.83,241.8,13,0.64,1,12.0,4287
```

## 7. Conformance

A source conforms when:

1. every row satisfies §1 types and units, with "not reported" written as empty;
2. `timestamp_ms` comes from the receiver's time of fix (§3);
3. it feeds the engine only through the §2 adapter;
4. replaying its own output through the engine gives bit-identical laps, sector splits and events on every run (deterministic replay). **Implemented**: `npm run replay:gps -- <file>` replays a recording via the shared `GpsLapEngine`; determinism is tested (same file twice → identical laps/sectors/gates/timing) and the golden fixture lives in `fixtures/recording/`.
