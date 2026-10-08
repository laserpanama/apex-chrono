# Apex Chrono

Pit-wall dashboard for an ESP32-S3 lap timer. This repo is the cockpit preview: a simulated 10 Hz GNSS fix drives the same screens the V1 hardware is meant to show, so the timing chain can be checked before any parts are on the car.

V1 answers “how fast was the lap?” V2 answers “where was the time made or lost?”

## Session

1. Pick a track. The car sits on the grid until you press **Start**.
2. The first pass of the start/finish stripe is the out-lap. The clock does not count yet.
3. The next crossing arms the lap. Sector gates stamp on exit. Crossing the stripe closes the lap and starts the next one.
4. **Pause** holds the car. **Reset** clears the session, the lap sheet, and the log.

Delta is time versus a reference lap at the same distance along the centerline. Positive is behind. It is only shown after the lap is armed.

GPS lock is green when the simulated fix has at least 8 satellites and HDOP under 2.0.

## Screens

| Screen | What it shows |
| --- | --- |
| Dash | Lap clock, predictive delta, best, last, speed, sector, sats, HDOP |
| Map | Car on the centerline, with the start/finish stripe and sector gates |
| IMU | G-meter plus accelerometer and gyro readouts. Live only in V2 |
| Laps | Closed laps, with sector splits when the lap recorded them |
| Log | Session CSV, same idea as a V1 MicroSD file |
| Build | V1 parts list and the V1 → V1.5 → V2 spend order |

**V1 timer** is the GPS lap timer and lands you on the dash. **V2 telemetry** turns the IMU board on and opens that screen. With V2 off, the G-meter sits at zero and the label reads “IMU off”.

## Tracks

All three are closed loops, driven counterclockwise from the stripe.

| Track | Character | Sectors | Reference lap |
| --- | --- | --- | --- |
| Club Circuit | Practice loop, about 2.4 km | Start straight, Hairpin complex, Back straight | 78.4 s |
| Marina Street | Technical street course | Promenade, Chicane, Harbor, Pit exit | 92.6 s |
| Pacific Ring | High-speed | Main straight, Esses, Final corner | 64.2 s |

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

| Stage | Budget | Job |
| --- | --- | --- |
| V1 | $85–100 | GPS lap timer. Prove detection, the display, and logging |
| V1.5 | $120–160 | Better power, antenna, IMU, and mounts |
| V2 | $160–200 | IMU, live delta, sectors, braking and corner story |

Run a real V1 lap before spending the next dollars. The extra money goes to GNSS, IMU, and power, not a bigger screen.

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
```

Stack: Vite, TanStack Start, React 19, Tailwind 4. Timer state lives in `src/lib/timer` (Zustand store, lap engine, track geometry). The screens are in `src/components/timer/AppShell.tsx`.
