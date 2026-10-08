# Drag mode — 0-100 km/h, 60 ft, 1/8 and 1/4 mile

Apex Chrono times acceleration runs as well as laps. The two run **side by side on every fix**: drag timing needs no track, and neither engine can affect the other.

**Status:** software only. The engine is parity-tested (TypeScript ↔ C++) and checked against simulated data. **It has not been run in a car.** The accuracy figures in §4 come from simulation; §6 is how they get confirmed on hardware.

## 1. What it measures

| Result         | Default target                                               | Notes                                                     |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Speed times    | 0-60, 0-96.56 (60 mph), 0-100, 0-150, 0-200 km/h             | from standstill                                           |
| Distance times | 60 ft (18.288 m), 1/8 mile (201.168 m), 1/4 mile (402.336 m) | plus trap speed at each                                   |
| Range          | 100-200 km/h                                                 | from the same run                                         |
| Run summary    | peak speed, distance, slope                                  | slope = altitude change over the longest distance reached |

Every target is configurable (`DragConfig` in `src/lib/gnss/drag.ts` and `firmware/lib/apex_drag/DragEngine.h`, up to 8 speed and 8 distance targets).

## 2. Using it

1. Boot the device **without** sending a track. The display shows the drag view (once a track is loaded it switches to the lap view, and drag runs are still logged on serial).
2. With a GNSS lock, stop for **1 s** below 1.5 km/h. The status line turns to `DRAG READY - GO`.
3. Launch. The big line shows the running time, the next line the speed.
4. Lift or brake (speed 10 km/h below the run's peak) or stop: the run ends. The screen keeps the last run: `60FT`, `0-100` and `1/4` (or `1/8` if you lifted earlier) with trap speed. `X` / red = invalid run.
5. Stop again to re-arm.

Serial log (115200):

```
EVT,DRAG_ARMED,<t>
EVT,DRAG_LAUNCH,<t>,t0=<t0>
EVT,DRAG_SPEED,<t>,kmh=100.00,<seconds>
EVT,DRAG_DIST,<t>,m=402.336,<seconds>,trap_kmh=<kmh>
EVT,DRAG_RUN,<t>,<n>,valid|invalid,flags=..,end=..,0-60=..,0-60mph=..,0-100=..,0-150=..,0-200=..,60ft=..,1/8=..,1/4=..,trap_kmh=..,100-200=..,peak_kmh=..,dist_m=..,slope_pct=..
STAT,...,drag=idle|armed|running,drag_runs=<n>,...
```

The SD card records the same raw CSV as for laps. Replay it on the desktop — drag runs are listed after the lap sheet, no track needed:

```bash
npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV            # standing start
npm run replay:gps -- APEX_YYYYMMDD_HHMM.CSV --rollout  # 1 ft rollout, drag-strip convention
```

## 3. How it times

- **Input:** only the receiver's **Doppler speed** and the GNSS clock (plus altitude for the slope). Positions are not used: Doppler speed is roughly an order of magnitude more precise than position for this. A receiver that reports no speed never arms.
- **Arm:** good-quality fixes (≥ 6 satellites, HDOP ≤ 2.5) below 1.5 km/h for 1 s.
- **Launch (t0):** the first armed fix at ≥ 3 km/h opens a launch window, which runs to 12 km/h. t0 is where a least-squares line through those fixes hits zero speed. A shallow line is bounded by the weakest plausible launch (0.5 m/s²) and by the start of the standstill. A first moving fix above 20 km/h means the launch was missed (`late_launch`).
- **Between fixes:** speed is linear in time (constant acceleration). Distance is the trapezoid of the two Doppler speeds. Each target is interpolated _inside_ its interval, speed targets linearly and distance targets by solving `d = dp + vp·τ + a·τ²/2`. This is exact for constant acceleration at any fix rate.
- **Rollout (optional):** with `--rollout` (or `rolloutM = 0.3048`), times count from the instant the car has covered 1 ft, as on a drag strip, instead of from t0.
- **End:** speed 10 km/h below the peak (lift/brake), a stop, or 60 s.
- **Validity:** a GNSS gap over 0.25 s ends the run as invalid (`gap`); missing speed ends it (`no_speed`); a fix with < 6 satellites or HDOP > 2.5 marks it invalid (`quality`). Targets not reached are left empty. They are never extrapolated.

## 4. Simulated accuracy

200 simulated runs per rate (`src/lib/gnss/drag-sim.ts`): 220 kW / 1450 kg car, gear changes, 0.18 km/h (1 σ) Gaussian Doppler noise, speed rounded to 0.01 km/h as the SD log stores it. Error = engine − truth, in seconds.

| Target   | 10 Hz σ / max | 25 Hz σ / max |
| -------- | ------------- | ------------- |
| 0-60     | 0.008 / 0.021 | 0.007 / 0.019 |
| 0-100    | 0.010 / 0.029 | 0.008 / 0.026 |
| 0-200    | 0.020 / 0.067 | 0.021 / 0.071 |
| 60 ft    | 0.003 / 0.013 | 0.004 / 0.011 |
| 1/4 mile | 0.004 / 0.014 | 0.005 / 0.012 |

What the table says, and what it doesn't:

- In this model 25 Hz is **not** measurably better than 10 Hz. Interpolation inside the interval removes most of the sampling error, so what's left is speed noise divided by acceleration. That is why 0-200 (low acceleration) is the noisiest result.
- The model does **not** include multipath, antenna placement, the receiver's internal speed filter and its latency, or launch jerk (clutch, wheelspin). These are what usually separate receivers in practice, and only the physical test in §6 measures them.
- The CI test (`npm run test:timer`) holds the budget at 0.1 s worst for speed targets and 0.03 s for distance targets over 8 seeds per rate.

## 5. Compared with a commercial 25 Hz unit (e.g. Dragy Pro)

|                | Commercial 25 Hz unit | Apex Chrono V1.5                    |
| -------------- | --------------------- | ----------------------------------- |
| Fix rate       | up to 25 Hz           | 10 Hz (BN-880Q, M8-class)           |
| Results        | drag + 0-100 + ranges | same set, configurable              |
| Display        | phone app             | on-device ST7789 + serial           |
| Laps / sectors | —                     | yes, at the same time               |
| Raw data       | vendor app            | open CSV on microSD, desktop replay |
| Field-proven   | yes                   | **not yet** (§6)                    |

The receiver could move to a 25 Hz u-blox M10-class module without changing the engine. Do that only if §6 shows the receiver itself is the limit.

## 6. Physical validation (closed course or drag strip only)

Run these after the V1.5 procedure (`docs/V1_5_TEST_PROCEDURE.md`) steps 1–10 pass. **Never on a public road.**

| Step | Do                                                                                   | PASS                                                                                                |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| D1   | Parked with lock, 60 s                                                               | `EVT,DRAG_ARMED` within 2 s of the stop. No `DRAG_LAUNCH` while parked (no false launch from noise) |
| D2   | Roll at walking pace without stopping first                                          | no run (needs a stop to arm)                                                                        |
| D3   | 5 launches to ≥ 110 km/h on a flat, straight section                                 | 5 `DRAG_RUN ... valid`; desktop replay of the SD file gives the same times within 0.002 s           |
| D4   | Drag strip: ≥ 5 passes with timeslips. Replay with `--rollout`                       | 1/4 mile ET within ±0.05 s and trap within ±2 km/h of the timeslip, 60 ft within ±0.03 s            |
| D5   | If a reference GNSS meter is available (Dragy, VBOX), mount both and do ≥ 5 launches | 0-100 within ±0.05 s, mean difference (bias) within ±0.02 s                                         |

Record the slope (`slope_pct`) for every run. A run on a grade over 1 % is not comparable with a flat one, and timeslip comparisons need the same direction of travel.

## 7. Code

| Where                                 | What                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `src/lib/gnss/drag.ts`                | Reference engine                                      |
| `src/lib/gnss/drag-sim.ts`            | Run simulator with ground truth                       |
| `src/lib/gnss/__tests__/drag.test.ts` | Exactness, arming/validity, accuracy budget           |
| `firmware/lib/apex_drag/DragEngine.h` | C++ port (no heap, fixed arrays)                      |
| `firmware/lib/apex_drag/DragView.h`   | Engine → display status                               |
| `firmware/test_host/drag_parity.cpp`  | Every run and event equal to TS within 1e-9 s         |
| `firmware/test_host/hw_test.cpp`      | Drag view text, layout, and view over the real engine |
