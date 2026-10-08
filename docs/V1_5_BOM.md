# Apex Chrono V1.5 — prototype bill of materials

The hardware the V1.5 firmware (`firmware/`, pin map in `firmware/include/pins.h`) is written for, and that `docs/V1_5_TEST_PROCEDURE.md` validates. No prices or retailers: buy from any source, but **check the markings listed here on arrival** (procedure §1), because several of these parts are sold in look-alike variants that need a different configuration.

## 1. Core electronics

| #   | Part              | Required specification                                                                                                                                              | Qty | Must check on arrival                                                                                                                                                               |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MCU board         | ESP32-S3-DevKitC-1 with module **ESP32-S3-WROOM-2-N32R16V** (32 MB Octal flash, 16 MB Octal PSRAM, VDD_SPI 1.8 V). Two USB ports ("UART" and "USB").                | 1   | Metal can reads `ESP32-S3-WROOM-2` and `N32R16V`. Any other variant (N8, N16R8, N8R8 = WROOM-1, Quad flash) needs a different `platformio.ini` memory configuration and pin review. |
| 2   | GNSS receiver     | **BN-880Q** (u-blox M8-class, GPS+GLONASS/BeiDou, integrated ceramic patch antenna, UART NMEA, configurable to 10 Hz). Its compass (I2C SDA/SCL wires) is not used. | 1   | Label/marking BN-880Q. UART TX idle level must be ≤ 3.3 V before connecting to the ESP32 (procedure §2).                                                                            |
| 3   | Display           | **2.0" ST7789 SPI TFT, 240×320**, 3.3 V logic, pins VCC/GND/SCL/SDA/RES/DC/CS/BL (BL = backlight enable).                                                           | 1   | Resolution 240×320. 240×240 (1.3"/1.54") or 170×320 (1.9") panels need `DisplayModel.h`/`Display.cpp` layout changes.                                                               |
| 4   | microSD interface | SPI microSD breakout. Preferred: 3.3 V native (no regulator/level shifter). A 5 V module with on-board regulator + level shifter is acceptable if powered from 5 V. | 1   | Which type it is (decides 3.3 V or 5 V supply pin).                                                                                                                                 |
| 5   | microSD card      | 8–32 GB **SDHC**, formatted **FAT32**, Class 10 / A1. Industrial or high-endurance grade preferred for heat and vibration.                                          | 2   | Formatted FAT32 (not exFAT). One spare.                                                                                                                                             |
| 6   | IMU               | **BMI270** breakout, I2C, 3.3 V, with on-board I2C pull-ups, address 0x68 (SDO low) or 0x69 (SDO high) — firmware probes both.                                      | 1   | Chip marking/vendor page says BMI270 (not BMI160/BMI260). Pull-ups present (else add 4.7 kΩ SDA/SCL → 3.3 V).                                                                       |

## 2. Power (vehicle)

| #   | Part                 | Required specification                                                                                                                                                                                 | Qty |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 7   | 12 V → 5 V converter | Automotive-rated input (≥ 9–16 V operating, load-dump/transient protected), **5 V ≥ 2 A** output, USB output or screw terminals. A quality 12 V USB adapter (≥ 2.4 A) is acceptable for the prototype. | 1   |
| 8   | Inline fuse          | 1–2 A on the 12 V side, if hard-wired.                                                                                                                                                                 | 1   |
| 9   | USB cable            | USB-A/C to the DevKitC **"UART"** port (data-capable, ≤ 1 m). The same port carries the serial log.                                                                                                    | 2   |

Planning estimate of the 5 V load (to be **measured** in procedure §2, not assumed): ESP32-S3 ~50–150 mA with Wi-Fi off, BN-880Q ~50 mA, ST7789 with backlight ~20–60 mA, microSD write peaks ~50–100 mA, BMI270 < 1 mA → **well under 0.5 A**. A 2 A supply leaves margin for cranking dips and USB cable losses.

## 3. Wiring and mechanics

| #   | Part             | Specification                                                                                                                                                               | Qty   |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 10  | Interconnect     | Bench: female–female jumpers. **Vehicle: soldered perfboard or locking connectors (JST-XH/SH) with strain relief** — jumpers shake loose. SPI wires to the display ≤ 15 cm. | 1 set |
| 11  | Enclosure        | Non-metallic (plastic) so it does not shield the GNSS antenna; display window; ventilation or shade (dashboards in Panama sun exceed 60 °C).                                | 1     |
| 12  | GNSS mounting    | Antenna side up with clear sky view: roof (magnetic/adhesive) or front of the dashboard under the windscreen. Not under metal, not inside the glovebox.                     | 1     |
| 13  | IMU mounting     | Rigid to the enclosure/chassis (screws or hard adhesive — not foam tape), axes square to the vehicle, orientation recorded.                                                 | 1     |
| 14  | Display mounting | Driver-visible without looking away from the road; readable in sun.                                                                                                         | 1     |

## 4. Wiring table (from `firmware/include/pins.h`)

| Module  | Module pin      | ESP32-S3 pin                          | Notes                                 |
| ------- | --------------- | ------------------------------------- | ------------------------------------- |
| BN-880Q | VCC             | 5V (or 3V3 per module label)          | Check label; most BN-880 run from 5 V |
|         | GND             | GND                                   |                                       |
|         | TX              | **GPIO 18** (RX1)                     | Measure TX ≤ 3.3 V first              |
|         | RX              | **GPIO 17** (TX1)                     |                                       |
|         | SDA / SCL       | —                                     | Compass, not used: leave unconnected  |
| microSD | VCC             | 3V3 (native) or 5V (regulated module) |                                       |
|         | GND             | GND                                   |                                       |
|         | CS              | **GPIO 10**                           |                                       |
|         | MOSI / DI       | **GPIO 11**                           |                                       |
|         | SCK / CLK       | **GPIO 12**                           |                                       |
|         | MISO / DO       | **GPIO 13**                           |                                       |
| ST7789  | VCC             | 3V3                                   |                                       |
|         | GND             | GND                                   |                                       |
|         | SCL (clock)     | **GPIO 6**                            |                                       |
|         | SDA (data/MOSI) | **GPIO 7**                            | Write-only panel: no MISO             |
|         | CS              | **GPIO 5**                            |                                       |
|         | DC              | **GPIO 4**                            |                                       |
|         | RES / RST       | **GPIO 2**                            |                                       |
|         | BL / BLK        | **GPIO 1**                            | Driven HIGH at boot                   |
| BMI270  | VCC / VIN       | 3V3                                   |                                       |
|         | GND             | GND                                   |                                       |
|         | SDA             | **GPIO 8**                            |                                       |
|         | SCL             | **GPIO 9**                            |                                       |
|         | INT1            | GPIO 21 (optional)                    | Wired for V2; unused in V1.5          |
|         | SDO             | per breakout                          | Sets address 0x68/0x69; either works  |

Do not use: GPIO 0, 3, 45, 46 (strapping), 19, 20 (native USB), 26–37 (flash/PSRAM), 38, 47, 48 (LED / 1.8 V I/O on WROOM-2), 43, 44 (serial console). Spare: 14, 15, 16, 39, 40, 41, 42.

## 5. Test equipment (for `docs/V1_5_TEST_PROCEDURE.md`)

| Item                                           | Needed for                   | Required?                                                                                                                                   |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Digital multimeter                             | §1 continuity, §2 voltages   | **Required**                                                                                                                                |
| USB power meter (inline)                       | §2 current                   | Recommended                                                                                                                                 |
| Laptop with PlatformIO, Node ≥ 22.6, this repo | flashing, serial log, replay | **Required**                                                                                                                                |
| microSD card reader                            | §7, §13                      | **Required**                                                                                                                                |
| Independent lap reference                      | §15                          | **Required for the accuracy verdict**: circuit transponder timing, a commercial GNSS lap timer, or ≥ 120 fps video of the start/finish line |
| Camera filming the display                     | §12 if no laptop in the car  | Optional                                                                                                                                    |
| Logic analyzer / USB-UART adapter              | debugging only               | Optional                                                                                                                                    |
