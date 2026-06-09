import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

/**
 * useApi — fetches from the O3C API and unwraps the dual-source response.
 *
 * API responses have shape: { data: [...], data_source: "mssql_live" | "supabase_snapshot" }
 * This hook returns:
 *   data        — the unwrapped data array or object
 *   dataSource  — "mssql_live" | "supabase_snapshot"
 *   loading     — boolean
 *   error       — string or null
 *   refetch     — function to manually re-fetch
 */
export function useApi(endpoint, deps = []) {
  const [data, setData]             = useState(null)
  const [dataSource, setDataSource] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  const token = localStorage.getItem('o3c_token')

  const fetchData = useCallback(async () => {
    if (!endpoint) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()

      // Unwrap dual-source response
      if (json && typeof json === 'object' && 'data' in json && 'data_source' in json) {
        setData(json.data)
        setDataSource(json.data_source)
      } else {
        // Fallback for endpoints that don't use dual-source pattern
        setData(json)
        setDataSource(null)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [endpoint, token, ...deps])

  useEffect(() => { fetchData() }, [fetchData])

  return { data, dataSource, loading, error, refetch: fetchData }
}

export async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem('o3c_token')
  const res = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  return res.json()
}
