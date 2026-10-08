#include "Imu.h"

namespace apex {

namespace {
constexpr uint8_t kRegChipId = 0x00;
constexpr uint8_t kChipIdExpected = 0x24;  // BMI270, per Bosch datasheet
constexpr uint8_t kRegCmd = 0x7E;
constexpr uint8_t kCmdSoftReset = 0xB6;
constexpr uint8_t kRegAccXLsb = 0x0C;  // ACC_X..GYR_Z: 12 contiguous bytes
}  // namespace

bool Imu::probe(uint8_t addr) {
  wire_->beginTransmission(addr);
  wire_->write(kRegChipId);
  if (wire_->endTransmission(false) != 0) return false;  // NACK: nothing answering at this address
  if (wire_->requestFrom(static_cast<int>(addr), 1) != 1) return false;
  chipId_ = wire_->read();
  return chipId_ == kChipIdExpected;
}

bool Imu::begin(int sdaPin, int sclPin, TwoWire& wire) {
  wire_ = &wire;
  wire_->begin(sdaPin, sclPin);
  // BMI270 I2C address is 0x68 (SDO low) or 0x69 (SDO high), board-wiring dependent.
  if (probe(0x68)) {
    addr_ = 0x68;
  } else if (probe(0x69)) {
    addr_ = 0x69;
  } else {
    ok_ = false;
    return false;
  }

  wire_->beginTransmission(addr_);
  wire_->write(kRegCmd);
  wire_->write(kCmdSoftReset);
  wire_->endTransmission();
  delay(2);  // datasheet: allow the reset to complete before the next transaction

  ok_ = probe(addr_);  // confirm the chip still answers post-reset
  return ok_;
}

bool Imu::readRaw(ImuSample& out) {
  if (!ok_) return false;
  wire_->beginTransmission(addr_);
  wire_->write(kRegAccXLsb);
  if (wire_->endTransmission(false) != 0) return false;
  if (wire_->requestFrom(static_cast<int>(addr_), 12) != 12) return false;
  uint8_t b[12];
  for (int i = 0; i < 12; i++) b[i] = wire_->read();
  out.ax = static_cast<int16_t>(b[0] | (b[1] << 8));
  out.ay = static_cast<int16_t>(b[2] | (b[3] << 8));
  out.az = static_cast<int16_t>(b[4] | (b[5] << 8));
  out.gx = static_cast<int16_t>(b[6] | (b[7] << 8));
  out.gy = static_cast<int16_t>(b[8] | (b[9] << 8));
  out.gz = static_cast<int16_t>(b[10] | (b[11] << 8));
  return true;
}

}  // namespace apex
