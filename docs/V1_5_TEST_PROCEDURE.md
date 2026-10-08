# Apex Chrono V1.5 — physical validation procedure

This is the procedure that turns "software ready" into "validated on hardware". **Nothing in V1.5 has been tested on physical hardware yet.** V1.5 counts as physically validated only when every section below has a recorded PASS, including the vehicle tests (§11, §12) and the timing comparison (§15).

Hardware: `docs/V1_5_BOM.md` (parts, wiring table). Firmware internals: `docs/V1_5_HARDWARE.md`. Recording format: `docs/GNSS_DATA_CONTRACT.md`.

Run the sections in order. Each one depends on the ones before it. A FAIL stops the procedure: fix the cause, then repeat that section.

## 0. Before you start

### 0.1 Software state

On the laptop that will flash the board (PlatformIO Core and Node ≥ 22.6 installed):

```bash
git clone -b v1.5-hardware-readiness https://github.com/laserpanama/apex-chrono && cd apex-chrono && npm install && npm run firmware:test && npm run test:timer && git log -1 --format="%H %s"
```

PASS: `PASS hw_test`, three `PASS` parity lines, `# fail 0`. Write the commit hash in the record sheet (§16). The GitHub Actions `firmware` run for that commit must be green.

### 0.2 Serial console

All checks read the USB serial log at 115200 baud. Use the DevKitC port labelled **UART** (not "USB"). From `firmware/`:

```bash
pio run -t upload && pio device monitor -b 115200 -f time -f log2file
```

`log2file` keeps a `platformio-device-monitor-*.log` file in `firmware/`. Keep every log; it is the evidence for this procedure.

What the firmware prints:

| Line                               | When                    | Content                                                                                                                                                                                            |
| ---------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APEX_CHRONO,V1.5,BOOT,...`        | once at boot            | `chip`, `flash` and `psram` size, `sd` / `display` / `imu` bring-up (1 = ok)                                                                                                                       |
| `IMU,...`                          | once at boot            | BMI270 state, address, chip ID, communication-test detail                                                                                                                                          |
| `TRACK,OK,...` / `TRACK,ERROR,...` | after a track is pasted | points, gates, lap length                                                                                                                                                                          |
| `EVT,...`                          | on timing events        | `LAP_START`, `SECTOR`, `LAP` (time, valid/invalid), `REJECT_*`, `IGNORED`                                                                                                                          |
| `STAT,...`                         | every second            | `nmea_chars/ok/bad/hz` (raw UART), `fixes`, `gnss_hz`, `lock`, `sats`, `hdop`, `timing`, `lap`, `sector`, `sd`, `rows`, `sd_fail`, `imu`, `imu_hz`, `imu_fail`, `ax..gz`, `disp_us`, `disp_max_us` |

### 0.3 Track files

The device has no stored track. After **every** boot, paste the `.track` file into the serial monitor (or use the monitor's file-upload key, Ctrl+T then Ctrl+U, if your terminal supports it). The device answers `TRACK,OK,<points>_points,<gates>_gates,<length>_m`. Until then the display shows `NO TRACK LOADED`: fixes are still logged to SD but not timed.

Make one track file per test site (§11 loop, §12 circuit):

1. In a satellite map (Google Earth, OpenStreetMap), trace the **centerline in the driving direction** as a closed loop: one point every 3–5 m in corners, up to 20–30 m on straights; at most 1,536 points.
2. Draw the **start/finish line** across the whole track at the real start line, extending ≥ 5 m beyond each track edge. Record its two ends as `left` / `right` **as seen by a driver going the correct way**. Then do the same for each sector line, in driving order (the §11 loop: 2 sector lines; a circuit: its official sector points).
3. Write the file:

   ```
   origin <lat> <lon>            first centerline point is fine
   centerline <N>
   <lat> <lon>                   × N
   gates <G>
   SF  <leftLat> <leftLon> <rightLat> <rightLon>
   SEC <leftLat> <leftLon> <rightLat> <rightLon>   × (G − 1)
   END
   ```

   No comment lines. Decimal degrees with ≥ 6 decimals.

4. Check it, and fix every error and warning before going to the site:

   ```bash
   npm run track:check -- my-circuit.track
   ```

   PASS: `TRACK OK`, lap length within ±3% of the published length, gates in the right order and distance from S/F, every gate wider than the track.

---

## 1. Visual inspection (unpowered)

Equipment: multimeter, magnifier, `docs/V1_5_BOM.md`.

1. Read the markings: ESP32 module can says `ESP32-S3-WROOM-2` and `N32R16V`; GNSS `BN-880Q`; display 2.0" ST7789 240×320; IMU BMI270; microSD card FAT32 SDHC.
2. Check every solder joint: no bridges, no cold joints, no loose strands; header pins straight.
3. Continuity-check every signal in the BOM wiring table (§4), from the module pin to the ESP32 pin: beep on the intended pin, **no** beep to the neighbouring pins.
4. Measure resistance 5V→GND and 3V3→GND (wait ~5 s for capacitors to charge).
5. Mechanics: connectors locked, strain relief on every cable that leaves the enclosure, GNSS antenna side facing up, IMU screwed or hard-glued.

| PASS                                                                                        | FAIL                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| All markings match the BOM; 100% of wiring-table signals correct; both rails > 100 Ω to GND | Any wrong marking, wrong/missing connection, or rail < 100 Ω |

## 2. Power test

Equipment: multimeter, USB power meter, vehicle with the 12 V → 5 V converter.

**2a — GNSS logic level, before connecting the GNSS TX wire.** Power only the BN-880Q (correct VCC per its label) and measure its TX pin to GND while idle (UART idles high).

**2b — Bench.** Connect everything, power through the USB meter on the UART port, and let it run 5 minutes with an SD card inserted (the logger writes once a fix exists; indoors it stays idle — repeat the current reading outdoors in §5).

**2c — Vehicle.** Power from the 12 V converter. Measure 5 V at the DevKitC 5V pin: engine off, during cranking, engine at idle, at 3,000 rpm with headlights + A/C on.

| Check                                | PASS                                                                                 | FAIL                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| BN-880Q TX idle level                | ≤ 3.4 V                                                                              | > 3.4 V — do not connect; add a level shifter |
| 5 V rail (bench and vehicle running) | 4.75–5.25 V                                                                          | outside                                       |
| 3.3 V rail                           | 3.20–3.40 V                                                                          | outside                                       |
| Current, steady (bench)              | < 500 mA; record the value                                                           | ≥ 500 mA or rising / hot parts                |
| Engine running 10 min                | no `BOOT` line reprinted (no reset)                                                  | any reset while running                       |
| Cranking                             | no reset, **or** a reset that ends in a normal boot and a new SD file (record which) | does not come back without unplugging         |

## 3. ESP32 boot

1. Flash and open the monitor (§0.2). Do not paste a track yet.
2. Read the first lines; watch for 5 minutes.
3. Power-cycle 3 times (unplug 10 s).

Expected (values will differ slightly):

```
APEX_CHRONO,V1.5,BOOT,chip=ESP32-S3,flash=33554432,psram=16...,sd=1,display=1,imu=1
IMU,state=running,addr=0x68,chip=0x24,bosch=0,comm_reads=5,fresh_acc=5,fresh_gyr=5,time_adv=1,not_stuck=1,mag_g=1.00x,gravity_ok=1,...
APEX_CHRONO,V1.5,GNSS_READY,send track then END
STAT,ms=...,nmea_chars=...
```

| PASS                                                                                                                                                                                             | FAIL                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `chip=ESP32-S3`, `flash=33554432`, `psram` ≥ 15,000,000; `sd=1 display=1 imu=1`; one `STAT` per second; no reset, `Guru Meditation` or watchdog message in 5 min; 3/3 power cycles boot the same | No output, boot loop, `flash` ≠ 33554432 or `psram=0` (memory configuration wrong — see `docs/V1_5_HARDWARE.md` §7; **stop here**), any crash |

## 4. GNSS UART (indoors is fine)

The receiver sends GGA + RMC 10 times a second even with no satellites (empty fields), so the UART can be proven before any lock. Read 60 consecutive `STAT` lines.

| Check        | PASS                                    | FAIL → likely cause                                                       |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| `nmea_chars` | increases every second                  | flat → TX/RX swapped, no GNSS power, wrong pin                            |
| `nmea_hz`    | 18–22 every second (GGA + RMC at 10 Hz) | ≈ 2 → still 1 Hz (rate command ignored); > 30 → GSV/GSA not disabled      |
| `nmea_ok`    | increases with `nmea_chars`             | chars rise but `nmea_ok` flat → baud mismatch (115200 switch not applied) |
| `nmea_bad`   | 0 new in 60 s                           | rising → noise, ground loop, long or loose wire                           |

## 5. GNSS outdoor lock

Open sky, ≥ 30° clear above the horizon all round, away from buildings. Device stationary.

1. **Cold start**: GNSS unpowered ≥ 2 h (or first use). Power up; note the time of the first `STAT` with `lock=1`.
2. Leave it 10 minutes. Note `sats` and `hdop` every minute.
3. **Hot start**: unplug 60 s, re-plug, time to `lock=1`.
4. Repeat the §2 current reading while logging.

| Check                   | PASS                                         | FAIL      |
| ----------------------- | -------------------------------------------- | --------- |
| Cold start to `lock=1`  | ≤ 120 s                                      | > 120 s   |
| Hot start to `lock=1`   | ≤ 30 s                                       | > 30 s    |
| After 10 min            | `sats` ≥ 8 and `hdop` ≤ 1.5 on every reading | otherwise |
| `lock` after first lock | never drops to 0 while stationary            | any drop  |

The timing engine itself only needs `sats` ≥ 6 and HDOP ≤ 2.5; the PASS limits above are stricter on purpose so there is margin in the car.

## 6. 10 Hz verification

Use the SD file from §5 (≥ 10 minutes locked): copy it per §13 and run

```bash
npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV
```

Read the `receiver:` block (without a track file the lap sheet below it means nothing here; ignore it). Also check `gnss_hz` in the `STAT` lines.

| Check                    | PASS              | FAIL                                         |
| ------------------------ | ----------------- | -------------------------------------------- |
| `STAT gnss_hz` (locked)  | 9–11 every second | any second < 9 (dropped fixes) or ≤ 2 (1 Hz) |
| `rate`                   | 9.95–10.05 Hz     | outside                                      |
| intervals at 100 ± 10 ms | ≥ 99.5%           | less                                         |
| max interval             | ≤ 300 ms          | more (UART bytes lost or receiver gaps)      |
| duplicates / backwards   | 0 / 0             | any                                          |

## 7. SD write / read

1. Logging run: locked outdoors for 10 minutes. In `STAT`: `sd=logging`, `rows` +10 per second, `sd_fail=0`. Note the last `rows` value.
2. Stop: wait ≥ 5 s (rows are flushed every 2 s), unplug power, read the card on the laptop (§13).
3. **No card**: boot without a card for 2 minutes outdoors.
4. **Card pulled while logging**: remove the card mid-run, watch 1 minute.

| Check           | PASS                                                                                                                                             | FAIL                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| File            | `APEX_YYYYMMDD_HHMM.CSV` (UTC date/time); starts with `# apex-chrono gnss v1`, `# firmware=v1.5`, `# receiver=BN-880Q`, `# date=...`, header row | missing, wrong name, wrong header |
| Rows            | file rows ≥ last `STAT rows` − 20                                                                                                                | fewer                             |
| Parse           | `replay:gps`: no `malformed` warning (one malformed **last** line is allowed after an unplug)                                                    | any other malformed row           |
| No card at boot | display `SD NO CARD`, `sd=no_card`; `gnss_hz` stays 9–11                                                                                         | anything stops or resets          |
| Card pulled     | display `SD LOG … ERR n` then `SD FAILED`; `gnss_hz` stays 9–11; `EVT` lines still appear when a track is loaded                                 | reset, hang, or `gnss_hz` drops   |

Re-inserting the card does not resume logging in V1.5; reboot.

## 8. Display test

1. Boot screen (no track): line 1 `NO FIX …` or `FIX …`, line 2 `NO TRACK LOADED`, big `-:--.-`, `LAP -`, `LAST --`, `BEST --`, SD and IMU lines.
2. Outdoors, locked, track loaded: line 2 `READY - CROSS START`.
3. Compare the display with the `STAT` line printed at the same moment, 10 times.
4. Daylight readability at the mounting position.
5. **Panel disconnected** (power off, unplug the display connector, boot, run 5 minutes outdoors).

| Check              | PASS                                                                            | FAIL                                                                                  |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Layout             | all 8 lines visible, landscape, not mirrored or cut off                         | wrong orientation/size → `kRotation` or panel resolution (`docs/V1_5_HARDWARE.md` §5) |
| Values             | `sats`, `hdop`, timing status, SD rows match `STAT` (SD rows within one second) | any mismatch                                                                          |
| Redraw cost        | `disp_us` ≤ 10,000 typical, `disp_max_us` ≤ 30,000                              | larger (record; reduce `kSpiHz` only if noise)                                        |
| Timing unaffected  | `gnss_hz` 9–11 while the display updates                                        | drops                                                                                 |
| Readable           | lap time and LAST readable at the driving position in sun                       | not readable                                                                          |
| Panel disconnected | boots, `STAT` normal, `gnss_hz` 9–11, SD logging                                | reset or stall                                                                        |

Sector and lap fields are checked while driving in §11.

## 9. IMU test

1. At boot, board level and still: read the `IMU,` line.
2. Still for 2 minutes: read `ax ay az gx gy gz` and `imu_hz` from `STAT`.
3. Six-face test: rest the board on each of its 6 faces for 10 s.
4. Rotation: turn the board slowly counter-clockwise seen from above (+Z up), about 90° in 2 s.
5. **IMU disconnected**: power off, unplug the BMI270 SDA wire, boot, run 2 min.
6. **IMU lost while running**: unplug SDA while running.

| Check                | PASS                                                                                                                                       | FAIL                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Boot line            | `state=running`, `chip=0x24`, `comm_reads=5`, `fresh_acc=5`, `fresh_gyr=5`, `time_adv=1`, `not_stuck=1`, `gravity_ok=1`, `mag_g` 0.95–1.05 | anything else (the `state` names the stage that failed) |
| Rate                 | `imu_hz` 95–105                                                                                                                            | outside                                                 |
| Still                | √(ax²+ay²+az²) = 9.81 ± 0.3 m/s²; each of gx, gy, gz within ±3 °/s; `imu_fail` 0                                                           | outside                                                 |
| Six faces            | the axis pointing up reads +9.8 ± 0.5, pointing down −9.8 ± 0.5, the other two within ±1.0 m/s² (axes as printed on the breakout)          | wrong axis, sign or magnitude                           |
| Rotation             | `gz` clearly positive (tens of °/s) during the turn, back near 0 after                                                                     | negative or no change                                   |
| Disconnected at boot | `state=not_found`, display `IMU --`, `gnss_hz` 9–11                                                                                        | reset, hang or `gnss_hz` drop                           |
| Lost while running   | display `IMU FAILED`, `imu=failed`, `gnss_hz` 9–11                                                                                         | reset, hang or `gnss_hz` drop                           |

Record the breakout's axis directions relative to the vehicle (x forward? y left?) — V2 needs it; V1.5 does not remap axes.

## 10. Stationary test

Vehicle parked in open sky for **30 minutes**, device installed as it will be driven, track of the §11 site loaded, vehicle placed **on the start/finish line** (or within 5 m of it). Engine may run for A/C. Then copy the CSV and run `replay:gps` with the track (§14 command).

| Check               | PASS                                                                         | FAIL                               |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| False timing events | no `EVT,LAP_START`, `EVT,SECTOR`, `EVT,LAP` in 30 min                        | any                                |
| Position scatter    | `receiver:` → longest stationary run ≥ 95% of the rows; position p95 ≤ 3.0 m | larger (record sky view, mounting) |
| Receiver            | §6 criteria hold for the 30 min                                              | any §6 FAIL                        |
| Heat                | no reset; enclosure not too hot to hold                                      | reset or hot parts                 |

## 11. Slow vehicle test

**Safety:** private car park or closed road only, a second person reads the laptop, the driver only drives.

Site: a loop of 300–1,000 m with the S/F line and 2 sector lines in its `.track` file (§0.3). The engine ignores gate crossings below **15 km/h** and laps shorter than **10 s**, so drive **20–40 km/h through every line** and use a loop that takes more than 10 s.

1. Boot, paste the track (`TRACK,OK`), wait for `lock=1`.
2. One out-lap, then **10 laps** in the correct direction. A passenger writes down each lap time from a stopwatch.
3. Then **1 lap in the opposite direction**.

| Check            | PASS                                                                                                | FAIL                   |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| Start            | one `EVT,LAP_START` at the first S/F crossing; display `TIMING`                                     | missing or late        |
| Laps             | exactly 10 `EVT,LAP …,valid`                                                                        | missed, extra, invalid |
| Sectors          | 20 `EVT,SECTOR` in order 1, 2 per lap; display `S1/3 → S2/3 → S3/3`                                 | missing, out of order  |
| Display          | big lap time counts up; `LAST` = the `EVT,LAP` time (3 decimals) after each lap; `LAP n` increments | mismatch               |
| Reverse lap      | no `EVT,LAP` and no `EVT,SECTOR` counted                                                            | any counted            |
| Stopwatch sanity | each device lap within ±0.5 s of the stopwatch (human reaction time)                                | larger                 |
| No errors        | no `REJECT_ORDER`; `sd_fail=0`; `gnss_hz` 9–11 throughout                                           | any                    |

## 12. Track test

At a circuit (track day). At least **10 timed laps** at representative pace, plus out- and in-laps.

1. Before going out: `npm run track:check` the circuit file, boot, paste the track, `lock=1`, `sd=logging`.
2. Capture the device's own laps:
   - **preferred**: laptop logging the serial monitor (§0.2), secured and operated by a passenger, if the event allows a passenger; otherwise
   - a camera filming the display (the `LAST` line after each lap).
3. Capture the **independent reference** for the same laps (BOM §5): circuit transponder timing sheet, a commercial GNSS lap timer mounted in the same car, or ≥ 120 fps video of the S/F line.

| Check         | PASS                                                                    | FAIL           |
| ------------- | ----------------------------------------------------------------------- | -------------- |
| Lap detection | device lap count = reference lap count; 0 extra laps                    | any difference |
| Sectors       | every lap has all sector events, in order                               | any missing    |
| Stability     | no reset; `sd_fail=0`; `gnss_hz` 9–11 in every `STAT`; display readable | any            |

## 13. Extract the CSV

1. After the in-lap: stop, wait ≥ 5 s, then power off.
2. Copy `APEX_YYYYMMDD_HHMM.CSV` (and any `_2`, `_3` files of the same session) to the laptop. Keep the card's original untouched.
3. Record the file's SHA-256 and row count:

   ```bash
   certutil -hashfile APEX_YYYYMMDD_HHMM.CSV SHA256
   ```

   (Linux/macOS: `sha256sum APEX_YYYYMMDD_HHMM.CSV`.)

| PASS                                                                                        | FAIL                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------- |
| File present, opens, header per §7, name's UTC date/time matches the session, hash recorded | missing, unreadable, wrong session |

## 14. Desktop replay

From the repo root, twice, and compare:

```bash
npm run track:check -- my-circuit.track && npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV --track-file my-circuit.track > replay-1.txt && npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV --track-file my-circuit.track > replay-2.txt && git diff --no-index --stat replay-1.txt replay-2.txt && echo REPLAY-DETERMINISTIC
```

| Check       | PASS                                                                                                                                                        | FAIL                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Determinism | `REPLAY-DETERMINISTIC` (both runs identical)                                                                                                                | any difference                                      |
| Parse       | no malformed rows (except one final line after an unplug); `receiver:` meets §6                                                                             | otherwise                                           |
| Quality     | `rejected:` shows only `cross_track`, and only as many as the time spent off the circuit (pit lane, paddock) explains; no `sats`/`hdop`/`no_fix` rejections | otherwise (antenna, mounting or track-file problem) |
| Laps        | lap sheet lists the same number of laps as §12                                                                                                              | otherwise                                           |

## 15. Compare timing

Build one table, one row per timed lap: device live time (`EVT,LAP` from the serial log, or `LAST` from the video), desktop replay time (§14 lap sheet), reference time (§12), and the same for every sector (`EVT,SECTOR` vs replay splits).

**15a — Device vs desktop replay (same software, same data).** The device times full-precision fixes; the CSV stores latitude/longitude to 8 decimals (~1 mm) and speed to 0.01 km/h, so tiny differences are expected.

| PASS                                                                                     | FAIL                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Same number of laps, same valid/invalid flags; every lap and sector differs by ≤ 0.002 s | any difference in count/validity, or any \|Δ\| > 0.002 s |

(With a video instead of a serial log, the display shows 3 decimals: ≤ 0.002 s still applies.)

**15b — Device vs independent reference (accuracy).** Over ≥ 10 laps:

| Check         | PASS          | FAIL      |
| ------------- | ------------- | --------- |
| Lap count     | identical     | different |
| P95 \|Δ lap\| | ≤ 60 ms       | > 60 ms   |
| Max \|Δ lap\| | ≤ 120 ms      | > 120 ms  |
| Mean Δ (bias) | within ±20 ms | outside   |

60 ms is the V1 simulation acceptance limit at 1.5 m position noise (`docs/V1_VALIDATION_REPORT.md`), which is the expected BN-880 class. The reference's own uncertainty counts against the device: transponder ≈ 1 ms, 120 fps video ≈ ±8 ms per crossing; 30 fps phone video (±33 ms) is too coarse.

Drag mode (0-100, 60 ft, 1/4 mile) has its own steps D1–D5 in [DRAG_MODE.md](DRAG_MODE.md) §6. Run them after steps 1–10 pass, on a closed course or drag strip only.

## 16. Record sheet

Copy this into the test log for each session.

```
Date / place / weather / sky view:
Operator(s):
Firmware commit (§0.1):                      CI run green: yes / no
Hardware: module marking / GNSS / display / IMU / SD card:
Mounting: GNSS position / IMU orientation (x→ , y→ , z→ ):

§1 Visual            PASS / FAIL   notes:
§2 Power             PASS / FAIL   GNSS TX idle __ V, 5V __ V, 3V3 __ V, current __ mA, crank: reset yes/no
§3 Boot              PASS / FAIL   flash __ psram __
§4 GNSS UART         PASS / FAIL   nmea_hz __
§5 Outdoor lock      PASS / FAIL   cold __ s, hot __ s, sats __, hdop __
§6 10 Hz             PASS / FAIL   rate __ Hz, nominal __ %, max interval __ ms
§7 SD                PASS / FAIL   rows STAT __ / file __, no-card ok, pull ok
§8 Display           PASS / FAIL   disp_us __, disp_max_us __, panel-off ok
§9 IMU               PASS / FAIL   imu_hz __, |a| __, gyro max __, faces ok, unplug ok
§10 Stationary       PASS / FAIL   false events __, p95 __ m
§11 Slow vehicle     PASS / FAIL   laps __/10, sectors __/20, reverse ok
§12 Track            PASS / FAIL   laps device __ / reference __
§13 CSV              PASS / FAIL   file __ sha256 __ rows __
§14 Replay           PASS / FAIL   deterministic, laps __
§15a Device↔replay   PASS / FAIL   max |Δ| __ s
§15b Device↔reference PASS / FAIL  P95 __ ms, max __ ms, bias __ ms

V1.5 physically validated: yes (all PASS) / no
```

## First hardware session (bench, about 1 hour)

The shortest path to the first real result, in this order, stopping at the first FAIL:

1. §0.1 software check and §1 visual + continuity, everything unpowered.
2. §2a: power the BN-880Q alone, measure TX idle ≤ 3.4 V. Only then connect GNSS TX → GPIO 18.
3. §2b: power over USB through the meter; rails and current.
4. §3: flash, read the `BOOT` line — `flash=33554432` and `psram` ≥ 15,000,000 confirm the corrected Octal memory configuration — and the `IMU,` line; 5 minutes, 3 power cycles.
5. §4: indoors, `nmea_hz` 18–22 proves UART + 10 Hz configuration before any sky view.
6. §8 boot screen and §9 steps 1–4 on the bench.
7. Outdoors: §5 and §6, then §7.
