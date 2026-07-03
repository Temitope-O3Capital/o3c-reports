import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { GREEN, NAVY, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotifSettings {
  [key: string]: boolean | string | number
}

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
        background: checked ? GREEN : 'var(--bdr)',
        position: 'relative', flexShrink: 0, transition: 'background .2s',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  )
}

// ── Default settings structure ────────────────────────────────────────────────

const DEFAULT_SETTINGS: NotifSettings = {
  loan_approved: true,
  loan_declined: true,
  loan_disbursed: true,
  repayment_due: true,
  repayment_received: true,
  overdue_alert: true,
  writeoff_trigger: true,
  new_dispute: true,
  dispute_resolved: true,
  new_ticket: true,
  ticket_escalated: true,
  ticket_resolved: true,
  new_user_invited: true,
  user_deactivated: false,
  api_key_rotated: true,
  sync_failure: true,
  sync_success: false,
  budget_threshold: true,
  large_transaction: true,
  fd_maturity: true,
}

const GROUPS: { label: string; icon: string; keys: string[] }[] = [
  { label: 'Loans & Disbursements', icon: 'account_balance', keys: ['loan_approved','loan_declined','loan_disbursed','repayment_due','repayment_received','overdue_alert','writeoff_trigger'] },
  { label: 'Cards & Disputes', icon: 'credit_card', keys: ['new_dispute','dispute_resolved'] },
  { label: 'Helpdesk', icon: 'support_agent', keys: ['new_ticket','ticket_escalated','ticket_resolved'] },
  { label: 'Admin & Security', icon: 'admin_panel_settings', keys: ['new_user_invited','user_deactivated','api_key_rotated'] },
  { label: 'Sync & Data', icon: 'sync', keys: ['sync_failure','sync_success'] },
  { label: 'Finance', icon: 'attach_money', keys: ['budget_threshold','large_transaction','fd_maturity'] },
]

function labelOf(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminNotificationSettings() {
  const [settings, setSettings] = useState<NotifSettings>(DEFAULT_SETTINGS)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [dirty,    setDirty]    = useState(false)
  const [saving,   setSaving]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<NotifSettings>('/api/admin/notification-settings')
      if (data && typeof data === 'object') {
        setSettings({ ...DEFAULT_SETTINGS, ...data })
      }
    } catch (e: any) {
      if (!e.message?.includes('404')) setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function toggle(key: string, val: boolean) {
    setSettings(s => ({ ...s, [key]: val }))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      await apiFetch('/api/admin/notification-settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      })
      toast.success('Notification settings saved')
      setDirty(false)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Notification Settings"
      subtitle="Control which events trigger in-app and email notifications"
      actions={
        dirty ? (
          <button onClick={save} disabled={saving} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 9,
            border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
          }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        ) : null
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--txt3)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {GROUPS.map(group => (
            <SectionCard key={group.label} title={group.label}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {group.keys.map(key => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{labelOf(key)}</div>
                    </div>
                    <Toggle checked={Boolean(settings[key])} onChange={v => toggle(key, v)} />
                  </div>
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </Page>
  )
}
