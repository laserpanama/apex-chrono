import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, Play, Smartphone, Square, Upload } from "lucide-react";
import { PhoneSession, PHONE_WARMUP_FIXES } from "@/lib/gnss/phone";
import { DragFlag, distanceLabel, flagNames, speedLabel, type DragRun } from "@/lib/gnss/drag";
import { parseTrackFile } from "@/lib/gnss/track-file";
import { compileTrack, type CompiledTrack } from "@/lib/gnss/track";
import { formatLap } from "@/lib/timer/engine";

type RunState = "idle" | "running" | "stopped";
type MotionState = "off" | "on" | "denied" | "unsupported";

const s2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const kmh = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : Math.round(x).toString();

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

type WakeLockLike = { release: () => Promise<void> };

export function PhoneScreen() {
  const session = useRef<PhoneSession | null>(null);
  const watchId = useRef<number | null>(null);
  const wake = useRef<WakeLockLike | null>(null);
  const pendingTrack = useRef<{ track: CompiledTrack; name: string } | null>(null);
  const [state, setState] = useState<RunState>("idle");
  const [motion, setMotion] = useState<MotionState>("off");
  const [error, setError] = useState<string | null>(null);
  const [trackInfo, setTrackInfo] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  // 10 Hz screen refresh while recording; sensors arrive at their own rate.
  useEffect(() => {
    if (state !== "running") return;
    const id = setInterval(redraw, 100);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  const requestWake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<WakeLockLike> };
      };
      wake.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      wake.current = null;
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && state === "running") void requestWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [state, requestWake]);

  const onMotion = useCallback((e: DeviceMotionEvent) => {
    session.current?.ingestMotion({
      tMs: performance.timeOrigin + e.timeStamp,
      acc: e.acceleration,
      accG: e.accelerationIncludingGravity,
      rot: e.rotationRate,
    });
  }, []);

  // Release sensors and the wake lock. No state updates: also runs on unmount.
  const teardown = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    window.removeEventListener("devicemotion", onMotion);
    void wake.current?.release().catch(() => {});
    wake.current = null;
  }, [onMotion]);

  const stop = useCallback(() => {
    teardown();
    const fin = session.current?.finish();
    const end = fin?.drag.find((e) => e.type === "end");
    if (end && end.type === "end") setToast(`Run #${end.run.number} closed`);
    setState("stopped");
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    if (!window.isSecureContext) {
      setError("Sensors need HTTPS. Open the published site, not a local http:// address.");
      return;
    }
    if (!("geolocation" in navigator)) {
      setError("This browser has no Geolocation.");
      return;
    }
    const ps = new PhoneSession();
    if (pendingTrack.current) ps.setTrack(pendingTrack.current.track, pendingTrack.current.name);
    session.current = ps;

    // Motion: iOS asks permission from a user gesture; Android just works.
    const DME = (
      window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }
    ).DeviceMotionEvent;
    if (!DME) setMotion("unsupported");
    else {
      try {
        const ok = DME.requestPermission ? (await DME.requestPermission()) === "granted" : true;
        if (ok) {
          window.addEventListener("devicemotion", onMotion);
          setMotion("on");
        } else setMotion("denied");
      } catch {
        setMotion("denied");
      }
    }

    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const u = ps.ingestPosition(p);
        for (const e of u.drag) {
          if (e.type === "armed") setToast("READY — launch");
          if (e.type === "speed")
            setToast(`${speedLabel(ps.drag!.cfg.speedTargetsKmh[e.index])}  ${s2(e.timeS)} s`);
          if (e.type === "distance")
            setToast(`${distanceLabel(ps.drag!.cfg.distanceTargetsM[e.index])}  ${s2(e.timeS)} s`);
          if (e.type === "end") setToast(`Run #${e.run.number} ${e.run.valid ? "" : "(invalid)"}`);
        }
        for (const e of u.laps) {
          if (e.type === "lap") setToast(`LAP ${e.record.number}  ${formatLap(e.record.timeS)}`);
          if (e.type === "lap_start") setToast("Lap started");
        }
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Allow precise location for this site and try again."
            : `Location error: ${err.message}`,
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    await requestWake();
    setState("running");
  }, [onMotion, requestWake]);

  const onTrackFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const ct = compileTrack(parseTrackFile(await file.text(), file.name));
      pendingTrack.current = { track: ct, name: file.name };
      session.current?.setTrack(ct, file.name);
      setTrackInfo(
        `${file.name} · ${(ct.centerline.lengthM / 1000).toFixed(2)} km · ${ct.gates.length} gate(s)`,
      );
      setError(null);
    } catch (e) {
      setError(`Track file: ${(e as Error).message}`);
    }
  }, []);

  const ps = session.current;
  const last = ps?.lastRow ?? null;
  const hz = ps?.gnssRate.hz() ?? NaN;
  const imuHz = ps?.imuRate.hz() ?? NaN;
  const ageS = last ? Math.max(0, (Date.now() - last.timestampMs) / 1000) : NaN;
  const lowRate = ps && ps.rows.length >= PHONE_WARMUP_FIXES && hz < 5;
  const noSpeed = ps && ps.rows.length >= 3 && ps.rows.slice(-3).every((r) => r.speedKmh === null);
  const accOk = last ? last.hdop <= (ps?.maxAccuracyM ?? 10) : false;
  const lastImu = ps?.imu.length ? ps.imu[ps.imu.length - 1] : null;
  const gNow = lastImu ? Math.hypot(lastImu.ax, lastImu.ay, lastImu.az) / 9.80665 : NaN;

  const drag = ps?.drag ?? null;
  const dragLive =
    drag && drag.state === "running" && Number.isFinite(drag.elapsedS())
      ? drag.elapsedS() + (Number.isFinite(ageS) ? Math.min(ageS, 2) : 0)
      : NaN;
  const lastRun: DragRun | undefined = drag?.lastRun;

  const lap = ps?.lap ?? null;
  // Clock from the newest fix (plus up to 2 s of wall time), so a phone whose
  // fix timestamps are skewed from its wall clock still shows a sane lap time.
  const liveT = last
    ? last.timestampMs / 1000 + (Number.isFinite(ageS) ? Math.min(ageS, 2) : 0)
    : NaN;
  const live = lap && last ? lap.live(liveT) : null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-3 px-3 pb-10 pt-3 sm:px-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <Link to="/" className="label inline-flex min-h-9 items-center gap-1 text-xs text-muted">
            <ArrowLeft size={14} /> Cockpit
          </Link>
          <h1 className="font-display text-3xl leading-none font-semibold tracking-wide text-fg">
            Phone mode
          </h1>
        </div>
        <Smartphone className="text-amber" size={28} />
      </header>

      <p className="text-sm text-muted">
        Uses this phone's GPS and motion sensors with the same timing engines as the device. Results
        depend on the rate your phone delivers — it is measured below. Closed course or drag strip
        only.
      </p>

      <div className="flex gap-2">
        {state !== "running" ? (
          <button
            type="button"
            onClick={() => void start()}
            className="label inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md bg-amber px-4 text-base text-ink"
          >
            <Play size={18} /> {state === "stopped" ? "New session" : "Start sensors"}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="label inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-md bg-delta px-4 text-base text-fg"
          >
            <Square size={18} /> Stop
          </button>
        )}
      </div>

      {error && <p className="bezel rounded-md border-delta p-3 text-sm text-delta">{error}</p>}
      {toast && (
        <p className="label fixed inset-x-3 top-3 z-30 rounded-md bg-amber p-3 text-center text-lg text-ink">
          {toast}
        </p>
      )}

      {/* Receiver */}
      <section className="grid grid-cols-2 gap-3">
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Speed</p>
          <p className="num mt-1 text-5xl leading-none text-amber">
            {kmh(last?.speedKmh)}
            <span className="ml-2 font-display text-lg tracking-widest text-muted">KM/H</span>
          </p>
        </div>
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">GPS</p>
          <p className={`num mt-1 text-3xl leading-none ${hz >= 5 ? "text-signal" : "text-fg"}`}>
            {Number.isFinite(hz) ? hz.toFixed(1) : "—"}
            <span className="ml-1 font-display text-sm tracking-widest text-muted">HZ</span>
          </p>
          <p className="num mt-2 text-xs text-muted">
            ±{last ? last.hdop.toFixed(1) : "—"} m{" "}
            <span className={accOk ? "text-signal" : "text-delta"}>
              {last ? (accOk ? "ok" : "poor") : ""}
            </span>
            {" · "}
            {ps?.rows.length ?? 0} fixes
            {Number.isFinite(ageS) && ageS > 2 ? (
              <span className="text-delta"> · {ageS.toFixed(0)} s old</span>
            ) : null}
          </p>
        </div>
      </section>

      {lowRate && (
        <p className="bezel rounded-md p-3 text-sm text-amber">
          This phone delivers {hz.toFixed(1)} Hz (the device runs 10 Hz). Drag launches will be
          flagged invalid and lap times are rough. Record anyway: the CSV shows exactly what the
          phone gave.
        </p>
      )}
      {noSpeed && (
        <p className="bezel rounded-md p-3 text-sm text-delta">
          The phone is not reporting speed. Drag timing needs it; it usually appears once moving
          with a clear sky view.
        </p>
      )}

      {/* Drag */}
      <section className="bezel rounded-lg p-4">
        <div className="flex items-center justify-between">
          <p className="label text-xs text-muted">Drag</p>
          <p
            className={`label text-sm ${
              !drag
                ? "text-muted"
                : drag.state === "armed"
                  ? "text-signal"
                  : drag.state === "running"
                    ? "text-amber"
                    : "text-fg"
            }`}
          >
            {!drag
              ? state === "running"
                ? `Measuring rate… ${ps?.rows.length ?? 0}/${PHONE_WARMUP_FIXES}`
                : "Off"
              : drag.state === "armed"
                ? "Ready — go"
                : drag.state === "running"
                  ? "Run"
                  : "Stop 1 s to arm"}
          </p>
        </div>
        <p className="num mt-2 text-6xl leading-none text-fg">
          {drag?.state === "running"
            ? formatLap(dragLive)
            : lastRun
              ? s2(lastRun.speedTimesS[2])
              : "—"}
        </p>
        <p className="label mt-1 text-xs text-muted">
          {drag?.state === "running"
            ? "Elapsed"
            : lastRun
              ? `0-100 km/h · run #${lastRun.number}`
              : "0-100 km/h"}
        </p>
        {lastRun && (
          <>
            {!lastRun.valid && (
              <p className="mt-2 text-sm text-delta">
                Invalid: {flagNames(lastRun.flags).join(", ")}
                {lastRun.flags & DragFlag.lateLaunch
                  ? " (launch between fixes — rate too low)"
                  : ""}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {drag!.cfg.speedTargetsKmh.map((k, i) => (
                <div key={`s${k}`} className="flex justify-between">
                  <dt className="text-muted">{speedLabel(k)}</dt>
                  <dd className="num text-fg">{s2(lastRun.speedTimesS[i])}</dd>
                </div>
              ))}
              {drag!.cfg.distanceTargetsM.map((m, i) => (
                <div key={`d${m}`} className="flex justify-between">
                  <dt className="text-muted">{distanceLabel(m)}</dt>
                  <dd className="num text-fg">
                    {s2(lastRun.distanceTimesS[i])}
                    {Number.isFinite(lastRun.trapKmh[i]) ? (
                      <span className="text-muted"> @{Math.round(lastRun.trapKmh[i])}</span>
                    ) : null}
                  </dd>
                </div>
              ))}
              {drag!.cfg.rangesKmh.map(([lo, hi], i) => (
                <div key={`r${lo}`} className="flex justify-between">
                  <dt className="text-muted">
                    {lo}-{hi} km/h
                  </dt>
                  <dd className="num text-fg">{s2(lastRun.rangeTimesS[i])}</dd>
                </div>
              ))}
              <div className="flex justify-between">
                <dt className="text-muted">Peak</dt>
                <dd className="num text-fg">{kmh(lastRun.peakKmh)}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      {/* Laps */}
      <section className="bezel rounded-lg p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="label text-xs text-muted">Laps</p>
          <label className="label inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-line px-3 text-xs text-fg">
            <Upload size={14} /> {trackInfo ? "Change track" : "Load .track"}
            <input
              type="file"
              accept=".track,text/plain"
              className="sr-only"
              onChange={(e) => void onTrackFile(e.target.files?.[0])}
            />
          </label>
        </div>
        {trackInfo ? <p className="num mt-1 text-xs text-muted">{trackInfo}</p> : null}
        {lap && live ? (
          <>
            <p className="num mt-2 text-6xl leading-none text-fg">
              {live.phase === "in_lap" ? formatLap(live.lapElapsedS) : formatLap(null)}
            </p>
            <p className="label mt-1 text-xs text-muted">
              {live.phase === "in_lap" ? `Lap ${live.lapNumber}` : "Out lap — cross start/finish"}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <p>
                <span className="text-muted">Last </span>
                <span className="num text-fg">{formatLap(live.previousLap?.timeS ?? null)}</span>
              </p>
              <p>
                <span className="text-muted">Best </span>
                <span className="num text-signal">{formatLap(live.bestLap?.timeS ?? null)}</span>
              </p>
            </div>
            {lap.laps.length > 0 && (
              <ol className="mt-3 space-y-1 text-sm">
                {lap.laps
                  .slice()
                  .reverse()
                  .map((l) => (
                    <li key={l.number} className="flex justify-between border-t border-line pt-1">
                      <span className="text-muted">#{l.number}</span>
                      <span className={`num ${l.valid ? "text-fg" : "text-delta"}`}>
                        {formatLap(l.timeS)}
                        {l.valid ? "" : " ✕"}
                      </span>
                    </li>
                  ))}
              </ol>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Load the circuit's .track file (the same one the device uses) to time laps. Drag needs
            no track.
          </p>
        )}
      </section>

      {/* IMU */}
      <section className="bezel rounded-lg p-4">
        <div className="flex items-center justify-between">
          <p className="label text-xs text-muted">Motion sensors</p>
          <p className="label text-xs text-muted">
            {motion === "on"
              ? `${Number.isFinite(imuHz) ? imuHz.toFixed(0) : "—"} Hz`
              : motion === "denied"
                ? "Denied"
                : motion === "unsupported"
                  ? "Not available"
                  : "Off"}
          </p>
        </div>
        <p className="num mt-1 text-3xl text-fg">
          {Number.isFinite(gNow) ? gNow.toFixed(2) : "—"}
          <span className="ml-1 font-display text-sm tracking-widest text-muted">G</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          Logged for later analysis; not used for timing (as on the device).
        </p>
      </section>

      {/* Export */}
      <section className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!ps?.rows.length}
          onClick={() =>
            ps && download(`APEX_PHONE_${stamp(ps.startedMs)}.CSV`, ps.gnssCsv(navigator.userAgent))
          }
          className="label inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-panel text-sm text-fg disabled:opacity-40"
        >
          <Download size={16} /> GPS CSV
        </button>
        <button
          type="button"
          disabled={!ps?.imu.length}
          onClick={() => ps && download(`APEX_PHONE_${stamp(ps.startedMs)}_IMU.CSV`, ps.imuCsv())}
          className="label inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-panel text-sm text-fg disabled:opacity-40"
        >
          <Download size={16} /> IMU CSV
        </button>
      </section>
      <p className="text-xs text-dim">
        The GPS CSV replays on the desktop with the same engines: npm run replay:gps --
        APEX_PHONE_….CSV (add --track-file for laps). Keep this screen on and the phone mounted with
        a clear sky view.
      </p>
    </div>
  );
}
