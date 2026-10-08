# Apex Chrono V1.5 — ESP32-S3 hardware layer (Tasks 3–4)

Target hardware for the first physical prototype:

- **MCU**: ESP32-S3-DevKitC-1 **N32R16V** — module ESP32-S3-WROOM-2-N32R16V: 32 MB **Octal** flash, 16 MB Octal PSRAM, VDD_SPI 1.8 V
- **GNSS**: BN-880Q, 10 Hz, UART/NMEA
- **Display**: ST7789 2" SPI TFT
- **Storage**: microSD, SPI
- **IMU**: BMI270, I2C

Task 3 added the firmware's hardware abstraction layer: clean interfaces for GNSS, Storage, Display, IMU and Timer, one authoritative pin map, GNSS UART handling with hardware timestamps, and SD logging using the Task 2 raw CSV contract. Task 4 added the minimum V1.5 display (§5) and BMI270 IMU (§6) functionality. `firmware/lib/apex_timing/apex_timing.h` (the timing engine) is **unchanged** in both — this is wiring and observers, not timing logic. The browser cockpit (`src/`) is unchanged.

## 1. Pin map (authoritative)

Single source of truth: **`firmware/include/pins.h`**. Every driver takes its pins from there; no other file hardcodes a GPIO number.

| Peripheral                                              | Signal            | GPIO                                        |
| ------------------------------------------------------- | ----------------- | ------------------------------------------- |
| GNSS (BN-880Q), UART1                                   | RX1 ← module TX   | 18                                          |
|                                                         | TX1 → module RX   | 17                                          |
| Storage (microSD), dedicated SPI (FSPI/SPI2)            | SCLK              | 12                                          |
|                                                         | MOSI              | 11                                          |
|                                                         | MISO              | 13                                          |
|                                                         | CS                | 10                                          |
| Display (ST7789), dedicated SPI (HSPI/SPI3), write-only | SCLK              | 6                                           |
|                                                         | MOSI              | 7                                           |
|                                                         | CS                | 5                                           |
|                                                         | DC                | 4                                           |
|                                                         | RST               | 2                                           |
|                                                         | Backlight enable  | 1                                           |
| IMU (BMI270), I2C                                       | SDA               | 8                                           |
|                                                         | SCL               | 9                                           |
|                                                         | INT1 (data-ready) | 21 — wired, **unused** in V1.5 (poll-based) |

Spare / expansion, not wired by V1.5 firmware: **14, 15, 16, 39, 40, 41, 42** — free for a start button, buzzer, a future GNSS PPS input, CAN, etc. (GPIO 47 was listed as spare in Task 3; on the WROOM-2 module it is 1.8 V I/O, so it is now reserved.)

GNSS and storage/display are on **separate dedicated SPI buses** on purpose (storage is not SPI at all — it's a UART; display and storage each get their own hardware SPI peripheral, FSPI vs HSPI). For a first physical prototype this removes bus-sharing/CS-timing bugs as a bring-up variable; sharing one SPI bus between SD and the display is a safe later optimization once the board is proven.

### Reserved / do-not-use GPIOs on this exact module

| Range        | Reason                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0, 3, 45, 46 | Strapping pins: BOOT mode / BOOT button (0), JTAG select (3), VDD_SPI voltage select (45), ROM log verbosity (46, input-only)                          |
| 19, 20       | Native USB D-/D+, wired to the onboard "USB" connector                                                                                                 |
| 26–32        | SPI flash/PSRAM bus — reserved on **every** ESP32-S3 module with embedded flash, any size                                                              |
| 33–37        | Upper octal data lines + DQS — used by the WROOM-2's Octal flash and Octal PSRAM; not broken out on this module                                        |
| 47           | 1.8 V I/O on WROOM-2 (VDD_SPI = 1.8 V also supplies GPIO47/48) — not usable as a 3.3 V spare                                                           |
| 38, 48       | Onboard addressable RGB LED — board-revision dependent position (GPIO38 on DevKitC-1 v1.1, GPIO48 on v1.0); both reserved so the map is revision-proof |
| 43, 44       | UART0 TX/RX — the onboard USB-UART bridge, used as the debug/console `Serial` port                                                                     |

GPIO 22–25 do not exist on the ESP32-S3 chip at all (not a board limitation — they are simply absent from the pin numbering).

### Pin-conflict verification

`firmware/include/pins.h` ends with two `constexpr` functions and two `static_assert`s:

- `hasDuplicate()` — fails the build if any two assigned peripheral pins are the same number.
- `anyReserved()` — fails the build if any assigned peripheral pin falls in the reserved table above.

This was **exercised, not just written**: as part of this task I temporarily set `TFT_CS = SD_CS` (10) and rebuilt — the duplicate-pin `static_assert` fired and failed the build with the exact message `pin map: two peripherals share a GPIO`. I then temporarily set `TFT_RST = 26` (inside the SPI-flash reserved range) and rebuilt — the reserved-pin `static_assert` fired with `pin map: a peripheral pin collides with a reserved/strapping/flash/PSRAM/USB/UART0/LED pin`. Both edits were reverted before the real build; the committed pin map compiles clean. Any future change that introduces a conflict will fail `pio run`, not pass code review silently.

## 2. Architecture — clean interface separation

```
┌──────────────┐   contract row (ContractRow)   ┌──────────────┐
│  GnssDriver  │───────────────┬────────────────▶│   SdLogger   │  (observer,
│ (UART1, NMEA)│               │                 │ (microSD)    │   never gates
└──────┬───────┘               │                 └──────────────┘   timing)
       │ apex::GnssFix         │
       ▼                       │
┌──────────────┐               │
│ TimerService │◀──────────────┘ (same row also feeds the engine)
│ Track+LapEngine (apex_timing.h, UNCHANGED/frozen)
└──────┬───────┘
       │ events / live state (existing public LapEngine API — no engine changes)
       ▼
┌──────────────┐        ┌──────────────┐
│   Display    │        │     Imu      │  (independent, best-effort,
│ (ST7789)     │        │  (BMI270)    │   never read by the timer)
└──────────────┘        └──────────────┘
```

| Interface       | Location                                                       | Owns                                                                                                                                           |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GNSS            | `firmware/lib/apex_gnss/GnssDriver.{h,cpp}`                    | HardwareSerial(1), TinyGPSPlus, u-blox UBX config, contract-row + `apex::GnssFix` production                                                   |
| Storage         | `firmware/lib/apex_storage/SdLogger.{h,cpp}`                   | microSD, session file lifecycle, contract CSV writing                                                                                          |
| Display         | `firmware/lib/apex_display/Display.{h,cpp}`, `DisplayModel.h`  | ST7789 320×240 status panel; `DisplayModel.h` = what is shown (pure, host-tested), `Display.cpp` = partial-redraw painter                      |
| IMU             | `firmware/lib/apex_imu/Imu.{h,cpp}`, `ImuCore.h`               | BMI270 via Bosch Sensor API; `ImuCore.h` = states, comm test, conversion, timestamps, `ImuSink` (pure, host-tested)                            |
| Timer           | `firmware/lib/apex_timer/TimerService.{h,cpp}`, `TimingView.h` | `apex::Track` + `apex::LapEngine` orchestration, track-file parsing; `TimingView.h` = read-only engine → display status (incl. current sector) |
| Shared contract | `firmware/lib/apex_contract/GnssContractRow.h`                 | `ContractRow`/`SessionDate` POD + `formatContractRow()` — the C++ mirror of `src/lib/gnss/recording.ts`                                        |

`main.cpp` is a thin orchestrator: it owns one instance of each module and wires `GnssDriver.poll()` → `SdLogger.logRow()` (observer) and → `TimerService.pushFix()` (critical path). After the fixes available in that loop iteration are timed, it runs the observers: `Imu.poll()` (self-throttled to half the 100 Hz ODR), `Display.show()` (5 Hz) and a 1 Hz `STAT` serial line. No module reaches into another's internals; `TimerService` is the only thing that touches `apex::LapEngine`, and `TimingView.h` only reads it.

**No changes to `apex_timing.h`.** The status panel's needs (phase, current lap, lap time, last lap, best lap) are exposed by `LapEngine`'s existing public API (`inLapNow()`, `currentLapNumber()`, `lapStartTime()`, `lastLap()`, `bestLap`/`haveBest`). The one thing it keeps private is the next expected gate, needed for "current sector"; `TimingView.h`'s `SectorTracker` mirrors it exactly from the engine's own `LapStart`/`Sector` events (the only places the engine changes it), so the frozen, host-parity-tested engine file still has zero diff.

## 3. GNSS UART handling and hardware timestamps

`GnssDriver` owns `HardwareSerial(1)` at 115200-8N1 (configured from the BN-880Q's 9600 default via UBX `CFG-PRT`/`CFG-RATE`/`CFG-MSG`, same u-blox sequence as the V1 firmware, now isolated behind the driver instead of living in `main.cpp`).

Two distinct "timestamps", per the contract (`docs/GNSS_DATA_CONTRACT.md` §1/§3):

- **Authoritative clock** — `GnssFix.t` / `ContractRow.timestampMs` come from the receiver's own UTC time-of-fix (NMEA `hh:mm:ss.cc`), decoded on the hardware UART. This is the only clock the timing engine or a replay ever sees. Never `millis()`.
- **Diagnostic hardware timestamp** — `ContractRow.mcuMs` is the ESP32's hardware `millis()` counter, captured at the exact instant the UART finished decoding the sentence that completed a fix. It measures receiver-to-MCU/logger latency and is explicitly never read by the timing engine (contract §1 says so; `TimerService`/`LapEngine` never see it).

### Fix quality fix (resolves `V1_5_ARCHITECTURE.md` blocker B5)

The V1 firmware hardcoded `fixType = 3` whenever a location was valid, so the quality filter's `no_fix` rejection could never trigger on real hardware. `GnssDriver` now reads the real value: `TinyGPSLocation::FixQuality()` parses NMEA GGA field 6 directly (`0`=invalid … `8`=simulated). The raw contract row's `fix_quality` carries that real value; the engine-facing `fixType` applies the contract §2 adapter exactly (`fix_quality <= 0` → `0`/no-fix, `>= 1` → `3`, since GGA alone can't distinguish 2D from 3D). B5 is resolved on the TS-contract side; `docs/V1_5_ARCHITECTURE.md` is updated accordingly.

## 4. SD logging (Task 2 contract, byte-compatible)

`SdLogger` writes the exact contract §6 format: `# apex-chrono gnss v1` / `# firmware=v1.5` / `# receiver=BN-880Q` / (`# date=YYYY-MM-DD` once known) / the fixed header row, then one row per accepted fix via `formatContractRow()` — the same fixed precision as `recording.ts`'s `formatRow()` (`timestamp_ms` integer; lat/lon 8dp; `speed_kmh` 2dp; `heading_deg` 1dp; `hdop` 2dp; `altitude_m` 1dp; empty = not reported).

- **File naming**: `APEX_YYYYMMDD_HHMM.CSV` (contract §6) once the GNSS date is known (RMC typically carries date+time together, so this is normally the very first row); falls back to `APEX_NODATE_<millis>.CSV` if a date genuinely isn't available yet — documented, honest, and never blocks logging waiting for one. Collisions are resolved with `_2`, `_3`, … suffixes, same as the contract recommends.
- **File opening is lazy**: the first `logRow()` call opens the file (so it can be named from a real timestamp); this defers creation by at most one fix period (~100 ms) — a deliberate, documented trade-off.
- **Chunked, periodic flush**: `file_.flush()` every 20 rows (2 s at 10 Hz), to bound both write latency and wear without risking large unflushed buffers on a sudden power loss.
- **Failure handling**: every `write()` return value is checked. A short/failed write increments a cumulative `failures` counter and a _consecutive_ counter; after `kFailBeforeStop` (10) consecutive failures the logger gives up for the rest of the session (closes the file, stops retrying every row) — this only turns storage off, nothing else.

### "SD failure must not stop timing" — how this is actually true here

`main.cpp`'s loop calls `sd.logRow(row, date)` **before** `timer.pushFix(fix, ev)`, but `SdLogger` is a value-less observer: `logRow()` returns `void`, nothing about its outcome is inspected by the caller, and every I/O path inside it (`SD.begin()` failing, `SD.open()` failing, `file_.write()` returning short) is checked and absorbed internally rather than retried in a loop or blocked on. A missing card never even opens a file (`cardPresent_` stays false and `logRow()` becomes a single boolean check-and-return). A card that fails mid-session gives up after 10 consecutive failures and goes quiet. In both cases `timer.pushFix()` on the next line is reached unconditionally, every loop iteration, regardless of what `sd.logRow()` just did.

## 5. Display (Task 4) — ST7789 2", 320×240

The panel is initialised in its native portrait 240×320 and rotated to landscape (`kRotation = 1`; use 3 if it reads upside down in the enclosure). Classic 6×8 font, scaled.

| y (px) | Size | Example                                | Field                         |
| ------ | ---- | -------------------------------------- | ----------------------------- |
| 4      | 2    | `FIX    SAT 12 HDOP 0.8`               | GNSS lock · satellites · HDOP |
| 26     | 2    | `TIMING`                               | Timing status                 |
| 52     | 5    | `1:23.4`                               | Lap time (current lap, live)  |
| 100    | 3    | `LAP 4        S2/3`                    | Current lap · sector          |
| 130    | 3    | `LAST 1:23.456` (`X` + red if invalid) | Last lap                      |
| 162    | 2    | `BEST 1:22.901`                        | Best lap (extra)              |
| 190    | 2    | `SD LOG 1234`                          | SD status                     |
| 214    | 2    | `IMU OK 100HZ`                         | IMU status (extra)            |

Definitions:

- **GNSS lock**: newest fix has GGA quality ≥ 1 (contract `fixType` ≥ 2) and is not older than 2 s of MCU time. A receiver that goes quiet shows `NO FIX` within 2 s.
- **Timing status**: `NO TRACK LOADED` (no track sent yet, fixes are logged but not timed) → `WAITING GNSS LOCK` → `READY - CROSS START` (locked, no lap running yet) → `TIMING` (a lap is running).
- **Sector**: 1-based sector of the running lap, shown only while timing and only when the track has sector lines. With _n_ gates (start/finish + *n*−1 sector lines) there are _n_ sectors.
- **SD status**: `SD NO CARD` (mount failed at boot) · `SD READY` (mounted, file opens on the first fix) · `SD LOG <rows>` (`ERR <n>` added and red after any failed write) · `SD FAILED` (gave up after 10 consecutive failures).

What is shown is decided in `DisplayModel.h` — pure C++, no Arduino — and checked by `firmware/test_host/hw_test.cpp`: exact text for every field, worst-case values still fit their line width, and no two lines overlap on 320×240. `Display.cpp` only paints.

### Rendering cost and why the GNSS UART buffer grew

The Task 3 panel cleared the whole screen (320×240×2 B ≈ 150 KB of SPI) on every 5 Hz refresh. At typical SPI clocks that is tens of milliseconds per frame, during which the 256-byte default UART RX buffer (≈170 ms of GGA+RMC at 10 Hz) fills. Task 4:

- clears the screen once at boot; after that each refresh repaints **only lines whose text or colour changed**, drawing glyphs with a background colour and padding to line width (no flicker, no full clear). In practice that is the lap-time line every frame plus an occasional other line.
- sets the panel SPI clock to 40 MHz (`kSpiHz` in `Display.cpp`; drop to 27 MHz if long jumper wires show noise).
- measures every refresh: `disp_us` / `disp_max_us` in the 1 Hz `STAT` line, so the physical test can confirm the budget.
- raises the GNSS UART RX buffer to 4 KB (`kRxBufferBytes` in `GnssDriver.cpp`, ≈2.7 s of NMEA). Fix timestamps come from the receiver, so a late loop iteration costs nothing in accuracy as long as bytes aren't dropped.

### Failure behaviour

The ST7789 link is write-only (no MISO), so a missing or dead panel cannot be detected electrically; SPI writes to nothing still complete in bounded time. `Display` runs after timing work, its return value is only a duration for diagnostics, and nothing reads it. Worst case is "no picture", never "no timing" — to be confirmed physically with the panel unplugged (test procedure §8).

## 6. IMU (Task 4) — BMI270 initialisation, communication test, samples

### Initialisation

The BMI270 needs Bosch's ~8 KB config file uploaded before its accelerometer and gyroscope outputs mean anything. Task 3 deliberately did not hand-type that blob. Task 4 uses **Bosch's own BMI270 Sensor API (v2.86.1, BSD-3)**, which carries the config file, as shipped inside the `sparkfun/SparkFun BMI270 Arduino Library` package (`platformio.ini`). Only the Bosch C API is called; SparkFun's C++ wrapper is not used because its I2C read ignores short reads. `Imu.cpp` provides its own I2C callbacks that reject a short read instead of passing partial data on.

Sequence (`Bmi270Backend::init`):

1. I2C at 400 kHz, 10 ms bus timeout (a missing chip costs milliseconds, not a hang).
2. Probe `CHIP_ID` (reg `0x00`) at `0x68`, then `0x69`. Nothing answers → **not found**. Answer ≠ `0x24` → **wrong chip**.
3. `bmi270_init()`: soft reset, config file upload, `INTERNAL_STATUS` check.
4. Accelerometer: 100 Hz, ±8 g, normal/avg4, performance mode. Gyroscope: 100 Hz, ±500 °/s, normal mode, performance filter.
5. Enable both sensors. Any Bosch API error in 3–5 → **init failed** (code printed as `bosch=` on the `IMU,` boot line).

### Communication test

`CHIP_ID` only proves something answers. After init, `ImuCore` reads 5 bursts, one ODR period apart, and passes only if: all 5 reads succeed, accel and gyro data-ready flags were seen, the chip's sensor time strictly advanced read to read, and at least one raw axis changed (a live MEMS always has noise; a frozen register file does not). It also reports |a| in g; 0.7–1.3 g sets `gravity_ok=1` but never fails the test (the board may not be still at power-up). Result on serial at boot:

```
IMU,state=running,addr=0x68,chip=0x24,bosch=0,comm_reads=5,fresh_acc=5,fresh_gyr=5,time_adv=1,not_stuck=1,mag_g=1.002,gravity_ok=1,acc_range_g=8,gyr_range_dps=500,odr_hz=100
```

### Samples and timestamps

`ImuSample`: acceleration in m/s² (x, y, z), angular rate in °/s (x, y, z), in the **chip's own axis frame** (no mounting remap in V1.5), plus:

- `mcuUs` — ESP32 `esp_timer` microseconds when the read completed. Same clock as `millis()`, i.e. the GNSS rows' `mcu_ms`, so a future logger can line IMU samples up with GNSS fixes.
- `sensorTimeUs` — the BMI270's own 24-bit `SENSORTIME` (39.0625 µs/tick, wraps every ≈655 s), unwrapped to 64 bits so it is monotonic for the whole session.
- `seq`, and data-ready flags per sensor.

The main loop polls at most twice per ODR period and keeps a sample only when the data-ready flags say it is new, so the effective rate is the 100 Hz ODR (reported as `imu_hz` in `STAT` and on the display).

### Interface for future logging

`ImuSink` (one virtual `onImuSample()`), set with `imu.setSink(...)`. `ImuRing<N>` is a ready overwrite-oldest ring implementing it, with a drop counter, for a future SD writer to drain in batches. V1.5 does **not** write IMU data to SD: the on-card format is a V2 decision and is not invented here.

### Failure behaviour

States: `not_found`, `wrong_chip`, `init_failed`, `comm_test_failed` (all at boot: IMU stays off, display `IMU --`), `running`, and `failed` (10 consecutive read errors during the session: display `IMU FAILED`, and the bus is never touched again). Nothing in the timing path reads IMU data.

### Not in V1.5 (by request)

No sensor fusion, orientation, calibration, mounting-axis remap, g-force display or telemetry analysis. INT1 (GPIO 21) stays wired and unused; reading is polled.

## 7. The N32R16V board configuration (corrected in Task 5)

PlatformIO's `esp32-s3-devkitc-1` board definition is the plain **N8** variant (8 MB Quad flash, no PSRAM) — there is no bundled N32R16V entry, so `firmware/platformio.ini` overrides what differs:

```ini
board_build.arduino.memory_type = opi_opi
board_build.flash_mode = opi
board_build.psram_type = opi
board_upload.flash_size = 32MB
```

**Why `opi_opi`.** N32R16V is the ESP32-S3-**WROOM-2** module. Espressif's ESP32-S3-WROOM-2 datasheet lists `ESP32-S3-WROOM-2-N32R16V` as 32 MB **Octal SPI** flash + 16 MB Octal SPI PSRAM, with VDD_SPI fixed at 1.8 V by eFuse. Task 3 configured `qio` flash (deriving `qio_opi`), which matches no 32 MB ESP32-S3 module (the Quad-flash WROOM-1 family stops at 16 MB). A Quad-mode image on Octal flash is expected not to boot, so this was corrected before the first power-up; the configuration matches the community-verified one for the sibling N32R8V module. **Unverified until the board boots** — test procedure §3 checks it first, and the boot log must show the PSRAM size.

The partition table is left at the board default (8 MB layout). The app is ~0.44 MB of a ~3.3 MB app partition; a 32 MB table is an open item for OTA.

## 8. Build, verification and results

### Task 4 (display + IMU)

Firmware compile — real `pio run`, on GitHub Actions (`.github/workflows/firmware.yml`, added in Task 4; this sandbox's network blocks the PlatformIO registry, so the build runs in CI on every push touching `firmware/`). Values from the run's annotations:

```
PLATFORM: Espressif 32 (7.1.3), framework-arduinoespressif32 @ 4.20017 (Arduino core 2.0.17), toolchain-xtensa-esp32s3 @ 8.4.0
Libraries: TinyGPSPlus 1.1.0, Adafruit GFX 1.12.6, Adafruit BusIO 1.17.4, Adafruit ST7735/ST7789 1.11.0, SparkFun BMI270 1.0.3
RAM:   51.6% (169,164 / 327,680 B)     Flash: 13.1% (439,481 / 3,342,336 B)
compiler warnings: 0
```

Task 3 → Task 4 cost: +632 B RAM, +19.4 KB flash (Bosch API + config file, display model).

Host tests (`npm run firmware:test`, also in CI):

```
PASS club_3m_doppler / street_1m5_position_only / fast_10m_degraded   max |C++ − TS| = 0 s   (engine untouched)
PASS hw_test: 146 checks, 0 failed
```

`hw_test` (`firmware/test_host/hw_test.cpp`) covers: lap-time formatting and rounding; the exact text of every display field in boot, waiting, ready, timing, SD-error/failed and IMU-failed states; worst-case values fit each line and no lines overlap on 320×240; `TimingView` over the **real** `LapEngine` replaying the `club_3m_doppler` fixture (status transitions, sectors only step forward 1→2→3 within a lap and cover all sectors, last lap matches the engine on every `Lap` event, stale GNSS → no lock); IMU with a scripted mock BMI270 — not found / wrong chip / init failed / stuck data / frozen sensor time / no data-ready / bus error during the comm test, happy path with exact unit conversion (1 g → 9.80665 m/s², 655 LSB → 9.995 °/s at ±500 °/s), poll throttling, sample sequence, 10 ms sensor-time spacing, 24-bit sensor-time wrap, give-up after 10 consecutive bus errors (and no bus access afterwards), `ImuRing` order and overflow. Two injected bugs (wrong sector arithmetic; give-up threshold +5) were each caught by the suite before being reverted.

Web app (cockpit unchanged):

```
npm run typecheck   → clean
npm run test:timer  → 80/80
npm run build       → clean
npm test            → 197 total, 182 pass, 15 fail
```

The 15 failures are the pre-existing template `scripts/` tests. They fail because `.grok/` (gitignored, never committed) and `public/__grok/` are absent from the repository, not because of firmware or `src/` code; Task 4 changes neither `scripts/` nor `src/`. Because `npm test` chains with `&&`, those failures stop it before the app-data/auth suites; those were run directly: 55/55 pass.

### Task 3 (hardware layer), for reference

`pio run` on the VPS (PlatformIO 6.2.0, `espressif32` 7.1.3): RAM 51.4% (168,532 B), Flash 12.6% (420,057 B). `npm run firmware:test` 3/3, `typecheck` clean, `test:timer` 80/80, `build` clean, `npm test` 182/197 (same 15).

## 9. Unresolved issues / open items

- **No physical hardware has been tested.** Everything here is verified by compilation, host tests and code review against datasheets and vendor sources. The first physical tests are in `docs/V1_5_TEST_PROCEDURE.md`.
- **Display**: panel size assumed 240×320 native (common 2" ST7789); 40 MHz SPI and the partial-redraw timing (`disp_us`) are unmeasured on real hardware; rotation may need 3 instead of 1 for the enclosure; no electrical detection of a missing panel (write-only link).
- **IMU**: axes are the chip's own frame — no mounting remap or calibration; the comm test assumes nothing about orientation; IMU samples are not written to SD in V1.5 (`ImuSink` is the hook, format is a V2 decision); INT1 unused; the Bosch API comes from the SparkFun package (pinned `^1.0.3`, Bosch API v2.86.1).
- **GNSS lock** on the display is GGA quality ≥ 1 and a fix newer than 2 s; it does not show 2D vs 3D (GGA cannot tell, see §3).
- A truly hung SPI or I2C peripheral is bounded by the I2C 10 ms timeout and by SPI being master-driven, but there is no hardware watchdog/reset design.
- **Partition table is still `default_8MB.csv`** on a 32 MB flash chip (§7) — fine for this firmware's size; revisit for OTA.
- **`mcu_ms` wraps after ~24.8 days of uptime** (signed 32-bit). IMU `mcuUs` is 64-bit and does not.
- **GNSS UBX configuration has no ACK verification** (pre-existing from V1). A receiver that ignores it stays at its old rate — the 10 Hz test in the procedure catches this.
- **Track loading is serial-only on the device** (pasted after every boot, terminated by `END`); no SD track loading yet.
