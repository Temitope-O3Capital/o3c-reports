import { useEffect, useRef, useState } from 'react'

// Animates a number from its previous value to `target` on every change, RAF-driven with a
// cubic ease-out. Promoted from admin/SyncStatus.tsx's fleet counter, which had the same
// logic hand-rolled locally — shared here so KpiCard can reuse it instead of a second copy.
export function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      from.current = target
      setV(target)
      return
    }
    const start = from.current; const t0 = performance.now(); let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      setV(Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target
    }
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}
