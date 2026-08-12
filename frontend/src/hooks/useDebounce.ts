import { useState, useEffect } from 'react'

// useDebouncedValue returns a copy of `value` that only updates after it has stopped
// changing for `delay` ms. List pages feed their raw search box straight into the
// query that reloads the table, so every keystroke fired an API call; debouncing the
// value that the loader depends on collapses a burst of typing into one request.
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
