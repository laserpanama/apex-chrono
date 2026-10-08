#pragma once
// Apex Chrono V1.5 — BMI270 on I2C (ESP32 side).
//
// Bring-up goes through Bosch's own BMI270 Sensor API (v2.86.1, shipped
// inside the SparkFun BMI270 Arduino Library, see platformio.ini). That API
// uploads Bosch's ~8 KB config file, which the chip needs before its
// accelerometer/gyroscope outputs mean anything. The config file is NOT
// copied into this repo or typed by hand: it comes from the vendor package.
// Only the Bosch C API is used; SparkFun's C++ wrapper is not (its I2C read
// does not check for short reads).
//
// All logic that can be tested without a chip (states, comm test,
// conversion, timestamps, failure handling, logging interface) is in
// ImuCore.h. This file only moves bytes over I2C.
//
// IMU failure never stops timing: begin() returning false or the core
// entering Failed just leaves the IMU silent. Nothing in the timing path
// reads IMU data.

#include <Arduino.h>
#include <Wire.h>

#include "ImuCore.h"
#include "bmi270_api/bmi270.h"

namespace apex {

class Bmi270Backend : public ImuBackend {
 public:
  void attach(TwoWire& wire) { wire_ = &wire; }
  ImuInitResult init(const ImuConfig& cfg, uint8_t& chipIdOut) override;
  bool read(ImuRaw& out) override;
  uint64_t nowUs() override;
  void sleepMs(uint32_t ms) override { delay(ms); }

  uint8_t address() const { return addr_; }
  int8_t lastBoschResult() const { return lastRslt_; }

 private:
  bool readChipId(uint8_t addr, uint8_t& id);

  static BMI2_INTF_RETURN_TYPE i2cRead(uint8_t reg, uint8_t* data, uint32_t len, void* ctx);
  static BMI2_INTF_RETURN_TYPE i2cWrite(uint8_t reg, const uint8_t* data, uint32_t len, void* ctx);
  static void delayUs(uint32_t us, void* ctx);

  TwoWire* wire_ = nullptr;
  uint8_t addr_ = 0;
  int8_t lastRslt_ = 0;
  bmi2_dev dev_{};
};

class Imu {
 public:
  // I2C at 400 kHz with a short bus timeout, so a stuck or missing chip costs
  // milliseconds per call, never a hang.
  bool begin(int sdaPin, int sclPin, TwoWire& wire = Wire, const ImuConfig& cfg = ImuConfig{});
  bool poll() { return core_.poll(); }

  void setSink(ImuSink* sink) { core_.setSink(sink); }
  bool ok() const { return core_.running(); }
  ImuState state() const { return core_.state(); }
  const ImuCore& core() const { return core_; }
  uint8_t address() const { return backend_.address(); }
  int8_t lastBoschResult() const { return backend_.lastBoschResult(); }

 private:
  Bmi270Backend backend_;
  ImuCore core_;
};

}  // namespace apex
