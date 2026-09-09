import type { CSSProperties } from "react";

/**
 * Loading primitives.
 *
 * Prefer a skeleton over a spinner wherever the shape of what's arriving is
 * already known — it holds the layout so nothing jumps when data lands, and it
 * reads as "this is filling in" rather than "something is happening somewhere".
 * Reach for <Spinner> only at the gates where the shape genuinely isn't known
 * yet: route chunk loading, auth restore, module-flag checks.
 *
 * Every looping animation here carries data-loop-motion so the reduced-motion
 * block in styles.css can swap rotation/shimmer for an opacity pulse instead of
 * collapsing the duration (which would strobe).
 */

/** A single shimmering placeholder bar. `w`/`h` accept any CSS length. */
export function Skeleton({ w = "100%", h = "0.72em", radius, style }: {
  w?: string | number; h?: string | number; radius?: string | number; style?: CSSProperties;
}) {
  return (
    <div
      className="skel"
      data-loop-motion
      aria-hidden="true"
      style={{ width: w, height: h, ...(radius != null ? { borderRadius: radius } : null), ...style }}
    />
  );
}

/** N stacked text lines. The last line is shortened so it reads as prose, not a block. */
export function SkeletonText({ lines = 3, width = "100%" }: { lines?: number; width?: string }) {
  return (
    <div aria-hidden="true" style={{ width }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel skel-line" data-loop-motion style={i === lines - 1 ? { width: "62%" } : undefined} />
      ))}
    </div>
  );
}

/**
 * Table-body skeleton. Renders into an existing <table> so the real <thead>
 * stays put and the columns keep their widths — pass the same column count the
 * loaded table uses.
 *
 * Column widths cycle through a fixed pattern rather than randomising: a random
 * width per render would re-shuffle on every re-render and visibly twitch.
 */
const CELL_WIDTHS = ["78%", "52%", "64%", "44%", "70%", "48%", "58%", "40%"];

/**
 * Bare <tr> rows, for callers that already own the surrounding <tbody> (e.g.
 * a table whose empty/loaded branches are sibling rows inside one tbody).
 * Use SkeletonRows instead when you can swap the whole tbody.
 */
export function SkeletonTableRows({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="skel-row" aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <div className="skel skel-line" data-loop-motion style={{ width: CELL_WIDTHS[(r + c) % CELL_WIDTHS.length] }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SkeletonRows({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <tbody className="skel-table" aria-hidden="true">
      <SkeletonTableRows rows={rows} cols={cols} />
    </tbody>
  );
}

/**
 * Stat-strip ghost, matching .stat's box model so the strip holds its height.
 * This is what Overview should show instead of rendering real cards full of
 * zeros — a zero is a claim about the data, a ghost isn't.
 */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skel-stat">
          <div className="skel skel-line" data-loop-motion style={{ width: "42%", height: "1.6em" }} />
          <div className="skel skel-line" data-loop-motion style={{ width: "68%", marginTop: 12 }} />
        </div>
      ))}
    </div>
  );
}

/** Panel-shaped skeleton for card/detail surfaces that aren't tables. */
export function SkeletonPanel({ lines = 4, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="panel" aria-hidden="true" style={{ padding: 24 }}>
      {title && <div className="skel skel-line" data-loop-motion style={{ width: "32%", height: "1.15em", marginBottom: 18 }} />}
      <SkeletonText lines={lines} />
    </div>
  );
}

/**
 * The one spinner in the app. Sizes are fixed rather than free-form so the
 * three ad-hoc spinners this replaces (32px/2.5px, 28px/2.5px, 12px lucide)
 * collapse to a single vocabulary.
 */
const SPINNER_PX = { sm: 16, md: 28, lg: 32 } as const;

export function Spinner({ size = "md", label = "Loading" }: { size?: keyof typeof SPINNER_PX; label?: string }) {
  const px = SPINNER_PX[size];
  return (
    <div
      className="spinner"
      data-loop-motion
      role="status"
      aria-label={label}
      style={{ width: px, height: px, borderWidth: size === "sm" ? 2 : 2.5 }}
    />
  );
}

/** Centered spinner for a full region — route fallbacks, auth restore, gates. */
export function SpinnerRegion({ height = "60vh", size = "md", label }: {
  height?: string | number; size?: keyof typeof SPINNER_PX; label?: string;
}) {
  return (
    <div className="spinner-wrap" style={{ height }}>
      <Spinner size={size} label={label} />
    </div>
  );
}

