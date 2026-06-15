import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function getToken() {
  return localStorage.getItem('o3c_token')
}

function forceLogout() {
  localStorage.removeItem('o3c_token')
  localStorage.removeItem('o3c_user')
  window.location.href = '/'
}

/**
 * useApi — fetches from the O3C API and unwraps the dual-source response.
 * Token is read fresh on every request so stale closures cannot use expired tokens.
 * 401 responses force a logout and redirect to login.
 */
export function useApi(endpoint, deps = []) {
  const [data, setData]             = useState(null)
  const [dataSource, setDataSource] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  const fetchData = useCallback(async () => {
    if (!endpoint) return
    const token = getToken()
    if (!token) { forceLogout(); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.status === 401) { forceLogout(); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()

      if (json && typeof json === 'object' && 'data' in json && 'data_source' in json) {
        setData(json.data)
        setDataSource(json.data_source)
      } else {
        setData(json)
        setDataSource(null)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [endpoint, ...deps])   // token intentionally NOT in deps — read fresh each call

  useEffect(() => { fetchData() }, [fetchData])

  return { data, dataSource, loading, error, refetch: fetchData }
}

export async function apiFetch(endpoint, options = {}) {
  const token = getToken()
  const { isFormData, ...fetchOptions } = options
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(fetchOptions.headers || {}),
  }
  const res = await fetch(`${API}${endpoint}`, { ...fetchOptions, headers })
  if (res.status === 401) { forceLogout(); return }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}
