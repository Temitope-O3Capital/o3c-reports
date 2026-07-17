import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { NAVY, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface Module {
  key:        string
  label:      string
  enabled:    boolean
  sort_order: number
  updated_at: string | null
  updated_by: string | null
}

const MODULE_DESCRIPTIONS: Record<string, string> = {
  sales:      'Business development, sales pipeline, CRM, mail, and campaign tools',
  contact:    'Telemarketing queue, customer service tickets, and call centre tools',
  cards:      'Card issuance, cardholder management, disputes, and billing cycles',
  lending:    'Risk review, collections queue, recovery cases, and loan management',
  finance:    'P&L, EOD, fixed deposits, settlements, and reconciliation',
  compliance: 'AML watchlist, regulatory calendar, audit trail, KYC expiry, and DSAR',
  people:     'HR employee records, leave, payroll, and performance management',
  analytics:  'Reports, KPI tracker, data exports, account statements, and core banking',
}

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function AdminModules() {
  const [modules,  setModules]  = useState<Module[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch('/api/admin/modules')
      setModules(res.data ?? res ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = useCallback(async (mod: Module) => {
    setToggling(mod.key)
    try {
      await apiPut(`/api/admin/modules/${mod.key}`, { enabled: !mod.enabled })
      setModules(prev => prev.map(m =>
        m.key === mod.key ? { ...m, enabled: !m.enabled, updated_at: new Date().toISOString(), updated_by: 'You' } : m
      ))
      toast.success(`${mod.label} ${!mod.enabled ? 'enabled' : 'disabled'}`)

      // Bust the sidebar cache so it refreshes immediately
      localStorage.removeItem('o3c_enabled_modules')
    } catch (e: any) {
      toast.error('Failed to update module: ' + e.message)
    } finally {
      setToggling(null)
    }
  }, [])

  const enabledCount = modules.filter(m => m.enabled).length

  return (
    <Page
      title="Module Management"
      subtitle="Control which product modules are visible to all users across the workspace."
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <>
          {/* Summary strip */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: SP[3],
            padding: '12px 16px', borderRadius: RADIUS.lg, marginBottom: SP[5],
            background: 'var(--th-bg)', border: '1px solid var(--bdr)',
            fontSize: TEXT.sm, color: 'var(--txt2)',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY }}>info</span>
            <span>
              <strong style={{ color: 'var(--txt)' }}>{enabledCount} of {modules.length}</strong> modules active.
              Changes take effect immediately for all users. The <strong style={{ color: 'var(--txt)' }}>Overview</strong> and{' '}
              <strong style={{ color: 'var(--txt)' }}>System Admin</strong> sections are always visible.
            </span>
          </div>

          <SectionCard title="Product Modules">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {modules.map((mod, i) => (
                <div
                  key={mod.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: SP[4],
                    padding: '16px 0',
                    borderBottom: i < modules.length - 1 ? '1px solid var(--bdr)' : 'none',
                    opacity: toggling === mod.key ? 0.6 : 1,
                    transition: 'opacity .15s',
                  }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: mod.enabled ? GREEN : 'var(--bdr)',
                    boxShadow: mod.enabled ? `0 0 0 3px ${GREEN}22` : 'none',
                    transition: 'background .2s, box-shadow .2s',
                  }} />

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 3 }}>
                      {mod.label}
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
                      {MODULE_DESCRIPTIONS[mod.key] ?? ''}
                    </div>
                  </div>

                  {/* Last updated */}
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textAlign: 'right', flexShrink: 0, minWidth: 160 }}>
                    {mod.updated_by || mod.updated_at ? (
                      <>
                        <div>{mod.updated_by ?? ''}</div>
                        <div>{fmtDate(mod.updated_at)}</div>
                      </>
                    ) : (
                      <div>Never changed</div>
                    )}
                  </div>

                  {/* Toggle */}
                  <button
                    onClick={() => toggle(mod)}
                    disabled={toggling === mod.key}
                    title={mod.enabled ? 'Disable module' : 'Enable module'}
                    style={{
                      flexShrink: 0,
                      width: 44, height: 24, borderRadius: RADIUS.full,
                      border: 'none', cursor: toggling === mod.key ? 'not-allowed' : 'pointer',
                      background: mod.enabled ? NAVY : 'var(--bdr)',
                      position: 'relative', transition: 'background .2s',
                      padding: 0,
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 3,
                      left: mod.enabled ? 23 : 3,
                      width: 18, height: 18, borderRadius: '50%',
                      background: '#fff',
                      transition: 'left .2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,.25)',
                    }} />
                  </button>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Warning */}
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.7, marginTop: SP[4] }}>
            <strong>Note:</strong> Disabling a module hides its sidebar entries and prevents navigation to those pages.
            Existing data is never deleted — re-enabling the module restores full access immediately.
          </p>
        </>
      )}
    </Page>
  )
}
