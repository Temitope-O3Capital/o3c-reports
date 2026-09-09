import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { prefersReducedMotion } from "./motion";

// How long the exit animation runs before the dialog is actually unmounted.
// Single source of truth: the animation shorthand below interpolates this
// rather than repeating the number in CSS, so the timeout and the animation
// can't drift apart.
const EXIT_MS = 150;

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 6, color: "var(--ink-faint)", font: "650 11px/1 var(--font)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
      {children}
    </label>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = 520,
  minHeight,
  headerExtra,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  minHeight?: number;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const pointerDownOnBackdrop = useRef(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Every close path routes through this so the exit animation actually plays
  // — calling onClose directly would rip the dialog out of the tree mid-frame.
  // Guarded against double-fire (e.g. Escape while a backdrop click is already
  // animating out), which would otherwise queue two onClose calls.
  const requestClose = useCallback(() => {
    if (exitTimer.current) return;
    if (prefersReducedMotion()) { onCloseRef.current(); return; }
    setClosing(true);
    exitTimer.current = setTimeout(() => onCloseRef.current(), EXIT_MS);
  }, []);

  const requestCloseRef = useRef(requestClose);
  useEffect(() => { requestCloseRef.current = requestClose; }, [requestClose]);

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const initialFocus =
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialogRef.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-modal-close]), [href], [tabindex]:not([tabindex='-1'])");
    initialFocus?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { requestCloseRef.current(); return; }
      if (e.key === "Tab" && dialogRef.current) {
        const all = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ).filter(el => !el.hasAttribute("disabled"));
        if (all.length === 0) { e.preventDefault(); return; }
        const first = all[0], last = all[all.length - 1];
        if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
        else { if (document.activeElement === last) { e.preventDefault(); first.focus(); } }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      style={{
        position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(15,17,32,0.55)", backdropFilter: "blur(3px)", padding: 16,
        animation: `${closing ? "overlay-out" : "overlay-in"} ${EXIT_MS}ms var(--ease) both`,
      }}
      onPointerDown={e => { pointerDownOnBackdrop.current = e.target === backdropRef.current; }}
      onPointerUp={e => {
        if (pointerDownOnBackdrop.current && e.target === backdropRef.current) requestClose();
        pointerDownOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        style={{
          width: `min(${width}px, 90vw)`,
          ...(minHeight ? { minHeight: `min(${minHeight}px, 82vh)` } : {}),
          maxHeight: "90vh",
          background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-lg)",
          // Enter uses --ease (decelerating, "arriving"); exit uses --ease-in
          // (accelerating, "leaving") — previously a dead token.
          animation: closing
            ? `dialog-out ${EXIT_MS}ms var(--ease-in) both`
            : `dialog-in var(--dur-med) var(--ease) both`,
          ...(footer ? { display: "flex", flexDirection: "column", overflow: "hidden" } : { overflowY: "auto", padding: 26 }),
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: headerExtra ? 18 : 22, flexShrink: 0, ...(footer ? { padding: "26px 26px 0" } : {}) }}>
          <div>
            <h3 id="modal-title" style={{ margin: 0, color: "var(--ink)", font: "600 18px/1.3 var(--font-display)" }}>{title}</h3>
            {subtitle && <p style={{ margin: "6px 0 0", color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)" }}>{subtitle}</p>}
          </div>
          <button data-modal-close onClick={requestClose} aria-label="Close" style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-faint)", padding: 4, display: "grid", placeItems: "center", flexShrink: 0 }}>
            <X size={17} />
          </button>
        </div>
        {headerExtra && <div style={{ flexShrink: 0, ...(footer ? { padding: "0 26px" } : {}) }}>{headerExtra}</div>}
        {footer ? (
          <>
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 26px 26px" }}>{children}</div>
            <div style={{ flexShrink: 0, borderTop: "1px solid var(--rule)", padding: "16px 26px" }}>{footer}</div>
          </>
        ) : children}
      </div>
    </div>,
    document.body,
  );
}
