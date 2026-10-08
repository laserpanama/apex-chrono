import { useMemo } from "react";
import type { TrackDef } from "@/lib/timer/tracks";

type Props = {
  track: TrackDef;
  x: number;
  y: number;
  heading: number;
  distM: number;
  sectorIndex: number;
  armed: boolean;
  className?: string;
};

const SECTOR_STROKE = ["var(--color-amber)", "var(--color-signal)", "var(--color-fg)", "#7eb6d6"];

export function TrackMap({ track, x, y, heading, distM, sectorIndex, armed, className }: Props) {
  const layout = useMemo(() => {
    const pts = track.center;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = 36;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    return { minX: minX - pad, minY: minY - pad, w: w + pad * 2, h: h + pad * 2 };
  }, [track]);

  const pathFor = (from: number, to: number) => {
    const pts = track.center;
    const slice = pts.slice(from, to + 1);
    if (slice.length < 2) return "";
    return slice
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${(-p.y).toFixed(1)}`)
      .join(" ");
  };

  const bounds = sectorBounds(track);
  const car = { x, y: -y };
  const sf = track.center[0];

  return (
    <svg
      viewBox={`${layout.minX} ${-layout.minY - layout.h} ${layout.w} ${layout.h}`}
      className={className}
      role="img"
      aria-label={`${track.name} track map`}
    >
      <rect
        x={layout.minX}
        y={-layout.minY - layout.h}
        width={layout.w}
        height={layout.h}
        fill="var(--color-bg-2)"
      />
      {bounds.map((b, i) => (
        <path
          key={i}
          d={pathFor(b.from, b.to)}
          fill="none"
          stroke={SECTOR_STROKE[i % SECTOR_STROKE.length]}
          strokeWidth={armed && i === sectorIndex ? 16 : 11}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={armed && i === sectorIndex ? 1 : 0.45}
        />
      ))}
      <path
        d={pathFor(0, track.center.length - 1)}
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={2}
        strokeDasharray="10 14"
        opacity={0.55}
      />
      <g transform={`translate(${sf.x},${-sf.y})`}>
        <rect x={-3} y={-18} width={6} height={36} fill="var(--color-fg)" />
        <rect x={3} y={-18} width={6} height={18} fill="var(--color-ink)" />
        <rect x={3} y={0} width={6} height={18} fill="var(--color-fg)" />
      </g>
      <g transform={`translate(${car.x},${car.y}) rotate(${heading})`}>
        <polygon points="0,-16 9,12 -9,12" fill="var(--color-amber)" />
        <polygon points="0,-10 4,6 -4,6" fill="var(--color-ink)" opacity={0.35} />
      </g>
      <text
        x={layout.minX + 16}
        y={-layout.minY - 18}
        fill="var(--color-muted)"
        fontSize={18}
        fontFamily="Barlow Condensed, sans-serif"
        letterSpacing="2"
      >
        {track.name.toUpperCase()} · {(distM / 1000).toFixed(2)} / {(track.lengthM / 1000).toFixed(2)} KM
      </text>
    </svg>
  );
}

function sectorBounds(track: TrackDef) {
  const n = track.center.length - 1;
  const L = track.lengthM;
  const starts = track.sectors.map((s) => Math.round((s.startM / L) * n));
  return track.sectors.map((_, i) => {
    const from = starts[i];
    const to = i === starts.length - 1 ? n : starts[i + 1];
    return { from, to };
  });
}
