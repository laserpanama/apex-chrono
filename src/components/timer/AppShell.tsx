import { useEffect, useState } from "react";
import {
  Activity,
  Flag,
  Gauge,
  Map,
  Microchip,
  Pause,
  Play,
  RotateCcw,
  Satellite,
  ScrollText,
  Timer,
} from "lucide-react";
import { TRACKS } from "@/lib/timer/tracks";
import { startLoop, useSession, type Screen } from "@/lib/timer/store";
import { formatDelta, formatLap, formatSpeed } from "@/lib/timer/engine";
import { TrackMap } from "./TrackMap";

const NAV: { id: Screen; label: string; icon: typeof Gauge }[] = [
  { id: "dash", label: "Dash", icon: Gauge },
  { id: "map", label: "Map", icon: Map },
  { id: "sensors", label: "IMU", icon: Activity },
  { id: "laps", label: "Laps", icon: Flag },
  { id: "log", label: "Log", icon: ScrollText },
  { id: "build", label: "Build", icon: Microchip },
];

export function AppShell() {
  const s = useSession();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => startLoop(), []);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const delta = s.deltaS;
  const deltaTone =
    delta == null ? "text-muted" : delta < -0.02 ? "text-signal" : delta > 0.02 ? "text-delta" : "text-fg";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-3 pb-24 pt-3 sm:px-5 sm:pb-6 sm:pt-5">
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="label text-xs text-amber">Apex Chrono</p>
          <h1 className="font-display text-3xl leading-none font-semibold tracking-wide text-fg sm:text-4xl">
            {s.version === "v1" ? "Lap timer" : "Race dashboard"}
          </h1>
        </div>
        <div className="text-right">
          <p className="num text-sm text-fg">
            {now
              ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
              : "--:--:--"}
          </p>
          <p className="label text-[11px] text-muted">{s.track.place}</p>
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="bezel flex overflow-hidden rounded-md">
          {(["v1", "v2"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => s.setVersion(v)}
              className={`label min-h-11 px-4 text-sm ${
                s.version === v ? "bg-amber text-ink" : "bg-panel text-muted"
              }`}
            >
              {v === "v1" ? "V1 timer" : "V2 telemetry"}
            </button>
          ))}
        </div>
        <label className="bezel flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-fg">
          <span className="label text-[11px] text-muted">Track</span>
          <select
            value={s.track.id}
            onChange={(e) => {
              if (e.target.value !== s.track.id) s.setTrack(e.target.value);
            }}
            className="bg-transparent font-display text-base tracking-wide text-fg outline-none"
            aria-label="Track"
          >
            {TRACKS.map((t) => (
              <option key={t.id} value={t.id} className="bg-panel text-fg">
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="session-toggle"
            onClick={() => s.toggleRun()}
            className="label inline-flex min-h-11 items-center gap-2 rounded-md bg-amber px-4 text-sm text-ink"
          >
            {s.running ? <Pause size={16} /> : <Play size={16} />}
            {s.running ? "Hold" : s.elapsed > 0 ? "Resume" : "Start"}
          </button>
          <button
            type="button"
            onClick={() => s.reset()}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-line bg-panel text-fg"
            aria-label="Reset session"
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1">
        {s.screen === "dash" && <Dash deltaTone={deltaTone} />}
        {s.screen === "map" && <MapScreen />}
        {s.screen === "sensors" && <SensorScreen />}
        {s.screen === "laps" && <LapsScreen />}
        {s.screen === "log" && <LogScreen />}
        {s.screen === "build" && <BuildScreen />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 backdrop-blur sm:static sm:mt-4 sm:border-0 sm:bg-transparent sm:backdrop-blur-none">
        <ul className="mx-auto grid max-w-6xl grid-cols-6">
          {NAV.map((item) => {
            const Icon = item.icon;
            const on = s.screen === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => s.setScreen(item.id)}
                  className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] sm:min-h-11 sm:flex-row sm:gap-2 sm:rounded-md sm:text-sm ${
                    on ? "text-amber" : "text-muted"
                  }`}
                >
                  <Icon size={18} />
                  <span className="label">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function Dash({ deltaTone }: { deltaTone: string }) {
  const s = useSession();
  const showG = s.version === "v2";
  return (
    <section className="grid gap-3 lg:grid-cols-[1.4fr_0.8fr]">
      <div className="bezel relative overflow-hidden rounded-lg p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <p className="label text-xs text-muted">
            {s.armed ? `Lap ${String(s.lapNumber).padStart(2, "0")}` : "Out lap"}
          </p>
          <StatusPills />
        </div>
        <p className={`num mt-2 text-6xl leading-none text-fg sm:text-8xl ${s.flash === "LAP" ? "text-amber" : ""}`}>
          {s.armed ? formatLap(s.lapElapsed) : formatLap(null)}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat k="Delta" v={formatDelta(s.deltaS)} tone={deltaTone} big />
          <Stat k="Best" v={formatLap(s.bestS)} />
          <Stat k="Last" v={formatLap(s.lastS)} />
        </div>
        {s.flash && (
          <p className="label pointer-events-none absolute top-4 right-4 text-2xl text-amber">{s.flash}</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Speed</p>
          <p className="num mt-1 text-5xl leading-none text-amber">
            {s.running || s.armed ? formatSpeed(s.speedKmh) : "0"}
            <span className="ml-2 font-display text-lg tracking-widest text-muted">KM/H</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            Max <span className="num text-fg">{formatSpeed(s.maxSpeedKmh)}</span>
            <span className="mx-2 text-dim">\u00b7</span>
            Hdg <span className="num text-fg">{Math.round(s.heading)}\u00b0</span>
          </p>
        </div>
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">GPS \u00b7 BN-880 sim</p>
          <div className="mt-2 flex items-end justify-between">
            <p className="num text-3xl text-fg">
              {s.sats}
              <span className="ml-2 font-display text-sm tracking-widest text-muted">SAT</span>
            </p>
            <p className={`label text-sm ${s.gpsLock ? "text-signal" : "text-delta"}`}>
              {s.gpsLock ? "Lock" : "Search"}
            </p>
          </div>
          <p className="num mt-1 text-sm text-muted">
            10 Hz \u00b7 HDOP {s.hdop.toFixed(2)}
          </p>
          <p className="num mt-2 text-xs text-dim">
            {s.lat.toFixed(6)} , {s.lon.toFixed(6)}
          </p>
        </div>
      </div>

      {showG && (
        <div className="grid grid-cols-3 gap-3 lg:col-span-2">
          <GCard k="G-force" v={Math.hypot(s.gLong, s.gLat)} />
          <GCard k="Braking" v={Math.min(0, s.gLong)} />
          <GCard k="Lateral" v={s.gLat} />
        </div>
      )}

      <div className={`bezel rounded-lg p-4 ${showG ? "lg:col-span-2" : "lg:col-span-2"}`}>
        <div className="mb-2 flex items-center justify-between">
          <p className="label text-xs text-muted">Sectors</p>
          <p className="label text-xs text-amber">
            S{s.sectorIndex + 1} \u00b7 {formatLap(s.armed ? s.sectorClock : null)}
          </p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-3">
          {s.sectors.map((sec, i) => (
            <li
              key={sec.id}
              className={`rounded-md border px-3 py-2 ${
                i === s.sectorIndex && s.armed ? "border-amber bg-panel-2" : "border-line"
              }`}
            >
              <p className="label text-[11px] text-muted">
                S{sec.id} {sec.name}
              </p>
              <p className="num text-xl text-fg">{sec.timeS == null ? "\u2014" : sec.timeS.toFixed(3)}</p>
              <p className={`num text-xs ${tone(sec.deltaS)}`}>{formatDelta(sec.deltaS)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function MapScreen() {
  const s = useSession();
  return (
    <section className="grid gap-3 lg:grid-cols-[1.5fr_0.7fr]">
      <div className="bezel overflow-hidden rounded-lg">
        <TrackMap
          track={s.track}
          x={s.x}
          y={s.y}
          heading={s.heading}
          distM={s.distM}
          sectorIndex={s.sectorIndex}
          armed={s.armed}
          className="h-[52vh] min-h-72 w-full sm:h-[62vh]"
        />
      </div>
      <div className="flex flex-col gap-3">
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Live</p>
          <p className="num mt-1 text-4xl text-fg">{s.armed ? formatLap(s.lapElapsed) : "OUT"}</p>
          <p className={`num mt-1 text-2xl ${tone(s.deltaS)}`}>{formatDelta(s.deltaS)}</p>
          <p className="mt-3 text-sm text-muted">
            Predictive delta compares distance along the centerline with the reference lap. Positive means
            you are behind that lap at this point.
          </p>
        </div>
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Start / finish</p>
          <p className="mt-1 text-sm text-fg">
            First crossing arms the clock. Every later crossing closes the lap and opens the next.
          </p>
          <p className="num mt-3 text-sm text-dim">
            {(s.distM / s.lengthM * 100).toFixed(0)}% of { (s.lengthM / 1000).toFixed(2) } km
          </p>
        </div>
      </div>
    </section>
  );
}

function LapsScreen() {
  const s = useSession();
  const best = s.bestS;
  return (
    <section className="bezel overflow-hidden rounded-lg">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="label text-xs text-muted">Session laps</p>
        <p className="num text-sm text-fg">{s.laps.length} complete</p>
      </div>
      {s.laps.length === 0 ? (
        <p className="px-4 py-10 text-sm text-muted">
          No flying laps yet. Hit Out lap, then cross start/finish to open lap 1.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="label text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Lap</th>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Delta</th>
                {s.track.sectors.map((sec) => (
                  <th key={sec.id} className="px-3 py-2 font-medium">
                    S{sec.id}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">Max</th>
              </tr>
            </thead>
            <tbody>
              {[...s.laps].reverse().map((lap) => {
                const d = best == null ? null : lap.timeS - best;
                const isBest = best != null && Math.abs(lap.timeS - best) < 0.0005;
                return (
                  <tr key={lap.number} className="border-b border-line/70">
                    <td className="num px-4 py-2.5 text-fg">{String(lap.number).padStart(2, "0")}</td>
                    <td className={`num px-3 py-2.5 ${isBest ? "text-amber" : "text-fg"}`}>
                      {formatLap(lap.timeS)}
                    </td>
                    <td className={`num px-3 py-2.5 ${tone(isBest ? 0 : d)}`}>
                      {isBest ? "BEST" : formatDelta(d)}
                    </td>
                    {lap.splits.map((sp, i) => (
                      <td key={i} className="num px-3 py-2.5 text-muted">
                        {sp.toFixed(3)}
                      </td>
                    ))}
                    <td className="num px-3 py-2.5 text-fg">{formatSpeed(lap.maxSpeedKmh)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LogScreen() {
  const s = useSession();
  const rows = s.log.slice(-12).reverse();
  const download = () => {
    const csv = s.exportCsv();
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `apex-chrono-${s.track.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="grid gap-3 lg:grid-cols-[1fr_18rem]">
      <div className="bezel overflow-hidden rounded-lg">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="label text-xs text-muted">MicroSD stream \u00b7 10 Hz</p>
          <p className="num text-sm text-fg">{s.log.length} samples</p>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-sm text-muted">Logging starts when the car is rolling.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r, i) => (
              <li key={`${r.t}-${i}`} className="grid grid-cols-4 gap-2 px-4 py-2 text-xs sm:text-sm">
                <span className="num text-muted">{r.t.toFixed(1)}s</span>
                <span className="num text-fg">{r.speedKmh.toFixed(0)} km/h</span>
                <span className="num text-dim">{r.lat.toFixed(5)}</span>
                <span className="num text-dim">{r.lon.toFixed(5)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="bezel flex flex-col gap-3 rounded-lg p-4">
        <p className="label text-xs text-muted">Session file</p>
        <p className="text-sm text-fg">
          CSV holds GNSS samples and closed laps \u2014 the same columns a V1 MicroSD logger would write.
        </p>
        <button
          type="button"
          onClick={download}
          className="label mt-auto inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-panel-2 px-4 text-sm text-fg"
        >
          Download CSV
        </button>
      </div>
    </section>
  );
}

const BOM = [
  { part: "ESP32-S3 + 3.5\\" 320\u00d7480", cost: "25\u201331", note: "Display, flash, PSRAM, touch" },
  { part: "BN-880 GNSS 10 Hz", cost: "10\u201315", note: "Position, speed, sats" },
  { part: "12V\u21925V 3A buck", cost: "~8", note: "V1 prototype power" },
  { part: "32 GB microSD", cost: "~6", note: "Session logs" },
  { part: "Fuse + holder", cost: "~3", note: "Inline protection" },
  { part: "Wiring / connectors", cost: "~6", note: "Vehicle install" },
  { part: "Box + dash mount", cost: "~12", note: "Enclosure" },
];

function BuildScreen() {
  const s = useSession();
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <article className="bezel rounded-lg p-4 sm:p-5">
        <p className="label text-xs text-amber">V1 \u00b7 prove the chain</p>
        <h2 className="font-display mt-1 text-3xl leading-none text-fg">How fast was the lap?</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          GPS into the ESP32-S3, start/finish detection, lap and sector times on the 3.5" dash, CSV on
          MicroSD. Target about $90 delivered to Miami, $100 ceiling. This preview is that firmware\u2019s
          cockpit, driven by a simulated 10 Hz fix.
        </p>
        <ol className="mt-4 space-y-2 text-sm text-fg">
          {[
            "GNSS lock at ~10 Hz",
            "Start/finish and sector gates",
            "Current, last, best, basic delta",
            "Speed, sats, HDOP",
            "MicroSD CSV",
          ].map((line, i) => (
            <li key={line} className="flex gap-3">
              <span className="num text-amber">{String(i + 1).padStart(2, "0")}</span>
              {line}
            </li>
          ))}
        </ol>
      </article>
      <article className="bezel rounded-lg p-4 sm:p-5">
        <p className="label text-xs text-muted">V1 shopping list</p>
        <ul className="mt-3 divide-y divide-line">
          {BOM.map((row) => (
            <li key={row.part} className="flex items-baseline justify-between gap-3 py-2">
              <div>
                <p className="text-sm text-fg">{row.part}</p>
                <p className="text-xs text-dim">{row.note}</p>
              </div>
              <p className="num shrink-0 text-sm text-amber">${row.cost}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          Parts ~$70\u201381 \u00b7 ship ~$10\u201315 \u00b7 working target <span className="text-fg">$90</span>.
        </p>
      </article>
      <article className="bezel rounded-lg p-4 sm:p-5 lg:col-span-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="label text-xs text-signal">V2 \u00b7 why the lap changed</p>
            <h2 className="font-display mt-1 text-3xl leading-none text-fg">Where time was made or lost</h2>
          </div>
          <button
            type="button"
            onClick={() => s.setVersion(s.version === "v2" ? "v1" : "v2")}
            className="label min-h-11 rounded-md bg-panel-2 px-4 text-sm text-fg ring-1 ring-line"
          >
            {s.version === "v2" ? "IMU sensors on" : "Open IMU sensors"}
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Roadmap k="V1" d="$85\u2013100" t="GPS lap timer. Prove detection, display, logging." />
          <Roadmap k="V1.5" d="$120\u2013160" t="Track box: better power, antenna, IMU, mounts." />
          <Roadmap k="V2" d="$160\u2013200" t="IMU, live delta, sectors, braking and corner story." />
        </div>
        <p className="mt-4 flex items-start gap-2 text-sm text-muted">
          <Timer size={16} className="mt-0.5 shrink-0 text-amber" />
          Do not start at V2. Run V1 on a real lap, then spend the next dollars on GNSS, IMU, and power \u2014 not a bigger screen.
        </p>
      </article>
    </section>
  );
}

function SensorScreen() {
  const s = useSession();
  const live = s.version === "v2";
  const gx = live ? s.gLong : 0;
  const gy = live ? s.gLat : 0;
  const gz = live ? 1 + Math.sin(s.distM * 0.22) * (s.running ? 0.045 : 0) : 0;
  const speed = s.speedKmh / 3.6;
  const yaw = live && speed > 1.5 ? ((gy * 9.81) / speed) * (180 / Math.PI) : 0;
  const roll = live ? Math.atan(gy) * (180 / Math.PI) : 0;
  const pitch = live ? Math.atan(-gx) * (180 / Math.PI) : 0;
  const combined = Math.hypot(gx, gy);

  return (
    <section className="grid gap-3 lg:grid-cols-[18rem_1fr]">
      <div className="bezel rounded-lg p-4">
        <div className="flex items-center justify-between">
          <p className="label text-xs text-muted">G-meter</p>
          <p className={`label text-xs ${live ? "text-signal" : "text-dim"}`}>{live ? "IMU live" : "IMU off"}</p>
        </div>
        <GMeter longG={gx} latG={gy} />
        <p className="num text-center text-4xl leading-none text-amber">
          {signed(combined, 2)}
          <span className="ml-2 font-display text-sm tracking-widest text-muted">G</span>
        </p>
        <p className="mt-2 text-center text-sm text-muted">
          {live
            ? "Dot is chassis load. Up is acceleration, down is braking, sideways is the corner."
            : "V1 is GPS only. Turn on V2 telemetry to read the 6-axis IMU."}
        </p>
        {!live && (
          <button
            type="button"
            onClick={() => s.setVersion("v2")}
            className="label mt-3 min-h-11 w-full rounded-md bg-amber text-sm text-ink"
          >
            Enable V2 IMU
          </button>
        )}
      </div>

      <div className="grid gap-3">
        <div className="grid grid-cols-3 gap-2">
          <GCard k="Long" v={gx} />
          <GCard k="Braking" v={Math.min(0, gx)} />
          <GCard k="Lateral" v={gy} />
        </div>
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Accelerometer</p>
          <ul className="mt-3 grid gap-3">
            <Axis k="X" hint="Longitudinal" v={gx} unit="G" min={-2} max={2} />
            <Axis k="Y" hint="Lateral" v={gy} unit="G" min={-2} max={2} />
            <Axis k="Z" hint="Vertical" v={gz} unit="G" min={0} max={2} />
          </ul>
        </div>
        <div className="bezel rounded-lg p-4">
          <p className="label text-xs text-muted">Gyroscope</p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3 sm:gap-4">
            <Gyro k="Yaw" hint="Rate" v={yaw} unit="\u00b0/s" />
            <Gyro k="Roll" hint="From lateral G" v={roll} unit="\u00b0" />
            <Gyro k="Pitch" hint="From long G" v={pitch} unit="\u00b0" />
          </ul>
        </div>
      </div>
    </section>
  );
}

function GMeter({ longG, latG }: { longG: number; latG: number }) {
  const x = Math.max(-1, Math.min(1, latG / 2));
  const y = Math.max(-1, Math.min(1, -longG / 2));
  const cx = 100 + x * 68;
  const cy = 100 + y * 68;
  return (
    <svg viewBox="0 0 200 200" className="mx-auto my-2 aspect-square w-full max-w-56" role="img" aria-label="G-force meter">
      <circle cx="100" cy="100" r="78" fill="var(--color-bg-2)" stroke="var(--color-line)" />
      <circle cx="100" cy="100" r="39" fill="none" stroke="var(--color-line)" />
      <path d="M100 22 V178 M22 100 H178" stroke="var(--color-line-strong)" />
      <circle cx={cx} cy={cy} r="8" fill="var(--color-amber)" />
      <text x="112" y="46" fill="var(--color-dim)" fontSize="11" fontFamily="Barlow Condensed, sans-serif">
        ACCEL
      </text>
      <text x="112" y="162" fill="var(--color-dim)" fontSize="11" fontFamily="Barlow Condensed, sans-serif">
        BRAKE
      </text>
    </svg>
  );
}

function Axis({
  k,
  hint,
  v,
  unit,
  min,
  max,
}: {
  k: string;
  hint: string;
  v: number;
  unit: string;
  min: number;
  max: number;
}) {
  const pct = ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <p className="label text-xs text-muted">
          {k} <span className="tracking-normal text-dim">{hint}</span>
        </p>
        <p className={`num text-lg ${v < -0.12 ? "text-delta" : v > 0.12 ? "text-signal" : "text-fg"}`}>
          {signed(v, 2)} {unit}
        </p>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg">
        <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

function Gyro({ k, hint, v, unit }: { k: string; hint: string; v: number; unit: string }) {
  return (
    <li>
      <p className="label text-xs text-muted">{k}</p>
      <p className="num text-2xl text-fg">
        {signed(v, 1)}
        <span className="ml-1 font-display text-xs tracking-widest text-muted">{unit}</span>
      </p>
      <p className="text-xs text-dim">{hint}</p>
    </li>
  );
}

function signed(v: number, digits: number) {
  if (!Number.isFinite(v)) return "0";
  const body = Math.abs(v).toFixed(digits);
  if (Math.abs(v) < 0.005) return body;
  return `${v > 0 ? "+" : "\u2212"}${body}`;
}

function StatusPills() {
  const s = useSession();
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 text-xs ${s.running ? "text-signal" : "text-muted"}`}>
        <span className={`size-2 rounded-full ${s.running ? "bg-signal" : "bg-dim"}`} />
        <span className="label">{s.running ? "Rec" : "Idle"}</span>
      </span>
      <Satellite size={14} className={s.gpsLock ? "text-signal" : "text-delta"} />
    </div>
  );
}

function Stat({ k, v, tone, big }: { k: string; v: string; tone?: string; big?: boolean }) {
  return (
    <div>
      <p className="label text-[11px] text-muted">{k}</p>
      <p className={`num mt-1 ${big ? "text-3xl sm:text-4xl" : "text-xl sm:text-2xl"} ${tone ?? "text-fg"}`}>{v}</p>
    </div>
  );
}

function GCard({ k, v }: { k: string; v: number }) {
  const clamped = Math.max(-2, Math.min(2, v));
  const pct = ((clamped + 2) / 4) * 100;
  return (
    <div className="bezel rounded-lg p-3">
      <p className="label text-[11px] text-muted">{k}</p>
      <p className={`num mt-1 text-2xl ${v < -0.15 ? "text-delta" : v > 0.15 ? "text-signal" : "text-fg"}`}>
        {v >= 0 ? "+" : ""}
        {v.toFixed(2)}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg">
        <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Roadmap({ k, d, t }: { k: string; d: string; t: string }) {
  return (
    <div className="rounded-md border border-line bg-bg-2 p-3">
      <p className="label text-xs text-amber">{k}</p>
      <p className="num mt-1 text-lg text-fg">{d}</p>
      <p className="mt-1 text-sm text-muted">{t}</p>
    </div>
  );
}

function tone(delta: number | null) {
  if (delta == null) return "text-muted";
  if (delta < -0.02) return "text-signal";
  if (delta > 0.02) return "text-delta";
  return "text-fg";
}
