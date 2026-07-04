export const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)o3c_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
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
    return res.ok
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
  fetch(`${API}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-CSRF-Token': getCsrfToken() },
  }).catch(() => {})
  window.dispatchEvent(new CustomEvent('auth:expired'))
}

export async function apiLogout(): Promise<void> {
  localStorage.removeItem('o3c_user')
  try {
    await fetch(`${API}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    })
  } catch { /* best-effort */ }
}

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  const makeHeaders = (): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(isMutation ? { 'X-CSRF-Token': getCsrfToken() } : {}),
    ...(init?.headers ?? {}),
  })

  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      signal: init?.signal ?? controller.signal,
      headers: makeHeaders(),
    })

    if (res.status === 401) {
      // Never retry a mutation — the request body is consumed and the operation
      // may have partially succeeded on the server before returning 401.
      if (isMutation) {
        signOut()
        throw new Error('Session expired')
      }
      const ok = await refreshSession()
      if (ok) {
        const retry = await fetch(`${API}${path}`, {
          ...init,
          credentials: 'include',
          signal: controller.signal,
          headers: makeHeaders(),
        })
        if (retry.status === 401) { signOut(); throw new Error('Session expired') }
        if (!retry.ok) {
          const err = await retry.json().catch(() => ({}))
          throw new Error((err as any).detail || `Request failed (${retry.status})`)
        }
        if (retry.status === 204) return undefined as T
        return retry.json()
      }
      signOut()
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
