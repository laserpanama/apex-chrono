# Apex Chrono

[![firmware](https://github.com/laserpanama/apex-chrono/actions/workflows/firmware.yml/badge.svg?branch=v1.5-hardware-readiness)](https://github.com/laserpanama/apex-chrono/actions/workflows/firmware.yml)

GNSS lap timer and drag meter: ESP32-S3 firmware plus a browser cockpit. The cockpit runs on a simulated 10 Hz GNSS fix and shows the same screens the hardware is meant to show, so the timing chain can be checked before any parts are on the car.

**Status (V1.5):** software ready for physical validation. The firmware compiles and passes its host tests. **It has not been run on real hardware yet.** The procedure for doing that is [docs/V1_5_TEST_PROCEDURE.md](docs/V1_5_TEST_PROCEDURE.md).

V1 answers “how fast was the lap?” V2 answers “where was the time made or lost?”

## Session

1. Pick a track. The car sits on the grid until you press **Start**.
2. The first pass of the start/finish stripe is the out-lap. The clock does not count yet.
3. The next crossing arms the lap. Sector gates stamp on exit. Crossing the stripe closes the lap and starts the next one. With GPS timing (the default) the lap is confirmed 1–3 s after the car crosses the line, once enough fixes from both sides are in.
4. **Pause** holds the car. **Reset** clears the session, the lap sheet, and the log.

Delta is time versus a reference lap at the same distance along the centerline. Positive is behind. It is only shown after the lap is armed.

GPS lock is green when the simulated fix has at least 8 satellites and HDOP under 2.0.

## Screens

| Screen | What it shows                                                        |
| ------ | -------------------------------------------------------------------- |
| Dash   | Lap clock, predictive delta, best, last, speed, sector, sats, HDOP   |
| Map    | Car on the centerline, with the start/finish stripe and sector gates |
| IMU    | G-meter plus accelerometer and gyro readouts. Live only in V2        |
| Laps   | Closed laps, with sector splits when the lap recorded them           |
| Log    | Session CSV, same idea as a V1 MicroSD file                          |
| Build  | V1 parts list and the V1 → V1.5 → V2 spend order                     |

**V1 timer** is the GPS lap timer and lands you on the dash. **V2 telemetry** turns the IMU board on and opens that screen. With V2 off, the G-meter sits at zero and the label reads “IMU off”.

## Tracks

All three are closed loops, driven counterclockwise from the stripe.

| Track         | Character                   | Sectors                                        | Reference lap |
| ------------- | --------------------------- | ---------------------------------------------- | ------------- |
| Club Circuit  | Practice loop, about 2.4 km | Start straight, Hairpin complex, Back straight | 78.4 s        |
| Marina Street | Technical street course     | Promenade, Chicane, Harbor, Pit exit           | 92.6 s        |
| Pacific Ring  | High-speed                  | Main straight, Esses, Final corner             | 64.2 s        |

Speed follows the corner radius. A tighter turn slows the car and raises lateral G. The reference lap is the baseline for the live delta, not a recorded personal best. Your best is whatever this session actually closes.

## IMU (preview)

There is no physical sensor in this build. V2 numbers are derived from the simulated path:

- Lateral G from speed and corner curvature, clamped to ±2.4 G
- Longitudinal G from the change in speed
- Vertical G near 1 G, with a small heave while the car is moving
- Yaw rate from lateral G and speed (degrees per second)
- Roll and pitch from the lateral and longitudinal G angles

Use them to see the layout of the board. Do not treat them as a logged chassis trace.

## CSV

**Download CSV** writes one file with a sample row per tick and a lap row per closed lap.

```
type,t_s,lap,lat,lon,speed_kmh,heading_deg,sats,hdop,g_long,g_lat,dist_m,lap_time_s,sectors
```

`sample` rows are the GNSS-style log. `lap` rows carry the lap number, max speed, lap time, and sector times.

## Hardware this preview stands in for

V1 target is about $90 delivered, $100 ceiling. The Build screen lists the shopping list: ESP32-S3 with a 3.5" 320×480 display, BN-880 GNSS at 10 Hz, a 12V→5V buck, microSD, fuse, wiring, and a dash box.

| Stage | Budget   | Job                                                      |
| ----- | -------- | -------------------------------------------------------- |
| V1    | $85–100  | GPS lap timer. Prove detection, the display, and logging |
| V1.5  | $120–160 | Better power, antenna, IMU, and mounts                   |
| V2    | $160–200 | IMU, live delta, sectors, braking and corner story       |

Run a real V1 lap before spending the next dollars. The extra money goes to GNSS, IMU, and power, not a bigger screen.

The Build screen is the original V1 plan. The prototype the V1.5 firmware actually targets uses a 2" ST7789 (320×240) and a BMI270 IMU. Its parts list and wiring are in [docs/V1_5_BOM.md](docs/V1_5_BOM.md).

## Run

```bash
npm install
npm run dev
```

The dev server listens on port 8080.

```bash
npm run build      # production build, then DB migrate
npm run typecheck
npm test
npm run test:timer     # GNSS timing layer: unit + integration tests
npm run validate:gps   # 1000-lap × 6-noise-level validation → docs/V1_VALIDATION_REPORT.md
npm run firmware:test  # C++ timing core vs TypeScript reference + display/IMU host tests (needs g++)
npm run replay:gps -- <file.csv> [--track club|street|fast | --track-file <file.track>]
npm run track:check -- <file.track>   # validate a real-circuit track file
```

`npm test` stops early: 15 template tests in `scripts/` fail because `.grok/` and `public/__grok/` are not in the repo. `npm run test:timer` is the authoritative timing suite.

Stack: Vite, TanStack Start, React 19, Tailwind 4. Timer state lives in `src/lib/timer` (Zustand store, lap engine, track geometry). The screens are in `src/components/timer/AppShell.tsx`.

## GPS timing (V1)

Laps and sectors in the preview come from the same GNSS pipeline the hardware runs: noisy 10 Hz fixes → map matching onto the centerline → geographic gates → lap state machine, all timed from GNSS timestamps. The code is in `src/lib/gnss`, the C++ port for the ESP32-S3 is in `firmware/`. Open the app with `?timing=synthetic` for the old distance-based laps when working on UI only.

See [V1_IMPLEMENTATION.md](V1_IMPLEMENTATION.md) for the design and [docs/V1_VALIDATION_REPORT.md](docs/V1_VALIDATION_REPORT.md) for measured accuracy. That accuracy comes from simulation, not from a real receiver.

## V1.5 hardware

Target: ESP32-S3-DevKitC-1 **N32R16V** (WROOM-2, Octal flash and PSRAM), BN-880Q GNSS at 10 Hz, 2" ST7789 320×240, microSD, BMI270 IMU. The pin map lives in `firmware/include/pins.h`, and the build fails on a pin conflict.

| Module  | Path                        | Job                                                                                   |
| ------- | --------------------------- | ------------------------------------------------------------------------------------- |
| GNSS    | `firmware/lib/apex_gnss`    | UART1 NMEA → contract rows + engine fixes, GNSS timestamps                            |
| Timer   | `firmware/lib/apex_timer`   | Track + lap engine (`apex_timing.h`, parity-tested against TS)                        |
| Storage | `firmware/lib/apex_storage` | Raw GNSS CSV on microSD ([contract](docs/GNSS_DATA_CONTRACT.md))                      |
| Display | `firmware/lib/apex_display` | GNSS lock, sats, HDOP, timing status, lap time, lap, sector, last/best, SD, IMU       |
| IMU     | `firmware/lib/apex_imu`     | BMI270 via Bosch Sensor API, accel/gyro samples with timestamps (not used for timing) |
| Drag    | `firmware/lib/apex_drag`    | 0-100, 60 ft, 1/8 and 1/4 mile, 100-200 km/h from Doppler speed (parity-tested vs TS) |

Timing never depends on the SD card, display or IMU. If any of them fails, that feature goes off and timing keeps running.

Build and flash from `firmware/`, using the DevKitC **UART** port:

```bash
pio run -t upload && pio device monitor -b 115200 -f time -f log2file
```

Without a track the display shows the **drag view**: stop for 1 s, launch, and it times 0-100, 60 ft, 1/8 and 1/4 mile ([docs/DRAG_MODE.md](docs/DRAG_MODE.md)). For laps, paste the circuit's `.track` file into the monitor after each boot. The device answers `TRACK,OK`. The SD card records every fix. Replay a session on the desktop with the same track file:

```bash
npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV --track-file my-circuit.track
```

The replay also lists every drag run in the file (`--rollout` for drag-strip 1 ft rollout).

CI compiles the firmware with PlatformIO on every push that touches `firmware/` and runs the host tests ([workflow](.github/workflows/firmware.yml)).

| Doc                                                        | What                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [docs/V1_5_TEST_PROCEDURE.md](docs/V1_5_TEST_PROCEDURE.md) | 15-step physical validation with PASS/FAIL criteria, plus the first bench session |
| [docs/V1_5_BOM.md](docs/V1_5_BOM.md)                       | Prototype parts, wiring table, power, test equipment                              |
| [docs/V1_5_HARDWARE.md](docs/V1_5_HARDWARE.md)             | Firmware architecture, display/IMU, board config, build results, open items       |
| [docs/V1_5_ARCHITECTURE.md](docs/V1_5_ARCHITECTURE.md)     | V1.5 pipeline audit and blockers                                                  |
| [docs/GNSS_DATA_CONTRACT.md](docs/GNSS_DATA_CONTRACT.md)   | Fix/row format shared by firmware, SD and replay                                  |
| [docs/DRAG_MODE.md](docs/DRAG_MODE.md)                     | Drag/acceleration timing: method, simulated accuracy, validation steps D1–D5      |

Not yet tested on hardware. Known gaps: tracks are loaded over serial only, the IMU is not logged to SD, the IMU axes are not mapped to the car, and the display timing is unmeasured. The full list is in `docs/V1_5_HARDWARE.md` §9.
