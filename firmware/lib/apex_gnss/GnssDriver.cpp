#include "GnssDriver.h"

namespace apex {

namespace {
constexpr uint32_t kGnssBaudDefault = 9600;    // BN-880Q power-on default
constexpr uint32_t kGnssBaud = 115200;         // configured rate for 10 Hz NMEA
// UART RX buffer. The core default (256 B) holds ~170 ms of GGA+RMC at 10 Hz;
// 4 KB holds ~2.7 s, so a slow SD write, a display refresh or an I2C timeout
// delays fix processing (timestamps come from the receiver, so no accuracy is
// lost) instead of dropping NMEA bytes. Must be set before every begin().
constexpr size_t kRxBufferBytes = 4096;
}  // namespace

void GnssDriver::ubxSend(uint8_t cls, uint8_t id, const uint8_t* payload, uint16_t len) {
  uint8_t ckA = 0, ckB = 0;
  auto add = [&](uint8_t b) {
    ckA += b;
    ckB += ckA;
  };
  const uint8_t hdr[] = {0xB5, 0x62, cls, id, static_cast<uint8_t>(len & 0xFF), static_cast<uint8_t>(len >> 8)};
  uart_.write(hdr, sizeof hdr);
  for (int i = 2; i < 6; i++) add(hdr[i]);
  for (uint16_t i = 0; i < len; i++) add(payload[i]);
  uart_.write(payload, len);
  uart_.write(ckA);
  uart_.write(ckB);
}

void GnssDriver::configureReceiver(int rxPin, int txPin) {
  // CFG-PRT: UART1, 8N1, configured baud, in UBX+NMEA, out NMEA.
  const uint32_t baud = kGnssBaud;
  const uint8_t prt[20] = {0x01, 0x00, 0x00, 0x00, 0xD0, 0x08, 0x00, 0x00,
                            static_cast<uint8_t>(baud), static_cast<uint8_t>(baud >> 8),
                            static_cast<uint8_t>(baud >> 16), static_cast<uint8_t>(baud >> 24),
                            0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00};
  uart_.setRxBufferSize(kRxBufferBytes);
  uart_.begin(kGnssBaudDefault, SERIAL_8N1, rxPin, txPin);
  delay(100);
  ubxSend(0x06, 0x00, prt, sizeof prt);
  delay(150);
  uart_.end();
  uart_.setRxBufferSize(kRxBufferBytes);
  uart_.begin(kGnssBaud, SERIAL_8N1, rxPin, txPin);
  delay(100);
  // CFG-RATE: measRate 100 ms (10 Hz), navRate 1, timeRef UTC.
  const uint8_t rate[6] = {0x64, 0x00, 0x01, 0x00, 0x00, 0x00};
  ubxSend(0x06, 0x08, rate, sizeof rate);
  // CFG-MSG: keep GGA + RMC (position, sats, HDOP, speed, course, GGA
  // quality); disable GSV/GSA/GLL/VTG so the UART fits comfortably at 10 Hz.
  const uint8_t off[][3] = {{0xF0, 0x03, 0}, {0xF0, 0x02, 0}, {0xF0, 0x01, 0}, {0xF0, 0x05, 0}};
  for (auto& m : off) ubxSend(0x06, 0x01, m, 3);
}

void GnssDriver::begin(int rxPin, int txPin) { configureReceiver(rxPin, txPin); }

double GnssDriver::fixTimeS() {
  const double tod = gps_.time.hour() * 3600.0 + gps_.time.minute() * 60.0 + gps_.time.second() +
                      gps_.time.centisecond() / 100.0;
  if (lastTodS_ >= 0 && tod + 43200 < lastTodS_) dayOffsetS_ += 86400;  // UTC midnight rollover
  lastTodS_ = tod;
  return dayOffsetS_ + tod;
}

bool GnssDriver::poll(ContractRow& row, GnssFix& fix) {
  while (uart_.available()) {
    if (!gps_.encode(uart_.read())) continue;
    // One fix per new RMC/GGA position update with a valid time of fix.
    if (!gps_.location.isUpdated() || !gps_.time.isValid()) continue;

    // Hardware timestamp: millis() captured the instant this UART finished
    // decoding the sentence that completed this fix. Diagnostic only.
    const uint32_t mcuMs = millis();
    // Authoritative clock: the receiver's own time-of-fix, never millis().
    const double t = fixTimeS();

    const double lat = gps_.location.lat();
    const double lon = gps_.location.lng();
    const bool haveSpeed = gps_.speed.isValid();
    const bool haveCourse = gps_.course.isValid();
    const int sats = gps_.satellites.isValid() ? static_cast<int>(gps_.satellites.value()) : 0;
    const double hdop = gps_.hdop.isValid() ? gps_.hdop.hdop() : 99.9;
    // Real NMEA GGA quality (field 6: 0 invalid .. 8 simulated), not a
    // hardcoded value — TinyGPSLocation parses it directly.
    const int gga = static_cast<int>(gps_.location.FixQuality()) - '0';

    fix.t = t;
    fix.lat = lat;
    fix.lon = lon;
    fix.speedMs = haveSpeed ? gps_.speed.mps() : NAN;
    fix.courseDeg = haveCourse ? gps_.course.deg() : NAN;
    fix.sats = sats;
    fix.hdop = hdop;
    fix.fixType = gga <= 0 ? 0 : 3;  // contract §2: GGA can't tell 2D from 3D

    row.timestampMs = static_cast<int64_t>(t * 1000.0 + 0.5);  // t is always >= 0
    row.lat = lat;
    row.lon = lon;
    row.speedKmh = haveSpeed ? gps_.speed.kmph() : NAN;
    row.headingDeg = haveCourse ? gps_.course.deg() : NAN;
    row.satellites = sats;
    row.hdop = hdop;
    row.fixQuality = gga;
    row.altitudeM = gps_.altitude.isValid() ? gps_.altitude.meters() : NAN;
    row.mcuMs = static_cast<int32_t>(mcuMs);

    fixesSeen_++;
    return true;
  }
  return false;
}

}  // namespace apex
