import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

const CACHE_KEY = 'o3c_enabled_modules'

// All module keys that exist in module_config.
// root and admin are always shown and not stored in the DB.
const ALL_MODULE_KEYS = ['sales', 'contact', 'cards', 'lending', 'finance', 'compliance', 'people', 'analytics']

function readCache(): Set<string> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {}
  return new Set(ALL_MODULE_KEYS) // fail-open: show everything if no cache
}

export function useModules(): Set<string> {
  const [enabled, setEnabled] = useState<Set<string>>(readCache)

  useEffect(() => {
    apiFetch('/api/modules')
      .then(d => {
        const keys: string[] = d.enabled ?? []
        localStorage.setItem(CACHE_KEY, JSON.stringify(keys))
        setEnabled(new Set(keys))
      })
      .catch(() => { /* keep cached value */ })
  }, [])

  return enabled
}
