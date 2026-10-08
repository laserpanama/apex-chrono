#include "Imu.h"

#include <esp_timer.h>

namespace apex {

namespace {
constexpr uint8_t kRegChipId = 0x00;
constexpr uint32_t kI2cHz = 400000;
constexpr uint16_t kI2cTimeoutMs = 10;
// Arduino-ESP32's Wire buffer is 128 bytes; Bosch writes the config file in
// read_write_len chunks (+1 register byte), so keep it well under that.
constexpr uint16_t kBurstLen = 64;

struct BusCtx {
  TwoWire* wire;
  uint8_t addr;
};
BusCtx g_ctx{nullptr, 0};

uint8_t accelRangeCode(int g) {
  switch (g) {
    case 2: return BMI2_ACC_RANGE_2G;
    case 4: return BMI2_ACC_RANGE_4G;
    case 16: return BMI2_ACC_RANGE_16G;
    default: return BMI2_ACC_RANGE_8G;
  }
}

uint8_t gyroRangeCode(int dps) {
  switch (dps) {
    case 125: return BMI2_GYR_RANGE_125;
    case 250: return BMI2_GYR_RANGE_250;
    case 1000: return BMI2_GYR_RANGE_1000;
    case 2000: return BMI2_GYR_RANGE_2000;
    default: return BMI2_GYR_RANGE_500;
  }
}

uint8_t odrCode(int hz, bool gyro) {
  if (hz <= 50) return gyro ? BMI2_GYR_ODR_50HZ : BMI2_ACC_ODR_50HZ;
  if (hz >= 200) return gyro ? BMI2_GYR_ODR_200HZ : BMI2_ACC_ODR_200HZ;
  return gyro ? BMI2_GYR_ODR_100HZ : BMI2_ACC_ODR_100HZ;
}
}  // namespace

BMI2_INTF_RETURN_TYPE Bmi270Backend::i2cRead(uint8_t reg, uint8_t* data, uint32_t len, void* ctx) {
  auto* c = static_cast<BusCtx*>(ctx);
  c->wire->beginTransmission(c->addr);
  c->wire->write(reg);
  if (c->wire->endTransmission(false) != 0) return BMI2_E_COM_FAIL;
  // 3-arg form: identical signature in Arduino-ESP32 2.0.x and 3.x.
  const size_t got = c->wire->requestFrom(c->addr, static_cast<size_t>(len), true);
  if (got != len) {
    while (c->wire->available()) c->wire->read();
    return BMI2_E_COM_FAIL;  // short read: never hand partial data to the API
  }
  for (uint32_t i = 0; i < len; i++) data[i] = static_cast<uint8_t>(c->wire->read());
  return BMI2_OK;
}

BMI2_INTF_RETURN_TYPE Bmi270Backend::i2cWrite(uint8_t reg, const uint8_t* data, uint32_t len, void* ctx) {
  auto* c = static_cast<BusCtx*>(ctx);
  c->wire->beginTransmission(c->addr);
  c->wire->write(reg);
  if (len) c->wire->write(data, len);
  return c->wire->endTransmission() == 0 ? BMI2_OK : BMI2_E_COM_FAIL;
}

void Bmi270Backend::delayUs(uint32_t us, void*) { delayMicroseconds(us); }

uint64_t Bmi270Backend::nowUs() { return static_cast<uint64_t>(esp_timer_get_time()); }

bool Bmi270Backend::readChipId(uint8_t addr, uint8_t& id) {
  BusCtx c{wire_, addr};
  return i2cRead(kRegChipId, &id, 1, &c) == BMI2_OK;
}

ImuInitResult Bmi270Backend::init(const ImuConfig& cfg, uint8_t& chipIdOut) {
  // BMI270 answers at 0x68 (SDO low) or 0x69 (SDO high), board dependent.
  uint8_t id = 0;
  if (readChipId(BMI2_I2C_PRIM_ADDR, id)) addr_ = BMI2_I2C_PRIM_ADDR;
  else if (readChipId(BMI2_I2C_SEC_ADDR, id)) addr_ = BMI2_I2C_SEC_ADDR;
  else return ImuInitResult::NotFound;
  chipIdOut = id;
  if (id != BMI270_CHIP_ID) return ImuInitResult::WrongChip;

  g_ctx = BusCtx{wire_, addr_};
  dev_ = bmi2_dev{};
  dev_.intf = BMI2_I2C_INTF;
  dev_.read = i2cRead;
  dev_.write = i2cWrite;
  dev_.delay_us = delayUs;
  dev_.intf_ptr = &g_ctx;
  dev_.read_write_len = kBurstLen;
  dev_.config_file_ptr = nullptr;  // use Bosch's bundled BMI270 config file

  // Soft reset, CHIP_ID check, config file upload + INTERNAL_STATUS check.
  lastRslt_ = bmi270_init(&dev_);
  if (lastRslt_ != BMI2_OK) return ImuInitResult::ConfigFailed;

  bmi2_sens_config sc[2];
  sc[0].type = BMI2_ACCEL;
  sc[1].type = BMI2_GYRO;
  lastRslt_ = bmi2_get_sensor_config(sc, 2, &dev_);
  if (lastRslt_ != BMI2_OK) return ImuInitResult::ConfigFailed;

  sc[0].cfg.acc.odr = odrCode(cfg.odrHz, false);
  sc[0].cfg.acc.range = accelRangeCode(cfg.accelRangeG);
  sc[0].cfg.acc.bwp = BMI2_ACC_NORMAL_AVG4;
  sc[0].cfg.acc.filter_perf = BMI2_PERF_OPT_MODE;

  sc[1].cfg.gyr.odr = odrCode(cfg.odrHz, true);
  sc[1].cfg.gyr.range = gyroRangeCode(cfg.gyroRangeDps);
  sc[1].cfg.gyr.bwp = BMI2_GYR_NORMAL_MODE;
  sc[1].cfg.gyr.noise_perf = BMI2_POWER_OPT_MODE;
  sc[1].cfg.gyr.filter_perf = BMI2_PERF_OPT_MODE;

  lastRslt_ = bmi2_set_sensor_config(sc, 2, &dev_);
  if (lastRslt_ != BMI2_OK) return ImuInitResult::ConfigFailed;

  const uint8_t sensors[2] = {BMI2_ACCEL, BMI2_GYRO};
  lastRslt_ = bmi2_sensor_enable(sensors, 2, &dev_);
  if (lastRslt_ != BMI2_OK) return ImuInitResult::ConfigFailed;
  return ImuInitResult::Ok;
}

bool Bmi270Backend::read(ImuRaw& out) {
  bmi2_sens_data d{};
  lastRslt_ = bmi2_get_sensor_data(&d, &dev_);
  if (lastRslt_ != BMI2_OK) return false;
  out.ax = d.acc.x;
  out.ay = d.acc.y;
  out.az = d.acc.z;
  out.gx = d.gyr.x;
  out.gy = d.gyr.y;
  out.gz = d.gyr.z;
  out.sensorTime = d.sens_time;
  out.accFresh = (d.status & BMI2_DRDY_ACC) != 0;
  out.gyrFresh = (d.status & BMI2_DRDY_GYR) != 0;
  return true;
}

bool Imu::begin(int sdaPin, int sclPin, TwoWire& wire, const ImuConfig& cfg) {
  wire.begin(sdaPin, sclPin, kI2cHz);
  wire.setTimeOut(kI2cTimeoutMs);
  backend_.attach(wire);
  return core_.begin(backend_, cfg);
}

}  // namespace apex
