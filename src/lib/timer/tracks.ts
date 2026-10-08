/** Closed-loop tracks in local metres, CCW from start/finish. */

export type Point = { x: number; y: number };

export type SectorDef = {
  id: number;
  name: string;
  /** Distance along the loop (m) where this sector begins. */
  startM: number;
};

export type TrackDef = {
  id: string;
  name: string;
  place: string;
  lengthM: number;
  /** Smoothed centerline, closed (first point repeated at end). */
  center: Point[];
  sectors: SectorDef[];
  /** Best reference lap used for predictive delta, seconds. */
  referenceLapS: number;
  /** Speed multiplier vs a "base" pace so tracks feel different. */
  pace: number;
};

function catmull(points: Point[], samplesPerSeg: number): Point[] {
  const n = points.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...points[0] });
  return out;
}

function lengthOf(pts: Point[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

/** Resample a closed polyline to equal arc-length steps. */
function resample(pts: Point[], stepM: number): Point[] {
  const segs: { a: Point; b: Point; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push({ a: pts[i - 1], b: pts[i], len });
    total += len;
  }
  const out: Point[] = [];
  const n = Math.max(8, Math.round(total / stepM));
  const step = total / n;
  let segI = 0;
  let walked = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (segI < segs.length - 1 && walked + segs[segI].len < target) {
      walked += segs[segI].len;
      segI++;
    }
    const seg = segs[segI];
    const u = seg.len === 0 ? 0 : (target - walked) / seg.len;
    out.push({
      x: seg.a.x + (seg.b.x - seg.a.x) * u,
      y: seg.a.y + (seg.b.y - seg.a.y) * u,
    });
  }
  out.push({ ...out[0] });
  return out;
}

function build(
  id: string,
  name: string,
  place: string,
  control: Point[],
  sectorFractions: number[],
  sectorNames: string[],
  referenceLapS: number,
  pace: number,
): TrackDef {
  const smooth = catmull(control, 18);
  const center = resample(smooth, 4);
  const lengthM = lengthOf(center);
  const sectors: SectorDef[] = sectorFractions.map((f, i) => ({
    id: i + 1,
    name: sectorNames[i],
    startM: f * lengthM,
  }));
  return { id, name, place, lengthM, center, sectors, referenceLapS, pace };
}

/** Club circuit — three sectors, ~2.4 km. */
const club = build(
  "club",
  "Club Circuit",
  "Practice loop",
  [
    { x: 0, y: 0 },
    { x: 280, y: 8 },
    { x: 520, y: -20 },
    { x: 680, y: 90 },
    { x: 640, y: 240 },
    { x: 420, y: 300 },
    { x: 180, y: 250 },
    { x: 40, y: 160 },
    { x: -80, y: 80 },
    { x: -40, y: 10 },
  ],
  [0, 0.34, 0.67],
  ["Start straight", "Hairpin complex", "Back straight"],
  78.4,
  1,
);

/** Technical street course — four sectors. */
const street = build(
  "street",
  "Marina Street",
  "Bay circuit",
  [
    { x: 0, y: 0 },
    { x: 220, y: 0 },
    { x: 340, y: 40 },
    { x: 360, y: 160 },
    { x: 250, y: 210 },
    { x: 160, y: 140 },
    { x: 80, y: 220 },
    { x: -40, y: 200 },
    { x: -90, y: 90 },
    { x: -30, y: 20 },
  ],
  [0, 0.22, 0.48, 0.74],
  ["Promenade", "Chicane", "Harbor", "Pit exit"],
  92.6,
  0.88,
);

/** Fast oval-ish road course — three long sectors. */
const fast = build(
  "fast",
  "Pacific Ring",
  "High-speed",
  [
    { x: 0, y: 40 },
    { x: 360, y: -30 },
    { x: 760, y: 20 },
    { x: 900, y: 180 },
    { x: 740, y: 320 },
    { x: 380, y: 360 },
    { x: 40, y: 280 },
    { x: -80, y: 140 },
  ],
  [0, 0.38, 0.7],
  ["Main straight", "Esses", "Final corner"],
  64.2,
  1.18,
);

export const TRACKS: TrackDef[] = [club, street, fast];

export function getTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? club;
}
