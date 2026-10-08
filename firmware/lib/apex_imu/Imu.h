#pragma once
// Apex Chrono V1.5 — BMI270 wiring/presence check (I2C).
//
// KNOWN, DELIBERATE LIMITATION (see docs/V1_5_HARDWARE.md): the BMI270
// requires Bosch's proprietary ~8 KB "config_file" binary blob to be
// uploaded before the accelerometer/gyroscope data registers produce
// characterized output — this is documented Bosch behaviour, not a guess;
// the chip stays in a config/standby state without it. That blob is
// deliberately NOT reproduced here: hand-transcribing ~8 KB of vendor binary
// from memory risks a silent transcription error, which is worse than not
// reading IMU data at all (a wrong blob can still "successfully" write and
// produce plausible-looking garbage instead of failing loudly). Loading the
// real blob via a vetted driver (e.g. Bosch's own BMI270-Sensor-API) is
// deferred to whenever IMU data is actually consumed by a feature — that is
// V2 telemetry, explicitly out of scope for this task.
//
// What IS implemented and real: I2C wiring verification (CHIP_ID readback,
// address 0x68 or 0x69 depending on SDO wiring), a documented soft reset,
// and raw register readback for bring-up debugging only.
//
// IMU failure (missing chip, wrong ID, I2C NACK) never stops timing:
// begin() returning false just leaves the IMU inert for the whole session.

#include <Arduino.h>
#include <Wire.h>

namespace apex {

struct ImuSample {
  int16_t ax = 0, ay = 0, az = 0;
  int16_t gx = 0, gy = 0, gz = 0;
};

class Imu {
 public:
  bool begin(int sdaPin, int sclPin, TwoWire& wire = Wire);

  // Raw register readback only (see the class note above). Not used for any
  // decision in V1.5 firmware. Returns false on I2C error.
  bool readRaw(ImuSample& out);

  bool ok() const { return ok_; }
  uint8_t chipId() const { return chipId_; }
  uint8_t address() const { return addr_; }

 private:
  bool probe(uint8_t addr);

  TwoWire* wire_ = nullptr;
  uint8_t addr_ = 0;
  uint8_t chipId_ = 0;
  bool ok_ = false;
};

}  // namespace apex
