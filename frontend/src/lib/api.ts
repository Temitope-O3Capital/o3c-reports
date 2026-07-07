export const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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

  const makeHeaders = (): HeadersInit => ({
    'Content-Type': 'application/json',
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
      // Never retry a mutation — the request body is consumed and the operation
      // may have partially succeeded on the server before returning 401.
      if (isMutation) {
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

export async function apiDelete(path: string): Promise<void> {
  await apiFetch(path, { method: 'DELETE' })
}

export async function apiExport(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API}${path}`, { credentials: 'include' })
  if (res.status === 401) { signOut(); return }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Export failed' }))
    throw new Error(err.detail || 'Export failed')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
