import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, SORA, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Integration {
  id:               number
  name:             string
  type:             string
  status:           'active' | 'degraded' | 'down' | 'unknown'
  health_url:       string
  last_ping:        string | null
  last_status_code: number | null
  key_expiry:       string | null
  owner:            string
  notes:            string
  updated_at:       string
}

const EMPTY: Omit<Integration, 'id' | 'updated_at' | 'last_ping' | 'last_status_code'> = {
  name: '', type: '', status: 'unknown', health_url: '', key_expiry: '', owner: 'IT Admin', notes: '',
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { dot: string; txt: string }> = {
  active:   { dot: GREEN,      txt: GREEN      },
  degraded: { dot: AMBER,      txt: AMBER      },
  down:     { dot: RED,        txt: RED        },
  unknown:  { dot: 'var(--chart-lbl)',  txt: '#6B7280'  },
}

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.unknown
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[1] }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: c.txt, textTransform: 'capitalize' }}>{status}</span>
    </div>
  )
}

// ── Edit / Create form ────────────────────────────────────────────────────────

interface FormProps {
  initial:  Partial<Integration>
  title:    string
  onSave:   (body: Partial<Integration>) => Promise<void>
  onClose:  () => void
  saving:   boolean
}

function IntegForm({ initial, title, onSave, onClose, saving }: FormProps) {
  const [form, setForm] = useState({ ...EMPTY, ...initial })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
      {[
        { label: 'Name',           key: 'name'       as const, type: 'text' },
        { label: 'Type',           key: 'type'       as const, type: 'text' },
        { label: 'Owner',          key: 'owner'      as const, type: 'text' },
        { label: 'Health URL',     key: 'health_url' as const, type: 'url'  },
        { label: 'Key Expiry',     key: 'key_expiry' as const, type: 'date' },
      ].map(({ label, key, type }) => (
        <div key={key}>
          <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
          <input type={type} value={(form as unknown as Record<string, string>)[key] ?? ''} onChange={set(key)}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', fontFamily: SORA }} />
        </div>
      ))}
      <div>
        <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Status</label>
        <select value={form.status} onChange={set('status')}
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', fontFamily: SORA }}>
          {['active', 'degraded', 'down', 'unknown'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.notes} onChange={set('notes')} rows={3}
          style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical', fontFamily: SORA }} />
      </div>
      <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={() => onSave(form)} disabled={saving}
          style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: SP[1], fontFamily: INTER }}>
          {saving && <Spinner size={13} color="#fff" />}
          {title}
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminIntegrations() {
  const [list,       setList]       = useState<Integration[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [editing,    setEditing]    = useState<Integration | null>(null)
  const [showNew,    setShowNew]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [pinging,    setPinging]    = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<{ data: Integration[] }>('/api/admin/integrations')
      setList(data.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(body: Partial<Integration>) {
    setSaving(true)
    try {
      await apiPost('/api/admin/integrations', body)
      toast.success('Integration registered')
      setShowNew(false); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleUpdate(body: Partial<Integration>) {
    if (!editing) return
    setSaving(true)
    try {
      await apiFetch(`/api/admin/integrations/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      toast.success('Integration updated')
      setEditing(null); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleDelete(integ: Integration) {
    if (!confirm(`Delete "${integ.name}"?`)) return
    try {
      await apiFetch(`/api/admin/integrations/${integ.id}`, { method: 'DELETE' })
      toast.success('Deleted')
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  async function ping(integ: Integration) {
    setPinging(integ.id)
    try {
      const result = await apiPost<{ status: string; status_code?: number; note?: string }>(
        `/api/admin/integrations/${integ.id}/ping`, {}
      )
      const label = result.status_code ? ` (HTTP ${result.status_code})` : (result.note ? ` — ${result.note}` : '')
      toast.success(`${integ.name}: ${result.status}${label}`)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setPinging(null) }
  }

  const types     = [...new Set(list.map(i => i.type))].sort()
  const displayed = typeFilter ? list.filter(i => i.type === typeFilter) : list
  const counts    = { active: 0, degraded: 0, down: 0, unknown: 0 }
  list.forEach(i => { (counts as Record<string, number>)[i.status] = ((counts as Record<string, number>)[i.status] ?? 0) + 1 })

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Integrations"
      subtitle="External service registry — status, credentials, and health"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: SP[1], padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md,
          border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          Register
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 20 }}>
        {([['Active', GREEN], ['Degraded', AMBER], ['Down', RED], ['Unknown', 'var(--chart-lbl)']] as [string, string][]).map(([label, color]) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], marginBottom: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
            </div>
            <div style={{ fontSize: 24, fontWeight: FW.extrabold, color }}>{(counts as Record<string, number>)[label.toLowerCase()] ?? 0}</div>
          </div>
        ))}
      </div>

      <SectionCard title="All Integrations" badge={displayed.length} padding={false}
        actions={
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        }
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={28} /></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Integration', 'Type', 'Status', 'Last Ping', 'Owner', 'Notes', ''].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map(integ => (
                <tr key={integ.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '11px 16px', fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{integ.name}</td>
                  <td style={{ padding: '11px 16px' }}>
                    <span style={{ fontSize: TEXT.xs, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: RADIUS.sm, padding: '2px 8px', fontWeight: FW.semibold }}>{integ.type}</span>
                  </td>
                  <td style={{ padding: '11px 16px' }}><StatusBadge status={integ.status} /></td>
                  <td style={{ padding: '11px 16px', fontSize: TEXT.sm, color: 'var(--txt3)' }}>
                    {integ.last_ping ? fmtDatetime(integ.last_ping) : '—'}
                    {integ.last_status_code ? <span style={{ marginLeft: 5, fontSize: TEXT.xs, color: 'var(--txt3)' }}>HTTP {integ.last_status_code}</span> : null}
                  </td>
                  <td style={{ padding: '11px 16px', fontSize: TEXT.sm, color: 'var(--txt2)' }}>{integ.owner}</td>
                  <td style={{ padding: '11px 16px', fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 200 }}>
                    <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                      {integ.notes || '—'}
                    </span>
                  </td>
                  <td style={{ padding: '11px 16px' }}>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button onClick={() => ping(integ)} disabled={pinging === integ.id}
                        style={{ padding: '3px 9px', borderRadius: RADIUS.sm, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: SP[1] }}>
                        {pinging === integ.id ? <Spinner size={10} /> : null}
                        Ping
                      </button>
                      <button onClick={() => setEditing(integ)}
                        style={{ padding: '3px 9px', borderRadius: RADIUS.sm, border: 'none', background: `${NAVY}12`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                        Edit
                      </button>
                      <button onClick={() => handleDelete(integ)}
                        style={{ padding: '3px 9px', borderRadius: RADIUS.sm, border: 'none', background: `${RED}10`, color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
                        Del
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* Edit modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit — ${editing?.name ?? ''}`} width={480}>
        {editing && (
          <IntegForm
            initial={editing}
            title="Save"
            onSave={handleUpdate}
            onClose={() => setEditing(null)}
            saving={saving}
          />
        )}
      </Modal>

      {/* Create modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="Register Integration" width={480}>
        <IntegForm
          initial={EMPTY}
          title="Register"
          onSave={handleCreate}
          onClose={() => setShowNew(false)}
          saving={saving}
        />
      </Modal>
    </Page>
  )
}
