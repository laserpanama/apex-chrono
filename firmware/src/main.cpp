// Apex Chrono V1 firmware — ESP32-S3 + BN-880 (u-blox M8N) GNSS lap timer.
//
// Data path:  BN-880 UART (NMEA, 10 Hz) → TinyGPSPlus → apex::LapEngine
//             → serial event/telemetry log  (display + microSD are the next step)
//
// Track config: /track.txt on the SD card (same format as the host fixtures:
// `origin`, `centerline N` + N "lat lon" lines, `gates G` + G
// "SF|SEC leftLat leftLon rightLat rightLon" lines). Until SD is wired, a
// track can be pasted over USB serial: send the file, then a line "END".
//
// Timing uses the receiver's UTC time-of-fix (hh:mm:ss.cc), never millis().

#include <Arduino.h>
#include <TinyGPSPlus.h>

#include "apex_timing.h"

static constexpr int GNSS_RX = 18;  // ESP32 RX ← BN-880 TX (adjust to wiring)
static constexpr int GNSS_TX = 17;  // ESP32 TX → BN-880 RX
static constexpr uint32_t GNSS_BAUD_DEFAULT = 9600;
static constexpr uint32_t GNSS_BAUD = 115200;

HardwareSerial GNSS(1);
TinyGPSPlus gps;

static apex::Track track;  // ~100 KB — static, not on the loop task stack
static apex::LapEngine engine;
static bool trackReady = false;

// ── u-blox configuration (UBX binary) ──────────────────────────────
static void ubxSend(uint8_t cls, uint8_t id, const uint8_t* payload, uint16_t len) {
  uint8_t ckA = 0, ckB = 0;
  auto add = [&](uint8_t b) { ckA += b; ckB += ckA; };
  const uint8_t hdr[] = {0xB5, 0x62, cls, id, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8)};
  GNSS.write(hdr, sizeof hdr);
  for (int i = 2; i < 6; i++) add(hdr[i]);
  for (uint16_t i = 0; i < len; i++) add(payload[i]);
  GNSS.write(payload, len);
  GNSS.write(ckA);
  GNSS.write(ckB);
}

static void configureReceiver() {
  // CFG-PRT: UART1, 8N1, 115200, in UBX+NMEA, out NMEA
  const uint32_t baud = GNSS_BAUD;
  const uint8_t prt[20] = {0x01, 0x00, 0x00, 0x00, 0xD0, 0x08, 0x00, 0x00,
                           (uint8_t)baud, (uint8_t)(baud >> 8), (uint8_t)(baud >> 16), (uint8_t)(baud >> 24),
                           0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00};
  GNSS.begin(GNSS_BAUD_DEFAULT, SERIAL_8N1, GNSS_RX, GNSS_TX);
  delay(100);
  ubxSend(0x06, 0x00, prt, sizeof prt);
  delay(150);
  GNSS.end();
  GNSS.begin(GNSS_BAUD, SERIAL_8N1, GNSS_RX, GNSS_TX);
  delay(100);
  // CFG-RATE: measRate 100 ms (10 Hz), navRate 1, timeRef UTC
  const uint8_t rate[6] = {0x64, 0x00, 0x01, 0x00, 0x00, 0x00};
  ubxSend(0x06, 0x08, rate, sizeof rate);
  // CFG-MSG: keep GGA + RMC (position, sats, HDOP, speed, course); disable GSV/GSA/GLL/VTG to fit 10 Hz
  const uint8_t off[][3] = {{0xF0, 0x03, 0}, {0xF0, 0x02, 0}, {0xF0, 0x01, 0}, {0xF0, 0x05, 0}};
  for (auto& m : off) ubxSend(0x06, 0x01, m, 3);
}

// ── track loading (same text format as firmware/test_host fixtures) ──
static bool parseTrack(Stream& in) {
  static double lat[apex::MAX_CENTER_PTS + 1], lon[apex::MAX_CENTER_PTS + 1];
  static apex::GeoGate gates[apex::MAX_GATES];
  double olat = NAN, olon = NAN;
  int n = 0, ng = 0, mode = 0, want = 0;
  while (true) {
    String line = in.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) {
      if (!in.available()) delay(5);
      continue;
    }
    if (line == "END") break;
    char kw[16];
    if (line.startsWith("origin")) {
      sscanf(line.c_str(), "%15s %lf %lf", kw, &olat, &olon);
    } else if (line.startsWith("centerline")) {
      sscanf(line.c_str(), "%15s %d", kw, &want);
      if (want > apex::MAX_CENTER_PTS + 1) return false;
      mode = 1;
      n = 0;
    } else if (line.startsWith("gates")) {
      sscanf(line.c_str(), "%15s %d", kw, &want);
      if (want > apex::MAX_GATES) return false;
      mode = 2;
      ng = 0;
    } else if (mode == 1 && n < want) {
      sscanf(line.c_str(), "%lf %lf", &lat[n], &lon[n]);
      n++;
    } else if (mode == 2 && ng < want) {
      apex::GeoGate& g = gates[ng++];
      sscanf(line.c_str(), "%15s %lf %lf %lf %lf", kw, &g.leftLat, &g.leftLon, &g.rightLat, &g.rightLon);
      g.kind = strcmp(kw, "SF") == 0 ? apex::GateKind::StartFinish : apex::GateKind::Sector;
    }
    if (mode == 2 && ng == want && want > 0) break;
  }
  if (!track.compile(olat, olon, lat, lon, n, gates, ng)) {
    Serial.printf("TRACK,ERROR,%s\n", track.error);
    return false;
  }
  engine.reset(&track);
  Serial.printf("TRACK,OK,%d_points,%d_gates,%.1f_m\n", track.cl.n, track.nGates, track.cl.lengthM);
  return true;
}

// ── GNSS time of fix → monotonic seconds ────────────────────────────
static double dayOffset = 0, lastTod = -1;
static double fixTimeS() {
  const double tod = gps.time.hour() * 3600.0 + gps.time.minute() * 60.0 + gps.time.second() +
                     gps.time.centisecond() / 100.0;
  if (lastTod >= 0 && tod + 43200 < lastTod) dayOffset += 86400;  // UTC midnight rollover
  lastTod = tod;
  return dayOffset + tod;
}

static void logEvent(const apex::Event& e) {
  switch (e.type) {
    case apex::EventType::LapStart: Serial.printf("EVT,LAP_START,%.3f,%d\n", e.t, e.lap); break;
    case apex::EventType::Sector: Serial.printf("EVT,SECTOR,%.3f,%d,%d,%.3f\n", e.t, e.lap, e.index + 1, e.value); break;
    case apex::EventType::Lap: {
      const apex::LapRecord* r = engine.lastLap();
      Serial.printf("EVT,LAP,%.3f,%d,%.3f,%s,max_kmh=%.1f\n", e.t, e.lap, e.value, r && r->valid ? "valid" : "invalid",
                    r ? r->maxSpeedMs * 3.6 : 0.0);
      break;
    }
    case apex::EventType::RejectedOrder: Serial.printf("EVT,REJECT_ORDER,%.3f,gate=%d\n", e.t, e.index); break;
    case apex::EventType::RejectedShortLap: Serial.printf("EVT,REJECT_SHORT,%.3f,%.3f\n", e.t, e.value); break;
    case apex::EventType::IgnoredBeforeStart: Serial.printf("EVT,IGNORED,%.3f,gate=%d\n", e.t, e.index); break;
  }
}

void setup() {
  Serial.begin(115200);
  configureReceiver();
  Serial.println("APEX_CHRONO,V1,GNSS_READY,send track then END");
}

void loop() {
  if (!trackReady && Serial.available()) trackReady = parseTrack(Serial);

  while (GNSS.available()) {
    if (!gps.encode(GNSS.read())) continue;
    // One fix per new RMC/GGA position update with a valid time of fix.
    if (!gps.location.isUpdated() || !gps.time.isValid()) continue;
    apex::GnssFix f;
    f.t = fixTimeS();
    f.lat = gps.location.lat();
    f.lon = gps.location.lng();
    f.speedMs = gps.speed.isValid() ? gps.speed.mps() : NAN;
    f.courseDeg = gps.course.isValid() ? gps.course.deg() : NAN;
    f.sats = gps.satellites.isValid() ? (int)gps.satellites.value() : 0;
    f.hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.0;
    f.fixType = gps.location.isValid() ? 3 : 0;
    // Raw fix log (what will go to microSD): replayable through the host tools.
    Serial.printf("FIX,%.2f,%.8f,%.8f,%.2f,%.1f,%d,%.2f\n", f.t, f.lat, f.lon, f.speedMs, f.courseDeg, f.sats, f.hdop);
    if (!trackReady) continue;
    apex::Event ev[apex::MAX_EVENTS];
    const int n = engine.push(f, ev);
    for (int i = 0; i < n; i++) logEvent(ev[i]);
  }
}
