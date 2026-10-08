/**
 * Adapter: the browser preview's synthetic tracks (local metres + sector
 * start distances) → a geographic GeoTrackDef.
 *
 * The synthetic tracks are NOT surveyed circuits. They are placed at an
 * arbitrary origin so the GNSS pipeline has realistic lat/lon to chew on.
 */

import { Centerline } from "./centerline.ts";
import { LocalFrame, type GeoPoint } from "./geo.ts";
import { perpendicularGate, type GeoGateDef, type GeoTrackDef } from "./track.ts";
import type { TrackDef } from "../timer/tracks.ts";

/** Same anchor the preview has always used for its fake lat/lon. */
export const SYNTHETIC_ORIGIN: GeoPoint = { lat: 8.9824, lon: -79.5199 };

export const SYNTHETIC_GATE_HALF_WIDTH_M = 15;

export function geoTrackFromSynthetic(
  track: TrackDef,
  origin: GeoPoint = SYNTHETIC_ORIGIN,
  halfWidthM = SYNTHETIC_GATE_HALF_WIDTH_M,
): GeoTrackDef {
  const frame = new LocalFrame(origin);
  const cl = new Centerline(track.center);
  const gates: GeoGateDef[] = track.sectors.map((sec, i) =>
    perpendicularGate(cl, frame, sec.startM, halfWidthM, {
      id: i === 0 ? "SF" : `S${i}`,
      name: i === 0 ? "Start/Finish" : `Sector ${i} end`,
      kind: i === 0 ? "start_finish" : "sector",
    }),
  );
  return {
    id: track.id,
    name: track.name,
    origin,
    centerline: track.center.map((p) => frame.toGeo(p.x, p.y)),
    gates,
  };
}
