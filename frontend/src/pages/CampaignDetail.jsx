import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'

/* ── Config ── */
const TYPE_CONFIG = {
  sms:   { label: 'SMS',         color: '#059669', bg: '#F0FDF4' },
  email: { label: 'Email',       color: '#3B82F6', bg: '#EFF6FF' },
  multi: { label: 'SMS + Email', color: '#8B5CF6', bg: '#F5F3FF' },
}
const STATUS_CONFIG = {
  draft:     { label: 'Draft',     color: '#6B7280', bg: '#F3F4F6' },
  scheduled: { label: 'Scheduled', color: '#F59E0B', bg: '#FFFBEB' },
  active:    { label: 'Active',    color: '#059669', bg: '#F0FDF4' },
  paused:    { label: 'Paused',    color: '#D97706', bg: '#FFF7ED' },
  completed: { label: 'Completed', color: '#0EA5E9', bg: '#F0F9FF' },
  cancelled: { label: 'Cancelled', color: '#C00000', bg: '#FFF0F0' },
}
const CONTACT_STATUS = {
  pending:   { label: 'Pending',   color: '#6B7280' },
  sent:      { label: 'Sent',      color: '#3B82F6' },
  delivered: { label: 'Delivered', color: '#059669' },
  failed:    { label: 'Failed',    color: '#C00000' },
  opened:    { label: 'Opened',    color: '#8B5CF6' },
  clicked:   { label: 'Clicked',   color: '#0EA5E9' },
  bounced:   { label: 'Bounced',   color: '#D97706' },
}

function Badge({ status, config }) {
  const c = config[status] || { label: status, color: '#6B7280', bg: '#F3F4F6' }
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 999, color: c.color, background: c.bg || c.color + '20',
    }}>{c.label}</span>
  )
}

function StatCard({ label, value, sub, color = '#0E2841', icon }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div style={{ width: 36, height: 36, borderRadius: 8, background: color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color }}>{icon}</span>
      </div>
      <div>
        <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>{label}</p>
        <p style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>{value}</p>
        {sub && <p style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginTop: 1 }}>{sub}</p>}
      </div>
    </div>
  )
}

function ProgressRing({ pct, size = 60, stroke = 6, color = '#059669' }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ
  return (
    <svg width={size} height={size}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgb(var(--bg-muted))" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      <text x={size/2} y={size/2 + 4} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', fill: 'rgb(var(--fg-1))' }}>
        {pct}%
      </text>
    </svg>
  )
}

/* ── Contact table ── */
function ContactTable({ campaignId }) {
  const [contacts, setContacts] = useState([])
  const [total,    setTotal]    = useState(0)
  const [page,     setPage]     = useState(0)
  const [search,   setSearch]   = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading]   = useState(true)
  const LIMIT = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT })
      if (search) qs.set('search', search)
      if (statusFilter) qs.set('status', statusFilter)
      const data = await apiFetch(`/api/campaigns/${campaignId}/contacts?${qs}`)
      setContacts(data.contacts || [])
      setTotal(data.total || 0)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [campaignId, page, search, statusFilter])

  useEffect(() => { load() }, [load])

  const pages = Math.ceil(total / LIMIT)

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <input className="form-input" style={{ maxWidth: 240, fontSize: 12 }}
          placeholder="Search contacts…" value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }} />
        <select className="form-input" style={{ fontSize: 12, padding: '6px 10px', maxWidth: 160 }}
          value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }}>
          <option value="">All statuses</option>
          {Object.entries(CONTACT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'rgb(var(--fg-3))', marginLeft: 'auto' }}>
          {total.toLocaleString()} contacts
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><div className="spinner" /></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Email</th>
                <th>SMS Status</th>
                <th>Email Status</th>
                <th>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'rgb(var(--fg-3))' }}>No contacts</td></tr>
              ) : contacts.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.phone || '—'}</td>
                  <td style={{ fontSize: 12 }}>{c.email || '—'}</td>
                  <td>{c.sms_status ? <Badge status={c.sms_status} config={CONTACT_STATUS} /> : <span style={{ color: 'rgb(var(--fg-4))', fontSize: 12 }}>—</span>}</td>
                  <td>{c.email_status ? <Badge status={c.email_status} config={CONTACT_STATUS} /> : <span style={{ color: 'rgb(var(--fg-4))', fontSize: 12 }}>—</span>}</td>
                  <td style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>
                    {c.sent_at ? new Date(c.sent_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span style={{ fontSize: 12, color: 'rgb(var(--fg-2))', alignSelf: 'center' }}>Page {page + 1} of {pages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}
    </div>
  )
}

/* ── Main ── */
export default function CampaignDetail() {
  const { id }   = useParams()
  const navigate  = useNavigate()
  const [campaign, setCampaign] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [activeTab, setActiveTab]   = useState('overview')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await apiFetch(`/api/campaigns/${id}`)
      setCampaign(data)
    } catch (e) {
      setError(e.message || 'Failed to load campaign')
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  // Refresh every 10s when active
  useEffect(() => {
    if (!campaign || campaign.status !== 'active') return
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [campaign, load])

  const doAction = async (action) => {
    setActionBusy(true)
    try {
      await apiFetch(`/api/campaigns/${id}/${action}`, { method: 'POST' })
      await load()
    } catch (e) {
      alert(e.message || 'Action failed')
    } finally { setActionBusy(false) }
  }

  if (loading) return <PageShell title="Campaign"><div className="flex justify-center py-16"><div className="spinner" /></div></PageShell>
  if (error)   return <PageShell title="Campaign"><div className="card p-8 text-center" style={{ color: '#C00000' }}>{error}</div></PageShell>
  if (!campaign) return null

  const total     = campaign.total_contacts || 0
  const smsDeliv  = campaign.sms_delivered  || 0
  const emailSent = campaign.emails_sent    || 0
  const emailOpen = campaign.emails_opened  || 0
  const emailClick= campaign.emails_clicked || 0
  const smsFailed = campaign.sms_failed     || 0
  const emailFail = campaign.emails_failed  || 0

  const isSms   = campaign.type === 'sms'   || campaign.type === 'multi'
  const isEmail = campaign.type === 'email' || campaign.type === 'multi'
  const openRate  = emailSent > 0 ? Math.round(emailOpen  / emailSent * 100) : 0
  const clickRate = emailOpen > 0 ? Math.round(emailClick / emailOpen * 100) : 0
  const delivRate = total > 0     ? Math.round(smsDeliv   / total     * 100) : 0
  const overallPct = total > 0
    ? Math.round((campaign.processed || 0) / total * 100)
    : 0

  const typeConf   = TYPE_CONFIG[campaign.type]   || TYPE_CONFIG.sms
  const statusConf = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft

  const canStart  = campaign.status === 'draft' || campaign.status === 'paused' || campaign.status === 'scheduled'
  const canPause  = campaign.status === 'active'
  const canCancel = ['draft','scheduled','active','paused'].includes(campaign.status)

  return (
    <PageShell
      title={campaign.name}
      subtitle={campaign.description || typeConf.label}
      actions={
        <div className="flex items-center gap-2">
          {canStart && (
            <button className="btn btn-primary btn-sm" onClick={() => doAction('start')} disabled={actionBusy}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>play_arrow</span>
              {campaign.status === 'paused' ? 'Resume' : 'Launch'}
            </button>
          )}
          {canPause && (
            <button className="btn btn-ghost btn-sm" onClick={() => doAction('pause')} disabled={actionBusy}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>pause</span>
              Pause
            </button>
          )}
          {canCancel && (
            <button className="btn btn-ghost btn-sm" style={{ color: '#C00000' }}
              onClick={() => { if (confirm('Cancel this campaign?')) doAction('cancel') }}
              disabled={actionBusy}>
              Cancel
            </button>
          )}
        </div>
      }
    >
      {/* Status bar */}
      <div className="card p-4 mb-6 flex items-center gap-4">
        <Badge status={campaign.status} config={STATUS_CONFIG} />
        <Badge status={campaign.type} config={Object.fromEntries(Object.entries(TYPE_CONFIG).map(([k,v]) => [k, { label: v.label, color: v.color, bg: v.bg }]))} />
        {total > 0 && (
          <div className="flex items-center gap-3 flex-1">
            <div style={{ flex: 1, height: 8, background: 'rgb(var(--bg-muted))', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${overallPct}%`, height: '100%', background: '#0E2841', borderRadius: 4, transition: 'width 0.4s ease' }} />
            </div>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-2))', whiteSpace: 'nowrap' }}>
              {(campaign.processed || 0).toLocaleString()} / {total.toLocaleString()} processed
            </span>
          </div>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'rgb(var(--fg-3))' }}>
          Created {campaign.created_at ? new Date(campaign.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
          {campaign.created_by_name ? ` by ${campaign.created_by_name}` : ''}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.12)' }}>
        {['overview','contacts','preview'].map(t => (
          <button key={t} type="button"
            onClick={() => setActiveTab(t)}
            style={{
              fontSize: 13, fontWeight: 600, padding: '10px 18px', cursor: 'pointer',
              background: 'none', border: 'none', textTransform: 'capitalize',
              color: activeTab === t ? 'rgb(var(--fg-1))' : 'rgb(var(--fg-3))',
              borderBottom: activeTab === t ? '2px solid #0E2841' : '2px solid transparent',
              marginBottom: -1,
            }}>{t}</button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard label="Total Contacts" value={total.toLocaleString()} icon="group"         color="#0E2841" />
            {isSms && <>
              <StatCard label="SMS Delivered" value={smsDeliv.toLocaleString()} sub={`${delivRate}% delivery rate`} icon="sms" color="#059669" />
              <StatCard label="SMS Failed"    value={smsFailed.toLocaleString()} icon="sms_failed" color="#C00000" />
            </>}
            {isEmail && <>
              <StatCard label="Emails Sent"   value={emailSent.toLocaleString()} icon="email"      color="#3B82F6" />
              <StatCard label="Open Rate"     value={`${openRate}%`}  sub={`${emailOpen.toLocaleString()} opens`}  icon="mark_email_read" color="#8B5CF6" />
              <StatCard label="Click Rate"    value={`${clickRate}%`} sub={`${emailClick.toLocaleString()} clicks`} icon="ads_click"       color="#0EA5E9" />
              <StatCard label="Bounced / Failed" value={(emailFail).toLocaleString()} icon="error_outline" color="#D97706" />
            </>}
          </div>

          {/* Visual rate breakdown */}
          {(isSms || isEmail) && total > 0 && (
            <div className="card p-5 mb-6">
              <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>Performance</p>
              <div className="flex gap-8 flex-wrap">
                {isSms && (
                  <div className="flex items-center gap-4">
                    <ProgressRing pct={delivRate} color="#059669" />
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 700 }}>SMS Delivery</p>
                      <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>{smsDeliv.toLocaleString()} delivered</p>
                    </div>
                  </div>
                )}
                {isEmail && (
                  <>
                    <div className="flex items-center gap-4">
                      <ProgressRing pct={openRate} color="#3B82F6" />
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 700 }}>Open Rate</p>
                        <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>{emailOpen.toLocaleString()} opens</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <ProgressRing pct={clickRate} color="#8B5CF6" />
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 700 }}>Click-to-Open</p>
                        <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>{emailClick.toLocaleString()} clicks</p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Campaign info grid */}
          <div className="card p-5">
            <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>Campaign Details</p>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3">
              {[
                ['Channel',       (TYPE_CONFIG[campaign.type]?.label || campaign.type)],
                ['Status',        (STATUS_CONFIG[campaign.status]?.label || campaign.status)],
                ['Audience List', campaign.list_name  || '—'],
                ['Total Contacts',total.toLocaleString()],
                ...(isSms   ? [['SMS Body Preview', (campaign.sms_body || '—').slice(0, 100) + (campaign.sms_body?.length > 100 ? '…' : '')]] : []),
                ...(isEmail ? [
                  ['From',    `${campaign.from_name || 'O3C Cards'} <${campaign.from_email || '—'}>`],
                  ['Subject', campaign.email_subject || '—'],
                ] : []),
                ['Started',  campaign.started_at  ? new Date(campaign.started_at).toLocaleString('en-GB')  : '—'],
                ['Completed',campaign.completed_at ? new Date(campaign.completed_at).toLocaleString('en-GB') : '—'],
              ].map(([k, v]) => (
                <div key={k}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'rgb(var(--fg-3))', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</span>
                  <p style={{ fontSize: 13, color: 'rgb(var(--fg-1))', marginTop: 2 }}>{v}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {activeTab === 'contacts' && (
        <div className="card p-5">
          <ContactTable campaignId={id} />
        </div>
      )}

      {activeTab === 'preview' && (
        <div className="card p-5">
          {isEmail && campaign.email_body_html ? (
            <div>
              <div style={{ padding: '12px 16px', background: 'rgb(var(--bg-subtle))', borderRadius: 8, marginBottom: 12, fontSize: 12, color: 'rgb(var(--fg-2))' }}>
                <strong>Subject:</strong> {campaign.email_subject}
                <span style={{ marginLeft: 24 }}>
                  <strong>From:</strong> {campaign.from_name || 'O3C Cards'} &lt;{campaign.from_email || '—'}&gt;
                </span>
              </div>
              <div style={{ border: '1px solid rgb(var(--border) / 0.15)', borderRadius: 8, overflow: 'hidden' }}>
                <iframe
                  srcDoc={campaign.email_body_html}
                  style={{ width: '100%', minHeight: 600, border: 'none', display: 'block' }}
                  title="Email body preview"
                />
              </div>
            </div>
          ) : isSms && campaign.sms_body ? (
            <div>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-3))', marginBottom: 12 }}>SMS Preview</p>
              <div style={{ maxWidth: 320, background: '#0E2841', borderRadius: 16, padding: '14px 18px' }}>
                <p style={{ fontSize: 14, color: '#fff', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{campaign.sms_body}</p>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textAlign: 'right', marginTop: 8 }}>O3CCARDS</p>
              </div>
              <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 12 }}>
                Merge tags like {'{{first_name}}'} will be replaced per contact
              </p>
            </div>
          ) : (
            <p style={{ color: 'rgb(var(--fg-3))', fontSize: 13 }}>No message content to preview.</p>
          )}
        </div>
      )}
    </PageShell>
  )
}
