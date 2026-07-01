export const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function signOut() {
  localStorage.removeItem('o3c_token')
  localStorage.removeItem('o3c_user')
  window.dispatchEvent(new CustomEvent('auth:expired'))
}

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('o3c_token')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (res.status === 401) {
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
  const token = localStorage.getItem('o3c_token')
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) {
    signOut()
    return
  }
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
