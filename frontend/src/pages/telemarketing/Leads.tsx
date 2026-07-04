import { useState, useEffect, useCallback } from 'react'
import {
  Page, FilterBar, ErrBanner, Spinner, filterInputStyle,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Lead {
  id:              number
  campaign_id:     number | null
  campaign_name:   string | null
  customer_cif:    string | null
  customer_name:   string
  customer_phone:  string | null
  employer:        string | null
  lead_score:      number
  status:          string
  assigned_to:     number | null
  agent_name:      string | null
  last_called_at:  string | null
  callback_at:     string | null
  notes:           string | null
  created_at:      string
  last_outcome:    string | null
}

interface TMCampaign { id: number; name: string }

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:   '#6B7280',
  called:    BLUE,
  callback:  AMBER,
  no_answer: '#9CA3AF',
  converted: GREEN,
  dnc:       RED,
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

const OUTCOMES = [
  { value: 'interested',     label: 'Interested' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'callback',       label: 'Callback' },
  { value: 'no_answer',      label: 'No Answer' },
  { value: 'voicemail',      label: 'Voicemail' },
  { value: 'dnc',            label: 'Do Not Call' },
  { value: 'converted',      label: 'Converted' },
]

const OUTCOME_COLOR: Record<string, string> = {
  interested:     GREEN,
  converted:      GREEN,
  not_interested: RED,
  callback:       AMBER,
  no_answer:      '#9CA3AF',
  voicemail:      '#9CA3AF',
  dnc:            RED,
}

// ── Disposition form ──────────────────────────────────────────────────────────

function DispositionForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [outcome, setOutcome]   = useState('no_answer')
  const [notes, setNotes]       = useState('')
  const [callbackAt, setCallbackAt] = useState('')
  const [duration, setDuration] = useState('')
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  const isCallback = outcome === 'callback'

  async function submit() {
    setSaving(true); setErr(null)
    try {
      const body: Record<string, any> = { outcome, notes: notes || undefined }
      if (duration) body.duration_sec = Number(duration)
      if (isCallback && callbackAt) body.callback_at = callbackAt
      await apiPost(`/api/telemarketing/leads/${lead.id}/disposition`, body)
      toast.success('Disposition logged')
      setNotes(''); setDuration(''); setCallbackAt('')
      onDone()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <div style={{ color: '#EF4444', fontSize: 12 }}>{err}</div>}
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Outcome *</label>
        <select value={outcome} onChange={e => setOutcome(e.target.value)}
          style={{ ...filterInputStyle, width: '100%' }}>
          {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {isCallback && (
        <div>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Callback Date/Time</label>
          <input type="datetime-local" value={callbackAt} onChange={e => setCallbackAt(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
        </div>
      )}
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Duration (seconds)</label>
        <input type="number" value={duration} onChange={e => setDuration(e.target.value)}
          placeholder="e.g. 120" style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)}
          rows={3} placeholder="Call notes…"
          style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'none' }} />
      </div>
      <button onClick={submit} disabled={saving}
        style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 6, fontFamily: INTER }}>
        {saving && <Spinner size={13} color="#fff" />}
        Log Disposition
      </button>
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ lead, onRefresh }: { lead: Lead; onRefresh: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Contact header */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)', marginBottom: 2 }}>{lead.customer_name}</div>
        {lead.customer_phone && (
          <div style={{ fontSize: 14, color: NAVY, fontWeight: 600, marginBottom: 4 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14, verticalAlign: 'middle', marginRight: 4 }}>call</span>
            {lead.customer_phone}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <StatusPill status={lead.status} />
          {lead.campaign_name && (
            <span style={{ fontSize: 11, background: `${PURPLE}14`, color: PURPLE, padding: '2px 8px', borderRadius: 20, fontWeight: 600 }}>
              {lead.campaign_name}
            </span>
          )}
        </div>
      </div>

      {/* Lead info */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Lead Info</div>
        {[
          ['CIF',          lead.customer_cif],
          ['Employer',     lead.employer],
          ['Lead Score',   String(lead.lead_score ?? 0)],
          ['Assigned To',  lead.agent_name],
          ['Last Called',  lead.last_called_at ? fmtDatetime(lead.last_called_at) : null],
          ['Callback At',  lead.callback_at ? fmtDatetime(lead.callback_at) : null],
          ['Last Outcome', lead.last_outcome],
          ['Notes',        lead.notes],
        ].map(([label, value]) =>
          value ? (
            <div key={label as string} style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)', minWidth: 90, flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: 12.5, color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Log disposition */}
      <div style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Log Call</div>
        <DispositionForm lead={lead} onDone={onRefresh} />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TelemarketingLeads() {
  const [leads, setLeads]         = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<TMCampaign[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [selected, setSelected]   = useState<Lead | null>(null)

  // Filters
  const [campaignId, setCampaignId] = useState('')
  const [status, setStatus]         = useState('')
  const [search, setSearch]         = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const p = new URLSearchParams({ limit: '200' })
    if (campaignId) p.set('campaign_id', campaignId)
    if (status)     p.set('status', status)
    if (search)     p.set('search', search)
    try {
      const res = await apiFetch<Lead[]>(`/api/telemarketing/leads?${p}`)
      setLeads(Array.isArray(res) ? res : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [campaignId, status, search])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    apiFetch<TMCampaign[]>('/api/telemarketing/campaigns').then(r => setCampaigns(Array.isArray(r) ? r : [])).catch(() => {})
  }, [])

  function handleRefresh() {
    load()
    if (selected) {
      // re-select refreshed lead
      setSelected(prev => prev ? leads.find(l => l.id === prev.id) ?? prev : null)
    }
  }

  const pending   = leads.filter(l => l.status === 'pending').length
  const callbacks = leads.filter(l => l.status === 'callback').length
  const converted = leads.filter(l => l.status === 'converted').length

  return (
    <Page title="Marketing Leads" subtitle="Contacts pushed from email & SMS campaigns" noPad>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{ width: 380, minWidth: 320, maxWidth: 420, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--txt)' }}>Marketing Leads</span>
              <span style={{ ...NUM, fontSize: 11, fontWeight: 600, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: 20 }}>
                {leads.length}
              </span>
            </div>

            {/* Mini stats */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {[
                { label: 'Pending',   value: pending,   color: '#6B7280' },
                { label: 'Callbacks', value: callbacks, color: AMBER },
                { label: 'Converted', value: converted, color: GREEN },
              ].map(s => (
                <div key={s.label} style={{ flex: 1, textAlign: 'center', background: 'var(--th-bg)', borderRadius: 8, padding: '6px 4px' }}>
                  <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: 'var(--txt3)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            <FilterBar onReset={() => { setCampaignId(''); setStatus(''); setSearch('') }}>
              <select value={campaignId} onChange={e => setCampaignId(e.target.value)} style={{ ...filterInputStyle, flex: 1 }}>
                <option value="">All Campaigns</option>
                {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
              <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...filterInputStyle, flex: 1 }}>
                <option value="">All Status</option>
                <option value="pending">Pending</option>
                <option value="called">Called</option>
                <option value="callback">Callback</option>
                <option value="no_answer">No Answer</option>
                <option value="converted">Converted</option>
                <option value="dnc">DNC</option>
              </select>
              <input
                placeholder="Search name, phone…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ ...filterInputStyle, flex: 1 }}
              />
            </FilterBar>
          </div>

          {err && <div style={{ padding: '8px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* Lead list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : leads.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
                No leads yet. Push contacts from a campaign report.
              </div>
            ) : leads.map(lead => {
              const isSelected = selected?.id === lead.id
              const oc = OUTCOME_COLOR[lead.last_outcome ?? ''] ?? '#6B7280'
              return (
                <div
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  style={{
                    padding: '11px 14px', borderBottom: '1px solid var(--bdr)',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(14,40,65,0.06)' : undefined,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{lead.customer_name}</span>
                    <StatusPill status={lead.status} />
                  </div>
                  {lead.customer_phone && (
                    <div style={{ fontSize: 12, color: NAVY, fontWeight: 500, marginBottom: 3 }}>{lead.customer_phone}</div>
                  )}
                  {lead.campaign_name && (
                    <div style={{ fontSize: 11, color: PURPLE, marginBottom: 3 }}>{lead.campaign_name}</div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {lead.last_outcome && (
                      <span style={{ fontSize: 10.5, color: oc, fontWeight: 600 }}>{lead.last_outcome.replace(/_/g, ' ')}</span>
                    )}
                    {lead.last_called_at && (
                      <span style={{ fontSize: 10.5, color: 'var(--txt3)' }}>{fmtDatetime(lead.last_called_at)}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Right panel ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel key={selected.id} lead={selected} onRefresh={handleRefresh} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>contacts</span>
              <span style={{ fontSize: 14 }}>Select a lead to log a call</span>
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}
