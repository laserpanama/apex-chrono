# Apex Chrono

Pit-wall dashboard for an ESP32-S3 lap timer. This preview runs the V1 timing chain on a simulated 10 Hz GNSS fix, and the V2 IMU board (accelerometer, gyro, brake, and corner load) before any hardware is on the car.

## What it does

- Out-lap, then start/finish and sector gates
- Live lap, best, last, and predictive delta
- Speed, satellites, and HDOP
- Track map for Club Circuit, Marina Street, and Pacific Ring
- Session lap sheet and a MicroSD-style CSV download
- V2 chassis sensors: G-meter, longitudinal / lateral / vertical acceleration, yaw, roll, and pitch

## Run

```bash
npm install
npm run dev
```

The dev server listens on port 8080.

V1 is the lap timer. **V2 telemetry** opens the IMU screen. **Start** rolls the car onto the stripe.
