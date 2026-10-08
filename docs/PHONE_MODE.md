# Phone mode

`/phone` in the cockpit uses the phone's own GPS and motion sensors with the **same engines** the device runs: drag (`drag.ts`) and laps (`lap-engine.ts`). Nothing is installed: open the published site on the phone, tap **Start sensors**, and allow precise location.

It is a quick way to try the timing in a car before the hardware exists. It is **not** a replacement for the 10 Hz receiver, and the screen says so with numbers.

## What the phone gives, and what it doesn't

|                   | Device (BN-880Q) | Phone browser                                                              |
| ----------------- | ---------------- | -------------------------------------------------------------------------- |
| GPS rate          | 10 Hz            | whatever the phone delivers. Often ~1 Hz; measured and shown live          |
| Doppler speed     | yes              | usually, once moving; the screen warns if missing                          |
| Satellites / HDOP | yes              | **no**. The `hdop` column carries the browser's accuracy in metres instead |
| Motion sensors    | BMI270, 100 Hz   | accelerometer + gyro, typically ~60 Hz (logged, not used for timing)       |

Quality gate in phone mode: accuracy ≤ 10 m instead of ≥ 6 satellites and HDOP ≤ 2.5. The drag gap limit is 2.5 × the measured fix interval (0.25 s at 10 Hz, 2.5 s at 1 Hz). The drag engine is configured after the first 10 fixes, once the rate is known, and then replays those fixes.

At low rates the engines' own rules apply. A 1 Hz launch is flagged `late_launch` (invalid) because the car is already above 20 km/h at the first moving fix. The results are still shown, marked invalid. In one simulated run a 1 Hz phone read 0-100 in 3.87 s against 3.70 s at 10 Hz. Lap times at 1 Hz interpolate over ~28 m at 100 km/h.

## Using it

1. Mount the phone with a clear sky view. Keep the screen on (the page holds a wake lock while recording).
2. **Start sensors**. Wait for the GPS card to show the rate and `ok` accuracy.
3. Drag: stop for 1 s → `READY — GO` → launch. Laps: **Load .track** (the same file the device uses), then drive.
4. **Stop**, then **GPS CSV** and **IMU CSV** to save the session.

Replay on the desktop. The CSV metadata (`# source=phone`, `# max_accuracy_m`, `# drag_max_gap_s`) makes `replay:gps` use the phone settings, so drag results are identical to what the phone showed:

```bash
npm run replay:gps -- APEX_PHONE_YYYYMMDD_HHMM.CSV --track-file my-circuit.track
```

Requirements: HTTPS (the published site; `localhost` also works for development). On iPhone, motion sensors ask for permission when you tap Start.

## Code

| Where                                  | What                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/lib/gnss/phone.ts`                | Geolocation/DeviceMotion → contract rows, rate meter, `PhoneSession`, CSV export, replay options |
| `src/lib/gnss/__tests__/phone.test.ts` | Adapter, duplicates, rate, 10 Hz and 1 Hz drag, accuracy gate, laps equal to device replay       |
| `src/components/phone/PhoneScreen.tsx` | The screen                                                                                       |
| `src/routes/phone.tsx`                 | Route (client-only)                                                                              |
