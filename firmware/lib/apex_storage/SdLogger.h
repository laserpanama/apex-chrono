#pragma once
// Apex Chrono V1.5 — microSD raw GNSS logger (contract §6 CSV from Task 2).
//
// This is purely an OBSERVER of the GNSS stream. SD failure — missing card,
// a write error, a full card — is counted and NEVER blocks, retries
// indefinitely, or stops the timing loop. Call logRow() AFTER the fix has
// already been pushed to TimerService, and never let its outcome influence
// whether/when that push happens.

#include <Arduino.h>
#include <SD.h>
#include <SPI.h>

#include "GnssContractRow.h"

namespace apex {

class SdLogger {
 public:
  // `spi` must stay valid for the logger's lifetime. Returns false if no
  // card is present/initializable — the caller MUST keep running without
  // storage in that case (logRow() below simply becomes a no-op).
  bool begin(int csPin, SPIClass& spi, int sckPin, int misoPin, int mosiPin);

  // Record one contract row. The session file is opened lazily on the first
  // row (so its name can use the real UTC date/time once GNSS has one — see
  // `date`); until then, or if the card is absent/dead, this is a cheap
  // no-op. Never blocks for long and never throws/aborts.
  void logRow(const ContractRow& row, const SessionDate& date);

  void flush();

  bool cardPresent() const { return cardPresent_; }
  bool fileOpen() const { return fileOpen_; }
  uint32_t failures() const { return failures_; }     // cumulative, never reset
  uint32_t rowsLogged() const { return rowsLogged_; }
  const char* fileName() const { return fileName_; }

 private:
  bool openSessionFile(const SessionDate& date);
  void safeWrite(const char* data, size_t len);

  File file_;
  bool cardPresent_ = false;
  bool fileOpen_ = false;
  bool gaveUp_ = false;           // dead card: stop retrying every row
  uint32_t failures_ = 0;         // cumulative sink failures
  uint32_t consecutive_ = 0;      // consecutive failures, drives the give-up threshold
  uint32_t rowsLogged_ = 0;
  uint32_t rowsSinceFlush_ = 0;
  char fileName_[40] = "";
  static constexpr uint32_t kFailBeforeStop = 10;  // generous: a flaky card gets many retries first
  static constexpr uint32_t kFlushEveryNRows = 20; // balance durability vs. write wear/latency
};

}  // namespace apex
