/** Shared fixtures for the GNSS timing tests. Not part of the runtime API. */

import { LocalFrame, type GeoPoint } from "../geo.ts";
import { Centerline } from "../centerline.ts";
import { compileTrack, perpendicularGate, type CompiledTrack, type GeoTrackDef } from "../track.ts";

export const ORIGIN: GeoPoint = { lat: 8.98, lon: -79.52 };

/** Counter-clockwise circle, radius r, `n` vertices, start/finish at angle -90° (bottom). */
export function circleTrack(r = 200, n = 360, sectorFracs = [0, 1 / 3, 2 / 3]): CompiledTrack {
  const frame = new LocalFrame(ORIGIN);
  const local = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const cl = new Centerline(local);
  const def: GeoTrackDef = {
    id: "circle",
    name: "Test circle",
    origin: ORIGIN,
    centerline: local.map((p) => frame.toGeo(p.x, p.y)),
    gates: sectorFracs.map((f, i) =>
      perpendicularGate(cl, frame, f * cl.lengthM, 12, {
        id: i === 0 ? "SF" : `S${i}`,
        name: i === 0 ? "Start/Finish" : `S${i}`,
        kind: i === 0 ? "start_finish" : "sector",
      }),
    ),
  };
  return compileTrack(def);
}

/** Matched fix at distance s with cross-track e, travelling forward at v. */
export function fixAt(
  track: CompiledTrack,
  t: number,
  s: number,
  v = 30,
  e = 0,
  courseFlip = false,
) {
  const p = track.centerline.pointAt(s);
  const x = p.x - p.ty * e;
  const y = p.y + p.tx * e;
  let course = (Math.atan2(p.tx, p.ty) * 180) / Math.PI;
  if (courseFlip) course += 180;
  return { t, x, y, s: track.centerline.wrap(s), e, speedMs: v, courseDeg: (course + 360) % 360 };
}
