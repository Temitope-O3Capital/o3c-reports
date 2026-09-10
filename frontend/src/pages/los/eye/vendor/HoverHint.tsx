import { useRef, useState, type ReactNode, type CSSProperties } from "react";

// Ported from Portal's EyeReportPage.tsx HoverHint — same delayed-show tooltip
// behavior so Eye's feature explanations read identically across apps.
export function HoverHint({ hint, children, style, placement = "up" }: { hint: string; children: ReactNode; style?: CSSProperties; placement?: "up" | "down" }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const show = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 260);
  };
  const hide = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };
  return (
    <div onMouseEnter={show} onMouseLeave={hide} style={{ position: "relative", ...style }}>
      {children}
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: 12,
            // Rows near the top of a clipped/scrollable ancestor (e.g. the Eye
            // decision panel's "All signals" list, which sits inside its own
            // overflow:auto box) have nowhere for an upward-opening tooltip to
            // render without getting cut off by that ancestor's own boundary —
            // callers pass placement="down" for those rows.
            ...(placement === "down" ? { top: "calc(100% + 8px)" } : { bottom: "calc(100% + 8px)" }),
            zIndex: 20,
            maxWidth: 320,
            padding: "8px 10px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "#1F1C19",
            color: "#FFF",
            boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
            font: "500 11.5px/1.45 var(--font)",
            pointerEvents: "none",
            whiteSpace: "normal",
            // Fades up rather than popping — the 260ms open delay above
            // already means it appears deliberately, so an instant hard cut
            // read as a glitch.
            animation: "rise-sm var(--dur-fast) var(--ease) both",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
