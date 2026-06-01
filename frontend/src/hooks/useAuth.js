import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const CRM        = ['crm_pipeline','crm_contacts','crm_tasks','crm_requests']
const CRM_REPORT = ['crm_reports']

const ROLE_PAGES = {
  admin:       ['overview','transactions','collections','recovery','sales','cards','cohort','admin', ...CRM, ...CRM_REPORT],
  management:  ['overview','transactions','collections','recovery','sales','cards','cohort',          ...CRM, ...CRM_REPORT],
  sales:       ['sales','overview',                                                                   ...CRM, ...CRM_REPORT],
  collections: ['collections','recovery',                                                             ...CRM],
  recovery:    ['recovery','collections',                                                             ...CRM],
  cards_ops:   ['cards','transactions','overview'],
  call_centre: ['overview','transactions','crm_requests'],
}

function parseToken(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

export function useAuth() {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('o3c_token')
    if (!token) { setLoading(false); return }
    const payload = parseToken(token)
    if (!payload || payload.exp * 1000 < Date.now()) {
      localStorage.removeItem('o3c_token')
      localStorage.removeItem('o3c_user')
      setLoading(false)
      return
    }
    const stored = localStorage.getItem('o3c_user')
    if (stored) setUser(JSON.parse(stored))
    setLoading(false)
  }, [])

  const login = useCallback(async (email, password) => {
    const body = new URLSearchParams({ username: email, password })
    const res = await fetch(`${API}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || 'Login failed')
    }
    const data = await res.json()
    localStorage.setItem('o3c_token', data.access_token)
    localStorage.setItem('o3c_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('o3c_token')
    localStorage.removeItem('o3c_user')
    setUser(null)
  }, [])

  const canAccess = useCallback((page) => {
    if (!user) return false
    const allowed = ROLE_PAGES[user.role] || []
    return allowed.includes(page)
  }, [user])

  return { user, loading, login, logout, canAccess, ROLE_PAGES }
}
