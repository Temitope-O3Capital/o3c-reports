import { useEffect, useRef, useState } from 'react'

// Animates a number from its previous value to `target` on every change, RAF-driven with a
// cubic ease-out. Promoted from admin/SyncStatus.tsx's fleet counter, which had the same
// logic hand-rolled locally — shared here so KpiCard can reuse it instead of a second copy.
//
// Returns an unrounded number and lands exactly on `target`. The original rounded every
// frame, which was invisible on whole naira amounts but silently truncated anything with
// decimals — a 64.1% rate would have finished the animation reading 64%. Callers that want
// a whole number round it themselves; callers with a formatter let the formatter decide.
export function useCountUp(target: number, ms = 600): number {
  // Counting starts from zero on first mount, not from the arriving value. Seeding the
  // state with `target` meant start === target on mount, so a card that renders only once
  // data has landed — which is most of them, since the page holds a skeleton until then —
  // never animated at all. Seeded lazily so reduced-motion paints the final value on the
  // very first frame rather than flashing a 0.
  const prefersReduced = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [v, setV] = useState(() => (prefersReduced ? target : 0))
  const from = useRef(prefersReduced ? target : 0)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      from.current = target
      setV(target)
      return
    }
    const start = from.current; const t0 = performance.now(); let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      if (k < 1) {
        setV(start + (target - start) * (1 - Math.pow(1 - k, 3)))
        raf = requestAnimationFrame(step)
      } else {
        setV(target)
        from.current = target
      }
    }
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}
