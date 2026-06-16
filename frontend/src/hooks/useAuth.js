import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const CRM        = ['crm_pipeline','crm_contacts','crm_tasks','crm_requests']
const CRM_REPORT = ['crm_reports']
const CAMPAIGNS  = ['campaigns','contact_lists','message_templates']
const OPERATIONS = ['credit_portfolio','fixed_deposit','settlement','mobile_app','blink_card']

const ROLE_PAGES = {
  // Executive / senior titles
  md:               ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS],
  coo:              ['overview','transactions','collections','recovery','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center','loans',          ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS],
  cfo:              ['overview','income','collections','recovery','executive','transactions','eod','uploads','reconciliation','loans','credit_portfolio','fixed_deposit','settlement'],
  head_it:          ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','admin','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, 'mobile_app','blink_card'],
  head_hr:          ['overview','sales','uploads'],
  cmo:              ['overview','sales','cohort','executive','uploads', ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  head_ops:         ['overview','transactions','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','credit_portfolio','fixed_deposit','settlement', ...CRM],
  head_sales:       ['sales','overview','uploads','executive','loans','credit_portfolio', ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  head_collections: ['collections','recovery','overview','eod','uploads','executive','reconciliation','loans','credit_portfolio', ...CRM],
  head_recovery:    ['recovery','collections','overview','eod','uploads','executive','loans','credit_portfolio', ...CRM],
  // Functional roles
  admin:       ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','admin','executive','income','eod','uploads','reconciliation','call_center','loans', ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS],
  management:  ['overview','transactions','collections','recovery','sales','cards','card_trends','cohort','executive','income','eod','uploads','reconciliation','call_center',                 ...CRM, ...CRM_REPORT, ...CAMPAIGNS, ...OPERATIONS],
  sales:       ['sales','overview','uploads','loans','credit_portfolio',                                                                                                 ...CRM, ...CRM_REPORT, ...CAMPAIGNS],
  collections: ['collections','recovery','eod','uploads','reconciliation','credit_portfolio',                                                                            ...CRM],
  recovery:    ['recovery','collections','eod','uploads','loans','credit_portfolio',                                                                                     ...CRM],
  cards_ops:   ['cards','card_trends','transactions','overview','eod','uploads','blink_card'],
  call_centre: ['overview','transactions','call_center','crm_requests','crm_contacts','uploads'],
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

  // Called after a successful password change — clears the flag
  const clearMustChangePassword = useCallback(() => {
    setUser(u => {
      if (!u) return u
      const updated = { ...u, must_change_password: false }
      localStorage.setItem('o3c_user', JSON.stringify(updated))
      return updated
    })
  }, [])

  return { user, loading, login, logout, canAccess, clearMustChangePassword, ROLE_PAGES }
}
