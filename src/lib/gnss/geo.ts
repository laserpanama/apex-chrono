/**
 * GNSS coordinate conversion.
 *
 * A circuit is a few kilometres across, so a local tangent-plane
 * (east/north) frame anchored at one origin is accurate to centimetres and
 * costs two multiplies per fix — cheap enough for an ESP32-S3 without a
 * double-precision FPU penalty in the hot path (the scale factors are
 * computed once).
 *
 * Scale factors use the WGS84 ellipsoid radii of curvature at the origin
 * latitude (meridional radius M for north, prime-vertical radius N·cosφ for
 * east), not a spherical approximation.
 */

export type GeoPoint = { lat: number; lon: number };
export type LocalPoint = { x: number; y: number };

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999014;
const DEG = Math.PI / 180;

export class LocalFrame {
  readonly lat0: number;
  readonly lon0: number;
  /** metres per degree of latitude at the origin */
  readonly mPerDegLat: number;
  /** metres per degree of longitude at the origin */
  readonly mPerDegLon: number;

  constructor(origin: GeoPoint) {
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) {
      throw new Error("LocalFrame origin must be finite");
    }
    if (Math.abs(origin.lat) > 85) throw new Error("LocalFrame origin latitude out of range");
    this.lat0 = origin.lat;
    this.lon0 = origin.lon;
    const s = Math.sin(origin.lat * DEG);
    const w = 1 - WGS84_E2 * s * s;
    const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5);
    const N = WGS84_A / Math.sqrt(w);
    this.mPerDegLat = M * DEG;
    this.mPerDegLon = N * Math.cos(origin.lat * DEG) * DEG;
  }

  /** lat/lon (degrees) → local east (x) / north (y) metres. */
  toLocal(lat: number, lon: number): LocalPoint {
    let dLon = lon - this.lon0;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    return { x: dLon * this.mPerDegLon, y: (lat - this.lat0) * this.mPerDegLat };
  }

  /** local east/north metres → lat/lon (degrees). */
  toGeo(x: number, y: number): GeoPoint {
    let lon = this.lon0 + x / this.mPerDegLon;
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    return { lat: this.lat0 + y / this.mPerDegLat, lon };
  }
}

/** Great-circle distance on the WGS84 mean sphere — reference for tests. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Course over ground (deg, 0 = north, clockwise) → unit east/north vector. */
export function courseToUnit(courseDeg: number): LocalPoint {
  const r = courseDeg * DEG;
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** Unit/any east/north vector → course over ground in [0, 360). */
export function unitToCourse(x: number, y: number): number {
  const c = Math.atan2(x, y) / DEG;
  return c < 0 ? c + 360 : c;
}
