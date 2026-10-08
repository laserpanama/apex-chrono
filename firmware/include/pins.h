#pragma once
// Apex Chrono V1.5 — authoritative ESP32-S3 hardware pin map.
//
// Target: ESP32-S3-DevKitC-1 N32R16V (32 MB QIO flash, 16 MB Octal PSRAM),
// BN-880Q 10 Hz GNSS, ST7789 2" SPI display + microSD, BMI270 IMU.
//
// This is the ONLY place GPIO numbers are assigned in this firmware. Every
// driver (GnssDriver, SdLogger, Display, Imu) takes its pins from here —
// never a hardcoded number anywhere else under firmware/.
//
// Reserved / do-not-use ranges on this exact module (full reasoning in
// docs/V1_5_HARDWARE.md):
//   0, 3, 45, 46    strapping pins (boot mode / BOOT button, JTAG select,
//                   VDD_SPI voltage select, ROM log verbosity)
//   19, 20          native USB D-/D+ (wired to the onboard "USB" connector)
//   26-32           Quad SPI flash — reserved on every ESP32-S3 module with
//                   embedded flash, regardless of size
//   33-37           Octal PSRAM — reserved ONLY because N32R16V uses Octal
//                   PSRAM (16 MB is only available as Octal); these pins are
//                   not broken out to the header on this module variant
//   38, 48          onboard addressable RGB LED — board-revision dependent
//                   position (GPIO38 on DevKitC-1 v1.1, GPIO48 on v1.0);
//                   both reserved so the map is revision-proof
//   43, 44          UART0 TX/RX — the onboard USB-UART bridge, used as the
//                   debug/console Serial port
//
// GPIO 22-25 do not exist on the ESP32-S3 chip (not a board limitation, so
// they are not listed as "reserved" — they are simply absent).
//
// The static_asserts at the bottom of this file PROVE at compile time that
// (a) no two peripherals share a GPIO and (b) no peripheral pin falls in a
// reserved range. A future edit that breaks either rule fails the build
// instead of silently wiring two things to the same pin.

#include <cstddef>

namespace apex {
namespace pins {

// ── GNSS: BN-880Q, hardware UART1. Contract-row timestamps come from the
//    receiver's own time-of-fix, NEVER from these pins or from millis() —
//    see firmware/lib/apex_gnss/GnssDriver.h. GNSS is the critical V1 timing
//    dependency; every other peripheral below may fail without affecting it.
constexpr int GNSS_RX = 18;  // ESP32 RX1 ← BN-880Q TX
constexpr int GNSS_TX = 17;  // ESP32 TX1 → BN-880Q RX

// ── Storage: microSD, dedicated SPI bus (FSPI / SPI2). Kept off the
//    display's bus on purpose for the first physical prototype, to remove
//    bus-sharing/CS-timing bugs as a bring-up variable.
constexpr int SD_SCLK = 12;
constexpr int SD_MOSI = 11;
constexpr int SD_MISO = 13;
constexpr int SD_CS = 10;

// ── Display: ST7789 2", dedicated SPI bus (HSPI / SPI3). Write-only — no
//    MISO wire (ST7789 breakouts conventionally don't expose a usable read
//    path, and none is needed for this panel).
constexpr int TFT_SCLK = 6;
constexpr int TFT_MOSI = 7;
constexpr int TFT_CS = 5;
constexpr int TFT_DC = 4;
constexpr int TFT_RST = 2;
constexpr int TFT_BL = 1;  // backlight enable (digital; PWM dimming is a later nicety)

// ── IMU: BMI270, I2C. SDA/SCL match the ESP32-S3 Arduino core's own Wire
//    defaults (8/9), so no Wire.setPins() surprises if a library assumes them.
constexpr int IMU_SDA = 8;
constexpr int IMU_SCL = 9;
constexpr int IMU_INT1 = 21;  // data-ready interrupt line; wired but UNUSED by
                               // V1.5 firmware (poll-based only) — reserved
                               // for a V2 interrupt-driven upgrade.

// ── Spare / expansion — NOT wired by V1.5 firmware. Free for a start
//    button, buzzer, a future GNSS PPS input, CAN transceiver, etc.:
//    14, 15, 16, 39, 40, 41, 42, 47

// ───────────────────────── compile-time verification ─────────────────────────
constexpr int kActive[] = {GNSS_RX, GNSS_TX,          //
                            SD_SCLK, SD_MOSI, SD_MISO, SD_CS,
                            TFT_SCLK, TFT_MOSI, TFT_CS, TFT_DC, TFT_RST, TFT_BL,
                            IMU_SDA, IMU_SCL, IMU_INT1};
constexpr std::size_t kActiveCount = sizeof(kActive) / sizeof(kActive[0]);

constexpr int kReserved[] = {
    0, 3, 45, 46,                                   // strapping
    19, 20,                                         // native USB
    26, 27, 28, 29, 30, 31, 32,                      // quad SPI flash
    33, 34, 35, 36, 37,                              // octal PSRAM (N32R16V)
    38, 48,                                          // onboard RGB LED (rev-dependent)
    43, 44,                                          // UART0 debug console
};
constexpr std::size_t kReservedCount = sizeof(kReserved) / sizeof(kReserved[0]);

constexpr bool hasDuplicate(const int* a, std::size_t n) {
  for (std::size_t i = 0; i < n; i++)
    for (std::size_t j = i + 1; j < n; j++)
      if (a[i] == a[j]) return true;
  return false;
}

constexpr bool isReserved(int pin) {
  for (std::size_t i = 0; i < kReservedCount; i++)
    if (kReserved[i] == pin) return true;
  return false;
}

constexpr bool anyReserved(const int* a, std::size_t n) {
  for (std::size_t i = 0; i < n; i++)
    if (isReserved(a[i])) return true;
  return false;
}

static_assert(!hasDuplicate(kActive, kActiveCount),
              "pin map: two peripherals share a GPIO -- fix firmware/include/pins.h");
static_assert(!anyReserved(kActive, kActiveCount),
              "pin map: a peripheral pin collides with a reserved/strapping/flash/PSRAM/USB/UART0/LED pin "
              "-- fix firmware/include/pins.h");

}  // namespace pins
}  // namespace apex
