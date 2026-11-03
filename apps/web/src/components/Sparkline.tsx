'use client';

import { useMemo, useState } from 'react';

interface Point {
  t: number;
  avg: number;
  min: number;
  max: number;
}

/**
 * Dependency-free SVG trend chart: min/max envelope + average line,
 * optional warning/critical bands, hover read-out.
 */
export function Sparkline({
  points,
  height = 120,
  warn,
  crit,
  format = (v: number) => v.toFixed(2),
}: {
  points: Point[];
  height?: number;
  warn?: number | null;
  crit?: number | null;
  format?: (v: number) => string;
}) {
  const width = 320;
  const pad = { l: 52, r: 6, t: 8, b: 18 };
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    let lo = Math.min(...points.map((p) => p.min));
    let hi = Math.max(...points.map((p) => p.max));
    for (const b of [warn, crit]) if (b !== null && b !== undefined && b > lo - (hi - lo) && b < hi + (hi - lo)) {
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
    }
    if (hi - lo < 1e-6) {
      hi += 1;
      lo -= 1;
    }
    const span = hi - lo;
    lo -= span * 0.08;
    hi += span * 0.08;
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
    const band =
      points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.max).toFixed(1)}`).join('') +
      [...points].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.min).toFixed(1)}`).join('') +
      'Z';
    return { x, y, line, band, lo, hi, t0, t1 };
  }, [points, height, warn, crit]);

  if (!geo) return <div className="chart-empty">Collecting data…</div>;

  const hp = hover !== null ? points[hover] : null;
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      role="img"
      aria-label="Telemetry trend"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * width;
        let best = 0;
        let bestD = Infinity;
        points.forEach((p, i) => {
          const d = Math.abs(geo.x(p.t) - px);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        setHover(best);
      }}
    >
      {[geo.lo, (geo.lo + geo.hi) / 2, geo.hi].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={width - pad.r} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
          <text x={pad.l - 4} y={geo.y(v) + 3} className="axis" textAnchor="end">
            {format(v)}
          </text>
        </g>
      ))}
      {warn !== null && warn !== undefined && <line x1={pad.l} x2={width - pad.r} y1={geo.y(warn)} y2={geo.y(warn)} className="th-warn" />}
      {crit !== null && crit !== undefined && <line x1={pad.l} x2={width - pad.r} y1={geo.y(crit)} y2={geo.y(crit)} className="th-crit" />}
      <path d={geo.band} className="band" />
      <path d={geo.line} className="line" />
      <text x={pad.l} y={height - 4} className="axis">
        {fmtTime(geo.t0)}
      </text>
      <text x={width - pad.r} y={height - 4} className="axis" textAnchor="end">
        {fmtTime(geo.t1)}
      </text>
      {hp && (
        <g>
          <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={pad.t} y2={height - pad.b} className="cursor" />
          <circle cx={geo.x(hp.t)} cy={geo.y(hp.avg)} r={3.5} className="dot" />
          <text x={Math.min(geo.x(hp.t) + 6, width - 90)} y={pad.t + 12} className="readout">
            {fmtTime(hp.t)} · {format(hp.avg)}
          </text>
        </g>
      )}
    </svg>
  );
}
