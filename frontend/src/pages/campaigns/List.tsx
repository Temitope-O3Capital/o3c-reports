import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, btnPrimary, btnSecondary, KpiCard, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime, fmtPct, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>
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
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${m.color}14`, color: m.color }}>
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

const BLANK = { name: '', description: '', type: 'email', list_id: '', scheduled_at: '', sms_body: '', email_subject: '' }

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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore]     = useState(false)
  const [page, setPage]           = useState(1)
  const [err, setErr]             = useState<string | null>(null)
  const [typeFilter, setTypeFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [form, setForm]           = useState(BLANK)
  const [saving, setSaving]       = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setPage(1)
    try {
      const p = new URLSearchParams({ limit: '50', offset: '0' })
      if (typeFilter)   p.set('type',   typeFilter)
      if (statusFilter) p.set('status', statusFilter)
      if (dateFrom)     p.set('from',   dateFrom)
      if (dateTo)       p.set('to',     dateTo)
      const [res, ls] = await Promise.all([
        apiFetch<{ total: number; campaigns: Campaign[] }>(`/api/campaigns?${p}`),
        apiFetch<ContactList[] | { data: ContactList[] }>('/api/contact-lists?limit=200'),
      ])
      const newCampaigns = Array.isArray(res?.campaigns) ? res.campaigns : []
      setCampaigns(newCampaigns)
      setTotal(res?.total ?? 0)
      setHasMore(newCampaigns.length === 50)
      const lsArr = Array.isArray(ls) ? ls : ((ls as any)?.data ?? [])
      setLists(Array.isArray(lsArr) ? lsArr : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter, dateFrom, dateTo])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const nextPage = page + 1
      const p = new URLSearchParams({ limit: '50', offset: String((nextPage - 1) * 50) })
      if (typeFilter)   p.set('type',   typeFilter)
      if (statusFilter) p.set('status', statusFilter)
      if (dateFrom)     p.set('from',   dateFrom)
      if (dateTo)       p.set('to',     dateTo)
      const res = await apiFetch<{ total: number; campaigns: Campaign[] }>(`/api/campaigns?${p}`)
      const newCampaigns = Array.isArray(res?.campaigns) ? res.campaigns : []
      setCampaigns(prev => [...prev, ...newCampaigns])
      setPage(nextPage)
      setHasMore(newCampaigns.length === 50)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoadingMore(false) }
  }

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
      const isSMSType   = form.type === 'sms'   || form.type === 'multi'
      const isEmailType = form.type === 'email'  || form.type === 'multi'
      const body: Record<string, any> = { name: form.name.trim(), type: form.type }
      if (form.description.trim()) body.description   = form.description.trim()
      if (form.list_id)            body.list_id        = Number(form.list_id)
      if (form.scheduled_at)       body.scheduled_at   = form.scheduled_at
      if (isSMSType   && form.sms_body.trim())     body.sms_body      = form.sms_body.trim()
      if (isEmailType && form.email_subject.trim()) body.email_subject = form.email_subject.trim()
      const camp = await apiPost<{ id: number }>('/api/campaigns', body)
      setShowCreate(false); setForm(BLANK)
      navigate(`/campaigns/${camp.id}/report`)
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
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</div>
          {r.list_name && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.list_name}</div>}
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
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.scheduled_at)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    ...(canWrite ? [{
      key: 'id', label: 'Actions', align: 'right' as const,
      render: (r: Campaign) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {(r.status === 'draft' || r.status === 'scheduled') && (
            <button onClick={e => { e.stopPropagation(); navigate(`/campaigns/${r.id}/report`) }}
              style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px' }}>
              Edit
            </button>
          )}
          {(r.status === 'draft' || r.status === 'scheduled') && (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'start') }}
              style={{ ...btnPrimary, fontSize: TEXT.xs, padding: '3px 10px', background: GREEN, borderColor: GREEN }}>
              Start
            </button>
          )}
          {r.status === 'active' && (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'pause') }}
              style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px' }}>
              Pause
            </button>
          )}
          {r.status === 'paused' && (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'start') }}
              style={{ ...btnPrimary, fontSize: TEXT.xs, padding: '3px 10px', background: GREEN, borderColor: GREEN }}>
              Resume
            </button>
          )}
          {r.status !== 'cancelled' && r.status !== 'completed' && (
            <button onClick={e => { e.stopPropagation(); doAction(r.id, 'cancel') }}
              style={{ ...btnSecondary, fontSize: TEXT.xs, padding: '3px 10px', color: RED, borderColor: `${RED}40` }}>
              Cancel
            </button>
          )}
        </div>
      ),
    }] : []),
  ]

  return (
    <Page
      title="Campaigns"
      subtitle={`${fmtNum(total)} total campaigns`}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canWrite && (
            <button onClick={() => setShowCreate(true)} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              New Campaign
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />
      {actionErr && <ErrBanner error={actionErr} />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[5] }}>
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

      <SectionCard title="All Campaigns" badge={campaigns.length} padding={false} actions={<button onClick={() => exportCampaignsCsv(campaigns)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        {hasMore && (
          <div style={{ padding: '6px 16px', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)', fontSize: TEXT.sm, color: 'var(--txt3)' }}>
            Showing {campaigns.length} of {fmtNum(total)} campaigns
          </div>
        )}
        <DataTable<Campaign>
          cols={cols}
          rows={campaigns}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/campaigns/${r.id}/report`)}
          emptyText="No campaigns found."
          skeletonRows={loading ? 8 : 0}
          searchKeys={['name', 'status', 'type']}
          searchPlaceholder="Search campaigns…"
          pageSize={20}
        />
        {hasMore && (
          <div style={{ padding: '12px', borderTop: '1px solid var(--bdr)', textAlign: 'center' }}>
            <button onClick={loadMore} disabled={loadingMore}
              style={{ padding: '7px 20px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: loadingMore ? 'default' : 'pointer', fontFamily: INTER }}>
              {loadingMore ? 'Loading…' : `Load more (${fmtNum(total - campaigns.length)} remaining)`}
            </button>
          </div>
        )}
      </SectionCard>

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setForm(BLANK); setActionErr(null) }}
        title="New Campaign"
        width={580}
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: TEXT.sm, color: RED }}>{actionErr || ''}</div>
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
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CAMPAIGN NAME *</div>
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
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>DESCRIPTION <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span></div>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of this campaign's goal"
              rows={2}
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 'auto', resize: 'none', lineHeight: 1.6, padding: '8px 12px' }}
            />
          </div>

          {/* Channel */}
          <div>
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 8 }}>CHANNEL</div>
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
                    flex: 1, padding: '10px 8px', borderRadius: RADIUS.md, cursor: 'pointer',
                    border: `1.5px solid ${form.type === ch.value ? BLUE : 'var(--bdr)'}`,
                    background: form.type === ch.value ? `${BLUE}10` : 'var(--card)',
                    color: form.type === ch.value ? BLUE : 'var(--txt2)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: INTER, transition: 'all 0.12s',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{ch.icon}</span>
                  {ch.label}
                </button>
              ))}
            </div>
          </div>

          {/* Email subject — shown for email + multi */}
          {(form.type === 'email' || form.type === 'multi') && (
            <div>
              <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>
                EMAIL SUBJECT
              </div>
              <input
                value={form.email_subject}
                onChange={e => setForm(f => ({ ...f, email_subject: e.target.value }))}
                placeholder="e.g. Your O3 Capital statement is ready"
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 36 }}
              />
            </div>
          )}

          {/* SMS body — shown for sms + multi */}
          {(form.type === 'sms' || form.type === 'multi') && (
            <div>
              <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>
                SMS MESSAGE
                <span style={{ fontWeight: 400, marginLeft: 6, color: form.sms_body.length > 160 ? RED : 'var(--txt3)' }}>
                  {form.sms_body.length}/160{form.sms_body.length > 160 ? ` (${Math.ceil(form.sms_body.length / 153)} SMS parts)` : ''}
                </span>
              </div>
              <textarea
                spellCheck={false}
                value={form.sms_body}
                onChange={e => setForm(f => ({ ...f, sms_body: e.target.value }))}
                placeholder={`Write your SMS message. Use {{firstName}}, {{lastName}} for personalisation.`}
                rows={4}
                maxLength={480}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 'auto', resize: 'vertical', lineHeight: 1.6, padding: '8px 12px' }}
              />
            </div>
          )}

          {/* Contact list + Schedule (2-col) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>CONTACT LIST</div>
              <select value={form.list_id} onChange={e => setForm(f => ({ ...f, list_id: e.target.value }))}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', height: 36 }}>
                <option value="">— Select a list —</option>
                {lists.map(l => (
                  <option key={l.id} value={l.id}>{l.name} ({fmtNum(Number(l.member_count ?? 0))})</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 5 }}>SCHEDULE <span style={{ fontWeight: 400 }}>(optional)</span></div>
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
