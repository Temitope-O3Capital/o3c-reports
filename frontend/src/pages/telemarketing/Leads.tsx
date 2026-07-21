import { useState, useEffect, useCallback } from 'react'
import {
  Page, ErrBanner, Spinner, TblSearch, filterInputStyle, ConfirmModal, DateFilter,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, monthStart, today } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
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
interface TMAgent    { id: number; full_name: string }

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:   '#6B7280',
  called:    BLUE,
  callback:  AMBER,
  no_answer: 'var(--chart-lbl)',
  converted: GREEN,
  dnc:       RED,
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>
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
  no_answer:      'var(--chart-lbl)',
  voicemail:      'var(--chart-lbl)',
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
      {err && <div style={{ color: '#EF4444', fontSize: TEXT.sm }}>{err}</div>}
      <div>
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1], fontFamily: INTER }}>Outcome *</label>
        <select value={outcome} onChange={e => setOutcome(e.target.value)}
          style={{ ...filterInputStyle, width: '100%' }}>
          {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {isCallback && (
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1], fontFamily: INTER }}>Callback Date/Time</label>
          <input type="datetime-local" value={callbackAt} onChange={e => setCallbackAt(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
        </div>
      )}
      <div>
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1], fontFamily: INTER }}>Duration (seconds)</label>
        <input type="number" value={duration} onChange={e => setDuration(e.target.value)}
          placeholder="e.g. 120" style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: SP[1], fontFamily: INTER }}>Notes</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)}
          rows={3} placeholder="Call notes…"
          style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'none' }} />
      </div>
      <button onClick={submit} disabled={saving}
        style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 6, fontFamily: INTER }}>
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
        <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 2 }}>{lead.customer_name}</div>
        {lead.customer_phone && (
          <div style={{ fontSize: TEXT.md, color: NAVY, fontWeight: FW.semibold, marginBottom: SP[1] }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, verticalAlign: 'middle', marginRight: 4 }}>call</span>
            {lead.customer_phone}
          </div>
        )}
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap', marginTop: 6 }}>
          <StatusPill status={lead.status} />
          {lead.campaign_name && (
            <span style={{ fontSize: TEXT.xs, background: `${PURPLE}14`, color: PURPLE, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.campaign_name}
            </span>
          )}
          {lead.agent_name && (
            <span style={{ fontSize: TEXT.xs, background: `${NAVY}10`, color: NAVY, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.agent_name}
            </span>
          )}
        </div>
      </div>

      {/* Lead info */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Lead Info</div>
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
            <div key={label as string} style={{ display: 'flex', gap: SP[2], marginBottom: 7 }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', minWidth: 90, flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Log disposition */}
      <div style={{ padding: `${SP[4]} ${SP[5]}` }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: SP[3] }}>Log Call</div>
        <DispositionForm lead={lead} onDone={onRefresh} />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TelemarketingLeads() {
  const [leads, setLeads]         = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<TMCampaign[]>([])
  const [agents, setAgents]       = useState<TMAgent[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [selected, setSelected]   = useState<Lead | null>(null)

  // Filters
  const [campaignId, setCampaignId] = useState('')
  const [status, setStatus]         = useState('')
  const [search, setSearch]         = useState('')
  const [dateFrom, setDateFrom]     = useState(monthStart())
  const [dateTo,   setDateTo]       = useState(today())

  // Selection
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [assignAgentId, setAssignAgentId] = useState('')

  // Assign actions
  const [assigning, setAssigning]       = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeConfirm, setDistributeConfirm] = useState(false)

  const load = useCallback(async (refreshSelected?: number) => {
    setLoading(true); setErr(null)
    const p = new URLSearchParams({ limit: '200' })
    if (campaignId) p.set('campaign_id', campaignId)
    if (status)     p.set('status', status)
    if (search)     p.set('search', search)
    if (dateFrom)   p.set('from', dateFrom)
    if (dateTo)     p.set('to', dateTo)
    try {
      const res = await apiFetch<Lead[]>(`/api/telemarketing/leads?${p}`)
      const fresh = Array.isArray(res) ? res : []
      setLeads(fresh)
      if (refreshSelected !== undefined) {
        const updated = fresh.find(l => l.id === refreshSelected)
        setSelected(prev => updated ?? prev)
      }
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [campaignId, status, search, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    apiFetch<TMCampaign[]>('/api/telemarketing/campaigns')
      .then(r => setCampaigns(Array.isArray(r) ? r : [])).catch(() => {})
    apiFetch<TMAgent[]>('/api/telemarketing/agents')
      .then(r => setAgents(Array.isArray(r) ? r : [])).catch(() => {})
  }, [])

  function handleRefresh() {
    load(selected?.id)
  }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() {
    setCheckedIds(new Set())
    setAssignAgentId('')
  }

  async function handleAssign() {
    if (!assignAgentId || checkedIds.size === 0) return
    setAssigning(true)
    try {
      const res = await apiPost<{ assigned: number }>('/api/telemarketing/leads/bulk-assign', {
        lead_ids: [...checkedIds],
        agent_id: Number(assignAgentId),
      })
      const agentName = agents.find(a => a.id === Number(assignAgentId))?.full_name ?? 'agent'
      toast.success(`${res.assigned} lead(s) assigned to ${agentName}`)
      clearChecked()
      load()
    } catch (ex: any) {
      toast.error(ex.message ?? 'Assign failed')
    } finally {
      setAssigning(false)
    }
  }

  async function handleDistribute() {
    setDistributing(true)
    setDistributeConfirm(false)
    try {
      const body: Record<string, any> = {}
      if (campaignId) body.campaign_id = Number(campaignId)
      const res = await apiPost<{ distributed: number; breakdown: { agent_name: string; count: number }[] }>(
        '/api/telemarketing/leads/distribute', body
      )
      if (res.distributed === 0) {
        toast.info('No unassigned pending leads to distribute')
      } else {
        const summary = res.breakdown.map(b => `${b.agent_name}: ${b.count}`).join(', ')
        toast.success(`${res.distributed} leads distributed — ${summary}`)
        load()
      }
    } catch (ex: any) {
      toast.error(ex.message ?? 'Distribute failed')
    } finally {
      setDistributing(false)
    }
  }

  const pending   = leads.filter(l => l.status === 'pending').length
  const callbacks = leads.filter(l => l.status === 'callback').length
  const converted = leads.filter(l => l.status === 'converted').length
  const unassigned = leads.filter(l => !l.assigned_to).length

  const selectedCampaignName = campaigns.find(c => String(c.id) === campaignId)?.name ?? 'All Campaigns'

  return (
    <Page title="Marketing Leads" subtitle="Contacts pushed from email & SMS campaigns" noPad
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{ width: 380, minWidth: 320, maxWidth: 420, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 10 }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', flex: 1 }}>Marketing Leads</span>
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: RADIUS['2xl'] }}>
                {leads.length}
              </span>
              {/* Distribute button */}
              <button
                onClick={() => setDistributeConfirm(true)}
                disabled={distributing || unassigned === 0}
                title={unassigned === 0 ? 'No unassigned leads' : `Distribute ${unassigned} unassigned lead(s) round-robin`}
                style={{
                  display: 'flex', alignItems: 'center', gap: SP[1],
                  padding: '4px 9px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: `1px solid ${NAVY}30`, background: 'none',
                  color: unassigned === 0 ? 'var(--txt3)' : NAVY,
                  cursor: unassigned === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {distributing ? <Spinner size={12} color={NAVY} /> : (
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>shuffle</span>
                )}
                Distribute
              </button>
            </div>

            {/* Mini stats */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[
                { label: 'Pending',    value: pending,    color: '#6B7280' },
                { label: 'Callbacks',  value: callbacks,  color: AMBER },
                { label: 'Converted',  value: converted,  color: GREEN },
                { label: 'Unassigned', value: unassigned, color: RED },
              ].map(s => (
                <div key={s.label} style={{ flex: 1, textAlign: 'center', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '6px 2px' }}>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Search */}
            <TblSearch value={search} onChange={setSearch}
              placeholder="Search name, phone…" width={0} style={{ marginBottom: SP[2] }} />

            {/* Campaign dropdown */}
            {campaigns.length > 0 && (
              <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
                style={{ width: '100%', marginBottom: 6, padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none' }}>
                <option value="">All Campaigns</option>
                {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            )}

            {/* Status chips */}
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
              {[
                { value: 'pending',   label: 'Pending',   color: '#6B7280' },
                { value: 'called',    label: 'Called',    color: BLUE },
                { value: 'callback',  label: 'Callback',  color: AMBER },
                { value: 'no_answer', label: 'No Answer', color: RED },
                { value: 'converted', label: 'Converted', color: GREEN },
                { value: 'dnc',       label: 'DNC',       color: PURPLE },
              ].map(({ value, label, color }) => {
                const on = status === value
                return (
                  <button key={value} onClick={() => setStatus(on ? '' : value)} style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{label}</button>
                )
              })}
              {(status || search || campaignId) && (
                <button onClick={() => { setStatus(''); setSearch(''); setCampaignId('') }} style={{
                  fontSize: TEXT['2xs'], fontWeight: FW.medium, padding: '2px 8px', borderRadius: RADIUS.full,
                  border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer',
                }}>Clear</button>
              )}
            </div>
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 10px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, whiteSpace: 'nowrap' }}>
                {checkedIds.size} selected
              </span>
              <select
                value={assignAgentId}
                onChange={e => setAssignAgentId(e.target.value)}
                style={{ flex: 1, padding: `${SP[1]} ${SP[2]}`, borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none', minWidth: 0 }}
              >
                <option value="">Assign to…</option>
                {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
              </select>
              <button
                onClick={handleAssign}
                disabled={!assignAgentId || assigning}
                style={{
                  padding: '4px 10px', borderRadius: RADIUS.sm, border: 'none',
                  background: !assignAgentId || assigning ? `${NAVY}40` : NAVY,
                  color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: !assignAgentId || assigning ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {assigning && <Spinner size={11} color="#fff" />}
                Assign
              </button>
              <button
                onClick={clearChecked}
                style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', flexShrink: 0 }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
              </button>
            </div>
          )}

          {err && <div style={{ padding: '8px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* Lead list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : leads.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No leads yet. Push contacts from a campaign report.
              </div>
            ) : leads.map(lead => {
              const isSelected = selected?.id === lead.id
              const isChecked  = checkedIds.has(lead.id)
              const oc = OUTCOME_COLOR[lead.last_outcome ?? ''] ?? '#6B7280'
              return (
                <div
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 0,
                    borderBottom: '1px solid var(--bdr)', cursor: 'pointer',
                    background: isSelected ? `${NAVY}08` : undefined,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                >
                  {/* Checkbox */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 8px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={e => toggleCheck(lead.id, e)}
                      onChange={() => {}}
                      style={{ marginTop: 1, cursor: 'pointer', accentColor: NAVY }}
                    />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 2px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3 }}>
                      <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 6 }}>
                        {lead.customer_name}
                      </span>
                      <StatusPill status={lead.status} />
                    </div>
                    {lead.customer_phone && (
                      <div style={{ fontSize: TEXT.sm, color: NAVY, fontWeight: FW.medium, marginBottom: 3, fontFamily: INTER }}>{lead.customer_phone}</div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {lead.campaign_name && (
                        <span style={{ fontSize: TEXT['2xs'], color: PURPLE }}>{lead.campaign_name}</span>
                      )}
                      {lead.agent_name ? (
                        <span style={{ fontSize: TEXT['2xs'], color: NAVY, fontWeight: FW.semibold }}>
                          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xs, verticalAlign: 'middle' }}>person</span>
                          {' '}{lead.agent_name}
                        </span>
                      ) : (
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontStyle: 'italic' }}>unassigned</span>
                      )}
                    </div>
                    {(lead.last_outcome || lead.last_called_at) && (
                      <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginTop: 3 }}>
                        {lead.last_outcome && (
                          <span style={{ fontSize: TEXT['2xs'], color: oc, fontWeight: FW.semibold }}>{lead.last_outcome.replace(/_/g, ' ')}</span>
                        )}
                        {lead.last_called_at && (
                          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(lead.last_called_at)}</span>
                        )}
                      </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: SP[3], color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>contacts</span>
              <span style={{ fontSize: TEXT.md }}>Select a lead to log a call</span>
            </div>
          )}
        </div>
      </div>

      {/* Distribute confirm modal */}
      <ConfirmModal
        open={distributeConfirm}
        title="Distribute Leads Round-Robin"
        body={`Assign all ${unassigned} unassigned pending lead(s) from "${selectedCampaignName}" evenly across your telemarketing agents?`}
        confirmLabel="Distribute"
        loading={distributing}
        onConfirm={handleDistribute}
        onClose={() => setDistributeConfirm(false)}
      />
    </Page>
  )
}
