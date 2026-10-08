import { create } from "zustand";
import { SessionEngine, csvFor, type LapRecord, type Sample, type SectorSplit } from "./engine";
import { TRACKS, getTrack, type TrackDef } from "./tracks";

export type Screen = "dash" | "map" | "sensors" | "laps" | "log" | "build";

type Snapshot = {
  running: boolean;
  armed: boolean;
  lapNumber: number;
  lapElapsed: number;
  elapsed: number;
  bestS: number | null;
  lastS: number | null;
  deltaS: number | null;
  speedKmh: number;
  maxSpeedKmh: number;
  heading: number;
  sats: number;
  hdop: number;
  gLong: number;
  gLat: number;
  lat: number;
  lon: number;
  distM: number;
  lengthM: number;
  sectorIndex: number;
  sectorClock: number;
  sectors: SectorSplit[];
  laps: LapRecord[];
  x: number;
  y: number;
  gpsLock: boolean;
  refLapS: number;
};

type Store = Snapshot & {
  track: TrackDef;
  screen: Screen;
  version: "v1" | "v2";
  log: Sample[];
  flash: string | null;
  setScreen: (s: Screen) => void;
  setTrack: (id: string) => void;
  toggleRun: () => void;
  reset: () => void;
  setVersion: (v: "v1" | "v2") => void;
  tick: (dt: number) => void;
  exportCsv: () => string;
};

let engine = new SessionEngine(TRACKS[0]);

function snap(): Snapshot {
  const p = engine.pose();
  const sample = engine.sample();
  return {
    running: engine.running,
    armed: engine.armed,
    lapNumber: engine.lapNumber,
    lapElapsed: engine.armed ? engine.lapElapsed : 0,
    elapsed: engine.elapsed,
    bestS: engine.bestS,
    lastS: engine.lastS,
    deltaS: engine.deltaS(),
    speedKmh: sample.speedKmh,
    maxSpeedKmh: engine.maxSpeedKmh,
    heading: sample.heading,
    sats: sample.sats,
    hdop: sample.hdop,
    gLong: sample.gLong,
    gLat: sample.gLat,
    lat: sample.lat,
    lon: sample.lon,
    distM: p.distM,
    lengthM: engine.track.lengthM,
    sectorIndex: engine.armed ? p.sectorIndex : 0,
    sectorClock: engine.armed ? engine.sectorClock : 0,
    sectors: engine.sectorRows(),
    laps: engine.laps,
    x: p.x,
    y: p.y,
    gpsLock: sample.sats >= 8 && sample.hdop < 2,
    refLapS: engine.refLapS,
  };
}

export const useSession = create<Store>((set, get) => ({
  ...snap(),
  track: engine.track,
  screen: "sensors",
  version: "v2",
  log: [],
  flash: null,
  setScreen: (screen) => set({ screen }),
  setTrack: (id) => {
    engine = engine.reset(getTrack(id));
    engine.pace = 1.012 + Math.random() * 0.03;
    set({ ...snap(), track: engine.track, log: [], flash: null });
  },
  toggleRun: () => {
    if (engine.running) engine.pause();
    else if (engine.elapsed > 0) engine.resume();
    else engine.arm();
    set(snap());
  },
  reset: () => {
    engine = engine.reset();
    engine.pace = 1.01 + Math.random() * 0.035;
    set({ ...snap(), log: [], flash: null });
  },
  setVersion: (version) =>
    set({
      version,
      screen: version === "v2" ? "sensors" : get().screen === "sensors" ? "dash" : get().screen,
    }),
  tick: (dt) => {
    if (!engine.running) return;
    const stepDt = Math.min(Math.max(dt, 0), 0.25);
    let left = stepDt;
    let flash = get().flash;
    while (left > 1e-4) {
      const slice = Math.min(0.05, left);
      const ev = engine.step(slice);
      if (ev.crossed) flash = "LAP";
      else if (ev.sectorCrossed != null) flash = `S${ev.sectorCrossed}`;
      left -= slice;
    }
    const sample = engine.sample();
    const log = get().log;
    const lastT = log.length ? log[log.length - 1].t : -1;
    const nextLog = sample.t - lastT >= 0.1 ? [...log, sample].slice(-3600) : log;
    set({ ...snap(), log: nextLog, flash });
  },
  exportCsv: () => csvFor(engine.laps, get().log),
}));

let raf = 0;
let last = 0;
let flashAge = 0;
let running = false;

export function startLoop() {
  if (typeof window !== "undefined") {
    (window as unknown as { __chrono?: () => unknown }).__chrono = () => {
      const st = useSession.getState();
      return { running: st.running, armed: st.armed, laps: st.laps.length };
    };
  }
  if (running) return () => {};
  running = true;
  last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) useSession.getState().tick(dt);
    if (useSession.getState().flash) {
      flashAge += dt;
      if (flashAge > 0.85) {
        flashAge = 0;
        useSession.setState({ flash: null });
      }
    } else {
      flashAge = 0;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {};
}
