import { useSearchParams } from 'react-router-dom'

// Reads the `?focus=<id>` deep-link that the notification bell appends so a page can
// open/highlight the exact record a notification is about. Returns the id string or null.
export function useFocusParam(): string | null {
  const [params] = useSearchParams()
  return params.get('focus')
}
