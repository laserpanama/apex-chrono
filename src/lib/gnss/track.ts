/**
 * Real-track definition: a circuit is a geographic centerline plus a set of
 * geographic timing gates. Nothing here depends on the synthetic preview
 * tracks — a surveyed circuit (e.g. a lap logged with the BN-880 and
 * smoothed, or a centerline traced from survey data) plugs in unchanged.
 */

import { Centerline } from "./centerline.ts";
import { LocalFrame, type GeoPoint } from "./geo.ts";

export type GateKind = "start_finish" | "sector";

/**
 * A timing line. `left` and `right` are its endpoints as seen by a driver
 * travelling in the correct direction; the valid crossing direction is
 * derived from them (forward = left→right rotated 90° CCW).
 */
export type GeoGateDef = {
  id: string;
  name: string;
  kind: GateKind;
  left: GeoPoint;
  right: GeoPoint;
};

export type GeoTrackDef = {
  id: string;
  name: string;
  /** Local-frame origin. Defaults to the first centerline point. */
  origin?: GeoPoint;
  /** Closed loop in the direction of travel. A repeated closing point is allowed. */
  centerline: GeoPoint[];
  /** gates[0] must be the start/finish line; the rest are sector gates in driving order. */
  gates: GeoGateDef[];
};

export type CompiledGate = {
  index: number;
  id: string;
  name: string;
  kind: GateKind;
  /** endpoints in local metres */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** unit forward (valid crossing) direction */
  fx: number;
  fy: number;
  /** half the gate length */
  halfWidthM: number;
  /** distance along the centerline where the gate crosses it */
  s: number;
  /** signed cross-track (centerline frame) of the gate midpoint */
  centerE: number;
};

export type CompiledTrack = {
  id: string;
  name: string;
  frame: LocalFrame;
  centerline: Centerline;
  gates: CompiledGate[];
};

export const MAX_GATES = 16;

/** Intersection parameter of segments P0P1 and Q0Q1, or null. Returns (u on P, v on Q). */
export function segmentIntersection(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  q0x: number,
  q0y: number,
  q1x: number,
  q1y: number,
): { u: number; v: number } | null {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = q1x - q0x;
  const sy = q1y - q0y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qpx = q0x - p0x;
  const qpy = q0y - p0y;
  const u = (qpx * sy - qpy * sx) / den;
  const v = (qpx * ry - qpy * rx) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { u, v };
}

export function compileTrack(def: GeoTrackDef): CompiledTrack {
  if (def.centerline.length < 3) throw new Error(`${def.id}: centerline too short`);
  if (def.gates.length < 1) throw new Error(`${def.id}: needs a start/finish gate`);
  if (def.gates.length > MAX_GATES) throw new Error(`${def.id}: more than ${MAX_GATES} gates`);
  if (def.gates[0].kind !== "start_finish")
    throw new Error(`${def.id}: gates[0] must be start_finish`);
  if (def.gates.slice(1).some((g) => g.kind !== "sector")) {
    throw new Error(`${def.id}: only gates[0] may be start_finish`);
  }
  const frame = new LocalFrame(def.origin ?? def.centerline[0]);
  const cl = new Centerline(def.centerline.map((p) => frame.toLocal(p.lat, p.lon)));
  const gates: CompiledGate[] = def.gates.map((g, index) => {
    const l = frame.toLocal(g.left.lat, g.left.lon);
    const r = frame.toLocal(g.right.lat, g.right.lon);
    const dx = r.x - l.x;
    const dy = r.y - l.y;
    const w = Math.hypot(dx, dy);
    if (w < 1) throw new Error(`${def.id}/${g.id}: gate shorter than 1 m`);
    const fx = -dy / w;
    const fy = dx / w;
    // Where does the gate line cross the centerline? Take the crossing nearest the gate midpoint.
    const mx = (l.x + r.x) / 2;
    const my = (l.y + r.y) / 2;
    let bestS = NaN;
    let bestD = Infinity;
    let bestSeg = -1;
    for (let i = 0; i < cl.n; i++) {
      const ax = cl.ax[i];
      const ay = cl.ay[i];
      const bx = ax + cl.tx[i] * cl.len[i];
      const by = ay + cl.ty[i] * cl.len[i];
      const hit = segmentIntersection(ax, ay, bx, by, l.x, l.y, r.x, r.y);
      if (!hit) continue;
      const ix = ax + (bx - ax) * hit.u;
      const iy = ay + (by - ay) * hit.u;
      const d = Math.hypot(ix - mx, iy - my);
      if (d < bestD) {
        bestD = d;
        bestS = cl.cum[i] + hit.u * cl.len[i];
        bestSeg = i;
      }
    }
    if (!Number.isFinite(bestS))
      throw new Error(`${def.id}/${g.id}: gate does not cross the centerline`);
    const dot = fx * cl.tx[bestSeg] + fy * cl.ty[bestSeg];
    if (dot < 0.5) {
      throw new Error(
        `${def.id}/${g.id}: gate forward direction disagrees with centerline direction (check left/right order)`,
      );
    }
    const proj = cl.projectOnSegment(bestSeg, mx, my);
    return {
      index,
      id: g.id,
      name: g.name,
      kind: g.kind,
      lx: l.x,
      ly: l.y,
      rx: r.x,
      ry: r.y,
      fx,
      fy,
      halfWidthM: w / 2,
      s: cl.wrap(bestS),
      centerE: proj.e,
    };
  });
  // Sector gates must be in driving order after start/finish.
  const s0 = gates[0].s;
  let prev = 0;
  for (let i = 1; i < gates.length; i++) {
    const rel = cl.wrap(gates[i].s - s0);
    if (rel <= prev) throw new Error(`${def.id}: gate ${gates[i].id} is out of driving order`);
    prev = rel;
  }
  return { id: def.id, name: def.name, frame, centerline: cl, gates };
}

/**
 * Build a gate perpendicular to the centerline at distance s.
 * Used for synthetic tracks and as a helper when only a centerline + gate
 * distances are known. Real tracks should prefer surveyed endpoints.
 */
export function perpendicularGate(
  cl: Centerline,
  frame: LocalFrame,
  s: number,
  halfWidthM: number,
  meta: { id: string; name: string; kind: GateKind },
): GeoGateDef {
  const p = cl.pointAt(s);
  // left normal (-ty, tx)
  const nx = -p.ty;
  const ny = p.tx;
  return {
    ...meta,
    left: frame.toGeo(p.x + nx * halfWidthM, p.y + ny * halfWidthM),
    right: frame.toGeo(p.x - nx * halfWidthM, p.y - ny * halfWidthM),
  };
}
