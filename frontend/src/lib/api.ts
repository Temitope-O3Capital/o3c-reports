// API base. When VITE_API_URL is set (dev points at the local backend), use it.
// In a production build it is left empty so requests are same-origin (relative) —
// the on-prem server serves both the frontend and /api from one origin (Go on
// :8000, or nginx on the domain proxying /api), so relative URLs are correct
// regardless of host/port.
const _apiBase = import.meta.env.VITE_API_URL as string | undefined
export const API =
  _apiBase != null && _apiBase !== ''
    ? _apiBase
    : import.meta.env.DEV
      ? 'http://localhost:8000'
      : ''

export function getCsrfToken(): string {
  // Prefer localStorage — works cross-origin (Cloudflare Pages ↔ Railway).
  // Fall back to document.cookie for same-origin dev environments.
  const stored = localStorage.getItem('o3c_csrf')
  if (stored) return stored
  const m = document.cookie.match(/(?:^|;\s*)o3c_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

export function storeCsrfToken(token: string) {
  if (token) localStorage.setItem('o3c_csrf', token)
}

// Singleton promise prevents multiple simultaneous refresh calls.
let refreshPromise: Promise<boolean> | null = null

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      if (data.csrf_token) storeCsrfToken(data.csrf_token)
      return true
    }
    return false
  } catch {
    return false
  }
}

export async function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

function signOut() {
  localStorage.removeItem('o3c_user')
  localStorage.removeItem('o3c_csrf')
  fetch(`${API}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-CSRF-Token': getCsrfToken() },
  }).catch(() => {})
  window.dispatchEvent(new CustomEvent('auth:expired'))
}

export async function apiLogout(): Promise<void> {
  localStorage.removeItem('o3c_user')
  localStorage.removeItem('o3c_csrf')
  try {
    await fetch(`${API}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    })
  } catch { /* best-effort */ }
}

// silent: true suppresses signOut() on auth failure — use for background polling
// effects so a stale token doesn't log the user out without their action.
export async function apiFetch<T = any>(
  path: string,
  init?: RequestInit & { silent?: boolean },
): Promise<T> {
  const { silent, ...fetchInit } = init ?? {}
  const method = (fetchInit.method ?? 'GET').toUpperCase()
  const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  const isFormData = fetchInit.body instanceof FormData
  const makeHeaders = (): HeadersInit => ({
    // Let the browser set Content-Type automatically for FormData (it must
    // include the multipart boundary which only the browser knows).
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(isMutation ? { 'X-CSRF-Token': getCsrfToken() } : {}),
    ...(fetchInit.headers ?? {}),
  })

  try {
    const res = await fetch(`${API}${path}`, {
      ...fetchInit,
      credentials: 'include',
      signal: fetchInit.signal ?? controller.signal,
      headers: makeHeaders(),
    })

    if (res.status === 401) {
      // A 401 is rejection at the auth middleware — the handler never ran, so nothing
      // partially succeeded and the request is safe to replay once the session is
      // refreshed. This used to sign the user out on any failed mutation without even
      // attempting a refresh, which is why sessions felt like they lasted 30 minutes
      // rather than the refresh token's full lifetime: work for half an hour, press
      // Save, get thrown to the login screen with a valid refresh cookie still sitting
      // in the browser.
      //
      // The one thing that genuinely cannot be replayed is a streaming body, which is
      // consumed by the first send. Strings and FormData can both be re-sent.
      const bodyReplayable = !(fetchInit.body instanceof ReadableStream)
      if (isMutation && !bodyReplayable) {
        if (!silent) signOut()
        throw new Error('Session expired')
      }
      const ok = await refreshSession()
      if (ok) {
        const retry = await fetch(`${API}${path}`, {
          ...fetchInit,
          credentials: 'include',
          signal: controller.signal,
          headers: makeHeaders(),
        })
        if (retry.status === 401) {
          if (!silent) signOut()
          throw new Error('Session expired')
        }
        if (!retry.ok) {
          const err = await retry.json().catch(() => ({}))
          throw new Error((err as any).detail || `Request failed (${retry.status})`)
        }
        if (retry.status === 204) return undefined as T
        return retry.json()
      }
      if (!silent) signOut()
      throw new Error('Session expired')
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error((err as any).detail || `Request failed (${res.status})`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

export async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export async function apiPut<T = any>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

export async function apiPatch<T = any>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function apiDelete(path: string): Promise<void> {
  await apiFetch(path, { method: 'DELETE' })
}

export interface ExportResult {
  filename: string
  rows: number
  truncated: boolean
}

/**
 * Download a file from the export engine.
 *
 * Three things this fixes over the previous version:
 *  - A 401 now refreshes and retries, as apiFetch does. It used to sign the user
 *    straight out, so starting an export with an expired access token but a
 *    perfectly valid refresh cookie threw you to the login screen.
 *  - POST is supported, so a request can carry a body (column selection,
 *    filters) instead of being squeezed into a query string.
 *  - The filename comes from the server's Content-Disposition rather than being
 *    guessed client-side, so a .xlsx is not saved as ".csv" — which is exactly
 *    what the old hardcoded `${filename}_${date}.csv` did to every format.
 */
export async function apiExport(
  path: string,
  opts?: { method?: string; body?: unknown; fallbackName?: string },
): Promise<ExportResult> {
  const method = (opts?.method ?? 'GET').toUpperCase()
  const isMutation = method !== 'GET' && method !== 'HEAD'

  const send = () => fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(opts?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isMutation ? { 'X-CSRF-Token': getCsrfToken() } : {}),
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  let res = await send()
  if (res.status === 401) {
    // The handler never ran, so nothing partially succeeded — safe to replay.
    if (await refreshSession()) {
      res = await send()
    }
    if (res.status === 401) { signOut(); throw new Error('Session expired') }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Export failed' }))
    throw new Error((err as any).detail || `Export failed (${res.status})`)
  }

  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = /filename="?([^"';]+)"?/i.exec(disposition)
  const filename = res.headers.get('X-Export-Filename')
    || match?.[1]
    || opts?.fallbackName
    || 'export'

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)

  return {
    filename,
    rows: Number(res.headers.get('X-Export-Rows') ?? 0),
    truncated: res.headers.get('X-Export-Truncated') === 'true',
  }
}

// ── Response-envelope helpers ───────────────────────────────────────────────
// The backend is inconsistent: respond() wraps payloads as { data, data_source,
// data_as_of }, while some handlers return the payload bare. These helpers read
// either shape, so pages never crash or blank on the wrong nesting. Prefer these
// (or the inline `Array.isArray(x) ? x : (x?.data ?? [])` idiom) in all new code.

/** Return the object payload whether the response is wrapped ({data:…}) or bare. */
export function unwrap<T = any>(res: any): T {
  return (res && typeof res === 'object' && 'data' in res ? res.data : res) as T
}

/** Return an array payload whether the response is a bare array or { data: [] }. */
export function unwrapList<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res
  if (res && Array.isArray(res.data)) return res.data
  return []
}
