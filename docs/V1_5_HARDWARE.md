# Apex Chrono V1.5 — ESP32-S3 hardware layer (Task 3)

Target hardware for the first physical prototype:

- **MCU**: ESP32-S3-DevKitC-1 **N32R16V** (32 MB QIO flash, 16 MB Octal PSRAM)
- **GNSS**: BN-880Q, 10 Hz, UART/NMEA
- **Display**: ST7789 2" SPI TFT
- **Storage**: microSD, SPI
- **IMU**: BMI270, I2C

This task adds the firmware's hardware abstraction layer: clean interfaces for GNSS, Storage, Display, IMU and Timer, one authoritative pin map, GNSS UART handling with hardware timestamps, and SD logging using the Task 2 raw CSV contract. `firmware/lib/apex_timing/apex_timing.h` (the timing engine) is **unchanged** — this task is wiring, not timing logic.

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

Spare / expansion, not wired by V1.5 firmware: **14, 15, 16, 39, 40, 41, 42, 47** — free for a start button, buzzer, a future GNSS PPS input, CAN, etc.

GNSS and storage/display are on **separate dedicated SPI buses** on purpose (storage is not SPI at all — it's a UART; display and storage each get their own hardware SPI peripheral, FSPI vs HSPI). For a first physical prototype this removes bus-sharing/CS-timing bugs as a bring-up variable; sharing one SPI bus between SD and the display is a safe later optimization once the board is proven.

### Reserved / do-not-use GPIOs on this exact module

| Range        | Reason                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, 3, 45, 46 | Strapping pins: BOOT mode / BOOT button (0), JTAG select (3), VDD_SPI voltage select (45), ROM log verbosity (46, input-only)                            |
| 19, 20       | Native USB D-/D+, wired to the onboard "USB" connector                                                                                                   |
| 26–32        | Quad SPI flash — reserved on **every** ESP32-S3 module with embedded flash, any size                                                                     |
| 33–37        | Octal PSRAM — reserved **only because N32R16V uses Octal PSRAM** (16 MB is only available as Octal); not broken out to the header on this module variant |
| 38, 48       | Onboard addressable RGB LED — board-revision dependent position (GPIO38 on DevKitC-1 v1.1, GPIO48 on v1.0); both reserved so the map is revision-proof   |
| 43, 44       | UART0 TX/RX — the onboard USB-UART bridge, used as the debug/console `Serial` port                                                                       |

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

| Interface       | Location                                       | Owns                                                                                                    |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GNSS            | `firmware/lib/apex_gnss/GnssDriver.{h,cpp}`    | HardwareSerial(1), TinyGPSPlus, u-blox UBX config, contract-row + `apex::GnssFix` production            |
| Storage         | `firmware/lib/apex_storage/SdLogger.{h,cpp}`   | microSD, session file lifecycle, contract CSV writing                                                   |
| Display         | `firmware/lib/apex_display/Display.{h,cpp}`    | ST7789 init + a plain-text status panel                                                                 |
| IMU             | `firmware/lib/apex_imu/Imu.{h,cpp}`            | I2C wiring/presence check, raw register readback                                                        |
| Timer           | `firmware/lib/apex_timer/TimerService.{h,cpp}` | `apex::Track` + `apex::LapEngine` orchestration, track-file parsing                                     |
| Shared contract | `firmware/lib/apex_contract/GnssContractRow.h` | `ContractRow`/`SessionDate` POD + `formatContractRow()` — the C++ mirror of `src/lib/gnss/recording.ts` |

`main.cpp` is now a thin orchestrator: it owns one instance of each module and wires `GnssDriver.poll()` → `SdLogger.logRow()` (observer) and → `TimerService.pushFix()` (critical path), then separately throttles `Imu.readRaw()` (~20 Hz) and `Display.showStatus()` (~5 Hz). No module reaches into another's internals; `TimerService` is the only thing that touches `apex::LapEngine`.

**No changes to `apex_timing.h`.** The status panel's needs (phase, current lap, last lap, best lap, live delta) are all already exposed by `LapEngine`'s existing public API (`inLapNow()`, `currentLapNumber()`, `lapStartTime()`, `lastLap()`, `bestLap`/`haveBest`) — no new engine surface was required, so the frozen, host-parity-tested engine file has zero diff this task.

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

## 5. Display — minimum required functionality only

`Display` draws five plain-text lines (GNSS fix/sats/HDOP, lap number + elapsed, last lap + best lap, SD status, IMU status) at a throttled ~5 Hz. This is explicitly **not** a V2 telemetry dashboard — no track map, no graphics, no g-force gauges.

**Honest limitation**: the ST7789 wiring here is write-only (no MISO/readback), which is normal for these breakouts but means there is no reliable way to electrically prove the panel is present and responding before writing to it. `Display::begin()` therefore reports success optimistically once `init()` returns without hanging. The resilience guarantee this task actually provides is architectural, not electrical: `Display` is a stateless function of a status snapshot, called strictly after GNSS/storage/timer work for that loop iteration is already done, so even a fully dead or unplugged panel degrades to "no display," never to "no timing." This will be confirmed (or falsified) the first time real hardware is powered up with a deliberately disconnected panel — that physical test has not happened yet.

## 6. IMU — presence check only, not full bring-up (by design)

**This is the one place this task deliberately does less than a "complete" driver, and the reason is worth being explicit about.** The BMI270 requires Bosch's proprietary ~8 KB `config_file` binary blob to be uploaded over the bus before the accelerometer/gyroscope data registers produce characterized output — this is documented Bosch behaviour (the chip stays in a config/standby state otherwise), not a guess. That blob is **not** reproduced in this firmware: hand-transcribing ~8 KB of vendor binary from memory risks a silent transcription error, and a wrong blob can still "successfully" write and produce plausible-looking garbage instead of failing loudly — which is worse than reading nothing.

What `Imu` **does** implement and is real:

- I2C bring-up at the documented default pins (SDA 8, SCL 9), probing address `0x68` then `0x69` (BMI270's SDO-pin-selectable addresses)
- `CHIP_ID` register (`0x00`) readback, checked against the documented value `0x24`
- A soft reset (`CMD` register `0x7E` ← `0xB6`) followed by a post-reset `CHIP_ID` re-check
- Raw register readback (`readRaw()`) from the documented accelerometer/gyroscope data registers (`0x0C`–`0x17`), explicitly marked as uncharacterized diagnostic data, never consumed by any decision in this firmware

This is enough to prove the physical I2C wiring is correct on the real board — the actual goal of a "first physical prototype" bring-up — without fabricating sensor behaviour. Loading the real Bosch config blob (via a vetted driver, e.g. Bosch's own BMI270-Sensor-API) is deferred to whenever IMU data is actually consumed by a feature, which is V2 telemetry and out of scope here. **IMU failure (missing chip, wrong ID, I2C NACK) never stops timing**: `Imu::begin()` returning `false` just leaves it inert for the whole session; `main.cpp` only calls `readRaw()` when `imu.ok()` is true, and its result is discarded either way.

## 7. The N32R16V board configuration

PlatformIO's `esp32-s3-devkitc-1` board definition is the plain **N8** variant (8 MB flash, no PSRAM) — there is no bundled N32R16V entry. Rather than hand-writing a new board JSON, `firmware/platformio.ini` overrides the two settings that matter:

```ini
board_upload.flash_size = 32MB
board_build.psram_type = opi
```

The existing board's `flash_mode: qio` plus `psram_type: opi` makes the Arduino core derive `memory_type = qio_opi` (Quad-I/O flash + Octal-I/O PSRAM) — the correct mode for N32R16V, verified against `espressif32`'s own builder logic (`_get_board_memory_type()` in `~/.platformio/platforms/espressif32/builder/main.py`), not guessed.

The partition table is left at the board's default `default_8MB.csv`. This firmware's compiled app is ~420 KB (12.6% of the ~3.3 MB app partition it defines) — far short of needing the extra 24 MB this module actually has. A custom partition table sized for the full 32 MB is listed as an open item below, for whenever OTA or a much larger app needs it.

## 8. Build, verification and results

All commands below were actually run on this VPS (PlatformIO 6.2.0, `espressif32` 7.1.3, Node v22.22.2); the numbers are copied from the real output.

```
cd firmware && /opt/pio/bin/pio run
```

→ **SUCCESS**. `RAM: 51.4% (168532 / 327680 bytes)`, `Flash: 12.6% (420057 / 3342336 bytes)`.

```
npm run firmware:test
```

→ **3/3 PASS** (`club_3m_doppler`, `street_1m5_position_only`, `fast_10m_degraded`), max |C++ − TS| = 0 s on all three. `apex_timing.h` has zero diff this task, so this result is unsurprising but was still re-run to confirm the new firmware/ tree didn't somehow disturb it.

```
npm run typecheck   → clean
npm run test:timer  → 80/80
npm run build       → clean (vite + nitro)
npm test            → 197 total, 182 pass, 15 fail
```

The 15 failures are the pre-existing template `scripts/` tests, identical to `main` and to the V1.5 Task 2 commit — verified in Task 2 via `git worktree add` against `origin/main` and a line-for-line diff of the failing test names. Nothing in this task touches `src/lib/` or `scripts/`, so that result could not have changed and wasn't re-diffed here.

## 9. Unresolved issues / open items

- **No physical hardware has been tested.** Everything above is a from-the-datasheet/from-source design verified by compilation, the host parity test, and (for the pin map) two deliberately-injected-then-reverted compile failures. It has not been proven against a real BN-880Q, ST7789 panel, microSD card or BMI270 chip. The first real test is flashing this onto an actual ESP32-S3-DevKitC-1 N32R16V with the wiring above.
- **BMI270 does not produce characterized sensor data** — see §6. This is a deliberate scope decision, not a bug, but it means `imu.readRaw()` values are not meaningful yet.
- **Display panel resolution is assumed** (240×320, the common "2-inch" ST7789 module) — see §5. If the actual purchased panel differs, `kWidth`/`kHeight` in `Display.cpp` need updating; there's no way to auto-detect this over a write-only SPI link.
- **SD/display failure detection is architectural, not electrical**, for the display (§5) — a genuinely hung SPI transaction (e.g. a bad solder joint pulling a line stuck) is not something this firmware can recover from without a hardware watchdog + reset design, which is out of scope for a "minimum required" first prototype.
- **Partition table is still `default_8MB.csv`** on a 32 MB flash chip (§7) — fine for this firmware's size today; revisit if/when OTA or a much larger app is needed.
- **`mcu_ms` wraps after ~24.8 days of continuous uptime** (`millis()` overflow into the signed `int32_t` field) — acceptable for a lap-timer prototype (sessions are minutes/hours) and explicitly diagnostic-only, but worth knowing if a soak test runs that long.
- **GNSS UBX configuration has no success/failure verification** — `configureReceiver()` sends `CFG-PRT`/`CFG-RATE`/`CFG-MSG` but never reads back a UBX-ACK, so a misconfigured or non-responsive receiver silently stays at whatever rate/sentence set it already had. This was already true in the V1 firmware; it's noted here rather than fixed because receiver bring-up on fresh hardware will surface this immediately as "no 10 Hz data" and is easy to diagnose with a logic analyzer or passthrough monitor — fixing it would mean growing the UBX parser, not "minimum required functionality" for this task.
