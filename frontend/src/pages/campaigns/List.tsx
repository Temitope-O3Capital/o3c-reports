import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, btnPrimary, btnSecondary, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime, fmtPct } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number
  name: string
  description?: string
  type: string
  status: string
  list_id?: number
  list_name?: string
  total_contacts?: number
  emails_sent?: number
  emails_delivered?: number
  emails_opened?: number
  emails_clicked?: number
  sms_sent?: number
  sms_delivered?: number
  bounce_count?: number
  unsubscribe_count?: number
  scheduled_at?: string
  started_at?: string
  completed_at?: string
  created_at: string
  created_by_name?: string
  pending_count?: number
  completed_contact_count?: number
}

interface ContactList { id: number; name: string; member_count?: number }

// ── Helpers ────────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = { email: BLUE, sms: PURPLE, multi: GREEN }

function TypePill({ type }: { type: string }) {
  const c = TYPE_COLOR[type] ?? NAVY
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>
      {type.toUpperCase()}
    </span>
  )
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft:     { color: '#6B7280', label: 'Draft' },
  scheduled: { color: AMBER,    label: 'Scheduled' },
  active:    { color: GREEN,    label: 'Active' },
  paused:    { color: AMBER,    label: 'Paused' },
  completed: { color: NAVY,     label: 'Completed' },
  cancelled: { color: RED,      label: 'Cancelled' },
}

function StatusPill({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { color: '#6B7280', label: status }
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${m.color}14`, color: m.color }}>
      {m.label}
    </span>
  )
}

function sentCount(c: Campaign): number {
  return Number(c.emails_sent ?? 0) + Number(c.sms_sent ?? 0)
}

function deliveredCount(c: Campaign): number {
  return Number(c.emails_delivered ?? 0) + Number(c.sms_delivered ?? 0)
}

function openRate(c: Campaign): number {
  const s = sentCount(c)
  return s > 0 ? Number(c.emails_opened ?? 0) / s * 100 : 0
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { name: '', description: '', type: 'email', list_id: '', scheduled_at: '' }

// BD roles can view campaigns but cannot create, start, pause, or cancel them.
const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

export default function CampaignsList() {
  const navigate = useNavigate()
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [total, setTotal]         = useState(0)
  const [lists, setLists]         = useState<ContactList[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [typeFilter, setTypeFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm]           = useState(BLANK)
  const [saving, setSaving]       = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams({ limit: '200' })
      if (typeFilter)   p.set('type',   typeFilter)
      if (statusFilter) p.set('status', statusFilter)
      const [res, ls] = await Promise.all([
        apiFetch<{ total: number; campaigns: Campaign[] }>(`/api/campaigns?${p}`),
        apiFetch<ContactList[]>('/api/contact-lists'),
      ])
      setCampaigns(Array.isArray(res?.campaigns) ? res.campaigns : [])
      setTotal(res?.total ?? 0)
      setLists(Array.isArray(ls) ? ls : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function doAction(id: number, action: 'start' | 'pause' | 'cancel') {
    setActionErr(null)
    try {
      await apiPost(`/api/campaigns/${id}/${action}`, {})
      load()
    } catch (ex: any) { setActionErr(ex.message) }
  }

  async function create() {
    if (!form.name.trim()) return
    setSaving(true); setActionErr(null)
    try {
      const body: Record<string, any> = { name: form.name.trim(), type: form.type }
      if (form.description.trim()) body.description = form.description.trim()
      if (form.list_id) body.list_id = Number(form.list_id)
      if (form.scheduled_at) body.scheduled_at = form.scheduled_at
      await apiPost('/api/campaigns', body)
      setShowCreate(false); setForm(BLANK); load()
    } catch (ex: any) { setActionErr(ex.message) }
    finally { setSaving(false) }
  }

  // KPI counts
  const active    = campaigns.filter(c => c.status === 'active').length
  const scheduled = campaigns.filter(c => c.status === 'scheduled').length
  const completed = campaigns.filter(c => c.status === 'completed').length
  const draft     = campaigns.filter(c => c.status === 'draft').length

  function exportCampaignsCsv(data: Campaign[]) {
    const header = ['Name', 'Type', 'Status', 'Audience', 'Sent', 'Delivered', 'Open Rate', 'Scheduled At', 'Created At']
    const lines = data.map(r => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      r.type ?? '',
      r.status ?? '',
      r.total_contacts != null ? String(r.total_contacts) : '',
      String(sentCount(r)),
      String(deliveredCount(r)),
      openRate(r).toFixed(1) + '%',
      r.scheduled_at ?? '',
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `campaigns-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<Campaign>[] = [
    {
      key: 'name', label: 'Campaign',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</div>
          {r.list_name && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.list_name}</div>}
        </div>
      ),
    },
    { key: 'type',   label: 'Type',   render: r => <TypePill type={r.type} /> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    {
      key: 'total_contacts', label: 'Audience', align: 'right',
      render: r => <span style={NUM}>{fmtNum(Number(r.total_contacts ?? 0))}</span>,
    },
    {
      key: 'emails_sent', label: 'Sent', align: 'right',
      render: r => {
        const s = sentCount(r)
        return s > 0
          ? <span style={NUM}>{fmtNum(s)}</span>
          : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'emails_delivered', label: 'Delivered', align: 'right',
      render: r => {
        const d = deliveredCount(r)
        return d > 0
          ? <span style={{ ...NUM, color: GREEN }}>{fmtNum(d)}</span>
          : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'emails_opened', label: 'Open Rate', align: 'right',
      render: r => {
        const rate = openRate(r)
        return rate > 0
          ? <span style={{ ...NUM, color: BLUE }}>{fmtPct(rate)}</span>
          : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'scheduled_at', label: 'Scheduled',
      render: r => r.scheduled_at
        ? <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(r.scheduled_at)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    ...(canWrite ? [{
      key: 'id', label: 'Actions', align: 'right' as const,
      render: (r: Campaign) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {r.status === 'draft' || r.status === 'scheduled' ? (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'start') }}
              style={{ ...btnPrimary, fontSize: 11, padding: '3px 10px', background: GREEN }}>
              Start
            </button>
          ) : null}
          {r.status === 'active' ? (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'pause') }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px' }}>
              Pause
            </button>
          ) : null}
          {r.status === 'paused' ? (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'start') }}
              style={{ ...btnPrimary, fontSize: 11, padding: '3px 10px' }}>
              Resume
            </button>
          ) : null}
          {r.status !== 'cancelled' && r.status !== 'completed' ? (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'cancel') }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: RED, borderColor: `${RED}40` }}>
              Cancel
            </button>
          ) : null}
        </div>
      ),
    }] : []),
  ]

  return (
    <Page
      title="Campaigns"
      subtitle={`${fmtNum(total)} total campaigns`}
      actions={canWrite ? (
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Campaign
        </button>
      ) : undefined}
    >
      <ErrBanner error={err} onRetry={load} />
      {actionErr && <ErrBanner error={actionErr} />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Active"    value={fmtNum(active)}    accent={GREEN} loading={loading} />
        <KpiCard label="Scheduled" value={fmtNum(scheduled)} accent={AMBER} loading={loading} />
        <KpiCard label="Completed" value={fmtNum(completed)} accent={NAVY}  loading={loading} />
        <KpiCard label="Draft"     value={fmtNum(draft)}     loading={loading} />
      </div>

      <FilterBar onReset={() => { setTypeFilter(''); setStatusFilter('') }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Types</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="multi">Multi-channel</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="scheduled">Scheduled</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <SectionCard title="All Campaigns" badge={campaigns.length} padding={false}>
        <DataTable<Campaign>
          cols={cols}
          rows={campaigns}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/campaigns/${r.id}/report`)}
          emptyText="No campaigns found."
          skeletonRows={loading ? 8 : 0}
          searchKeys={['name', 'status']}
          searchPlaceholder="Search campaigns…"
          pageSize={20}
          onExport={() => exportCampaignsCsv(campaigns)}
        />
      </SectionCard>

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setForm(BLANK); setActionErr(null) }}
        title="New Campaign"
        width={580}
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: RED }}>{actionErr || ''}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowCreate(false); setForm(BLANK); setActionErr(null) }} style={btnSecondary}>Cancel</button>
              <button onClick={create} disabled={saving || !form.name.trim()} style={btnPrimary}>
                {saving ? 'Creating…' : 'Create Campaign'}
              </button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Name */}
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CAMPAIGN NAME *</div>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. July Card Activation Drive"
              autoFocus
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 36 }}
            />
          </div>

          {/* Description */}
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>DESCRIPTION <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span></div>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of this campaign's goal"
              rows={2}
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 'auto', resize: 'none', lineHeight: 1.6, padding: '8px 12px' }}
            />
          </div>

          {/* Channel */}
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 8 }}>CHANNEL</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { value: 'email', icon: 'mail',       label: 'Email' },
                { value: 'sms',   icon: 'smartphone', label: 'SMS' },
                { value: 'multi', icon: 'hub',        label: 'Multi-channel' },
              ] as const).map(ch => (
                <button
                  key={ch.value}
                  onClick={() => setForm(f => ({ ...f, type: ch.value }))}
                  style={{
                    flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer',
                    border: `1.5px solid ${form.type === ch.value ? BLUE : 'var(--bdr)'}`,
                    background: form.type === ch.value ? `${BLUE}10` : 'var(--card)',
                    color: form.type === ch.value ? BLUE : 'var(--txt2)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    fontSize: 12, fontWeight: 600, fontFamily: INTER, transition: 'all 0.12s',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{ch.icon}</span>
                  {ch.label}
                </button>
              ))}
            </div>
          </div>

          {/* Contact list + Schedule (2-col) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CONTACT LIST</div>
              <select value={form.list_id} onChange={e => setForm(f => ({ ...f, list_id: e.target.value }))}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 36 }}>
                <option value="">— Select a list —</option>
                {lists.map(l => (
                  <option key={l.id} value={l.id}>{l.name} ({fmtNum(Number(l.member_count ?? 0))})</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>SCHEDULE <span style={{ fontWeight: 400 }}>(optional)</span></div>
              <input
                type="datetime-local"
                value={form.scheduled_at}
                onChange={e => setForm(f => ({ ...f, scheduled_at: e.target.value }))}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 36 }}
              />
            </div>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
