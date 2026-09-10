import { useEffect, useState } from 'react'

// Responsive breakpoints. The app is inline-styled (no Tailwind responsive classes on
// most surfaces), so components read the viewport through this hook and switch layout in
// JS. Keeping the breakpoints here means one place defines "narrow" and "mobile".
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

// Phones and very small windows — stack everything, drop chrome to essentials.
export const useIsMobile = () => useMediaQuery('(max-width: 768px)')
// Small laptops / split-screen — collapse the sidebar, tighten padding, fewer columns.
export const useIsNarrow = () => useMediaQuery('(max-width: 1100px)')
