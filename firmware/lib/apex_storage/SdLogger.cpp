#include "SdLogger.h"

#include <cstdio>

namespace apex {

bool SdLogger::begin(int csPin, SPIClass& spi, int sckPin, int misoPin, int mosiPin) {
  spi.begin(sckPin, misoPin, mosiPin, csPin);
  cardPresent_ = SD.begin(csPin, spi);
  return cardPresent_;  // false is NOT fatal: caller keeps running without SD
}

bool SdLogger::openSessionFile(const SessionDate& date) {
  if (!cardPresent_) return false;
  char base[24];
  if (date.valid) {
    // Contract §6: APEX_YYYYMMDD_HHMM.CSV, UTC.
    std::snprintf(base, sizeof base, "APEX_%04u%02u%02u_%02u%02u", date.year, date.month, date.day,
                  date.hour, date.minute);
  } else {
    // Honest fallback: no GNSS date decoded yet (rare — RMC usually carries
    // date and time together). Never block waiting for one.
    std::snprintf(base, sizeof base, "APEX_NODATE_%lu", static_cast<unsigned long>(millis()));
  }
  bool opened = false;
  for (int n = 0; n < 20 && !opened; n++) {
    if (n == 0) std::snprintf(fileName_, sizeof fileName_, "/%s.CSV", base);
    else std::snprintf(fileName_, sizeof fileName_, "/%s_%d.CSV", base, n + 1);
    if (SD.exists(fileName_)) continue;
    file_ = SD.open(fileName_, FILE_WRITE);
    opened = static_cast<bool>(file_);
  }
  if (!opened) return false;
  char header[128];
  int len = std::snprintf(header, sizeof header, "# apex-chrono gnss v1\n# firmware=v1.5\n# receiver=BN-880Q\n");
  safeWrite(header, static_cast<size_t>(len));
  if (date.valid) {
    len = std::snprintf(header, sizeof header, "# date=%04u-%02u-%02u\n", date.year, date.month, date.day);
    safeWrite(header, static_cast<size_t>(len));
  }
  len = std::snprintf(header, sizeof header, "%s\n", kRecordingHeader);
  safeWrite(header, static_cast<size_t>(len));
  fileOpen_ = true;
  return true;
}

void SdLogger::safeWrite(const char* data, size_t len) {
  if (!cardPresent_ || gaveUp_) return;
  const size_t written = file_.write(reinterpret_cast<const uint8_t*>(data), len);
  if (written != len) {
    failures_++;
    consecutive_++;
    if (consecutive_ >= kFailBeforeStop) {
      // Dead card: stop retrying every row (saves CPU/SPI time); timing is
      // unaffected either way, this only turns storage off for the session.
      gaveUp_ = true;
      file_.close();
      fileOpen_ = false;
    }
    return;
  }
  consecutive_ = 0;
}

void SdLogger::logRow(const ContractRow& row, const SessionDate& date) {
  if (!cardPresent_ || gaveUp_) return;
  if (!fileOpen_ && !openSessionFile(date)) return;  // retried again on the next row automatically
  char line[160];
  const int len = formatContractRow(row, line, sizeof line);
  if (len <= 0 || static_cast<size_t>(len) >= sizeof(line) - 1) return;  // malformed/overflow: drop, don't corrupt
  line[len] = '\n';
  safeWrite(line, static_cast<size_t>(len + 1));
  if (fileOpen_) {
    rowsLogged_++;
    if (++rowsSinceFlush_ >= kFlushEveryNRows) {
      file_.flush();
      rowsSinceFlush_ = 0;
    }
  }
}

void SdLogger::flush() {
  if (fileOpen_) file_.flush();
}

}  // namespace apex
