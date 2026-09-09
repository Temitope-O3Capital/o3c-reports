const BANDS = [
  { max: 30, label: "Poor", color: "#B03B33" },
  { max: 50, label: "Fair", color: "#A8792E" },
  { max: 70, label: "Good", color: "#D6A758" },
  { max: 85, label: "Very Good", color: "#2E9E77" },
  { max: 100, label: "Excellent", color: "#227A5B" },
];

function bandFor(score: number) {
  return BANDS.find(b => score <= b.max) ?? BANDS[BANDS.length - 1];
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const s = polar(cx, cy, r, startDeg);
  const e = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

interface ScoreGaugeProps {
  score: number;
  maxScore?: number;
  size?: number;
  label?: string;
}

// Semi-circular gauge for Eye credit scores. Pure SVG, no dependencies.
export function ScoreGauge({ score, maxScore = 1000, size = 200, label }: ScoreGaugeProps) {
  const normalised = Math.max(0, Math.min(100, Math.round((score / maxScore) * 100)));
  const band = bandFor(normalised);
  const displayLabel = label ?? band.label;

  const cx = size / 2;
  const cy = size / 2 + size * 0.06;
  const r = size * 0.38;
  const sw = size * 0.075;
  const minA = -140;
  const maxA = 140;
  const span = maxA - minA;

  const trackPath = arcPath(cx, cy, r, minA, maxA);
  const scoreAngle = minA + (normalised / 100) * span;
  const fillPath = arcPath(cx, cy, r, minA, scoreAngle);
  const needlePt = polar(cx, cy, r, scoreAngle);
  const titleId = `score-gauge-${score}`;

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size * 0.65} viewBox={`0 0 ${size} ${size * 0.65}`} style={{ overflow: "visible" }} role="img" aria-labelledby={titleId}>
        <title id={titleId}>Eye score: {score} — {displayLabel}</title>
        <path d={trackPath} fill="none" stroke="var(--rule)" strokeWidth={sw} strokeLinecap="round" />
        {/* The arc draws itself from the low end up to the score. pathLength=100
            normalises the dash units so the same keyframe works at any size, and
            key={score} remounts the node so re-scoring re-runs the draw rather
            than silently snapping to the new value. */}
        <path
          key={score}
          d={fillPath}
          fill="none"
          stroke={band.color}
          strokeWidth={sw}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          style={{
            filter: `drop-shadow(0 0 ${sw * 0.6}px ${band.color}66)`,
            animation: "gauge-draw var(--dur-slow) var(--ease) both",
          }}
        />
        <circle
          cx={needlePt.x}
          cy={needlePt.y}
          r={sw * 0.55}
          fill={band.color}
          style={{
            filter: `drop-shadow(0 0 4px ${band.color})`,
            // Lands as the arc finishes rather than sitting at the final
            // position while the arc is still travelling toward it.
            animation: "meter-in var(--dur-fast) var(--ease) var(--dur-slow) both",
          }}
        />
        <text x={cx} y={cy - size * 0.01} textAnchor="middle" dominantBaseline="middle" style={{ font: `700 ${size * 0.16}px var(--font-mono)`, fill: "var(--ink)" }}>{score}</text>
        <text x={cx} y={cy + size * 0.13} textAnchor="middle" dominantBaseline="middle" style={{ font: `600 ${size * 0.065}px var(--font)`, fill: band.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{displayLabel}</text>
      </svg>
    </div>
  );
}
