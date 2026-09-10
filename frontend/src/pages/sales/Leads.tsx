import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useSearchParams } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, DataTable, Modal, Button, Input, Select, Field,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import NewApplicationModal from '../../components/NewApplicationModal'
import { apiFetch, apiPost } from '../../lib/api'
import { currentUser, isSalesHead, allRoles } from '../../hooks/useAuth'
import { MGMT } from '../../lib/roles'
import { toast } from 'sonner'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime, n } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { PRODUCT_LINES, PRODUCT_SUBS, productLabel, lineOfCode, lineColor } from '../../lib/products'

// Lead capture and the lead queue.
//
// Leads arrive from Business Development, campaigns, the call centre, and from officers
// profiling a walk-in or referral themselves. They move new → contacted → qualified →
// converted, or leave via disqualified. Conversion needs a real CIF, because customers
// are created in the card system and arrive through the feed, not here — that is what
// stops the book filling with conversions pointing at nothing.

interface Lead {
  id: number
  first_name: string; last_name: string
  phone: string; email: string
  state: string; city: string
  employer: string; employer_name: string | null; occupation: string
  lead_stage: string; lead_source: string
  product_interest: string | null
  lead_owner_id: number | null; owner_name: string | null
  estimated_value_kobo: number | null
  next_action_at: string | null
  last_activity_at: string | null
  qualified_at: string | null
  created_at: string
  already_customer?: boolean
  matched_customer_cif?: string | null
}

interface Funnel {
  counts: Record<string, number>; value_kobo: Record<string, number>
  product_mix?: Record<string, { count: number; value_kobo: number }>
}
interface Source { code: string; label: string }
interface Officer { id: number; full_name: string; is_active: boolean }

const STAGES = [
  { key: 'new',          label: 'New',          color: '#6B7280' },
  { key: 'contacted',    label: 'Contacted',    color: BLUE },
  { key: 'qualified',    label: 'Qualified',    color: '#7C3AED' },
  { key: 'converted',    label: 'Converted',    color: GREEN },
  { key: 'disqualified', label: 'Disqualified', color: RED },
]

const stageColor = (s: string) => STAGES.find(x => x.key === s)?.color ?? '#6B7280'
const stageLabel = (s: string) => STAGES.find(x => x.key === s)?.label ?? s

// How old a lead is, compactly — a lead sitting for weeks is a signal on its own.
function leadAge(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5)
  if (d <= 0) return 'today'
  if (d === 1) return '1d old'
  if (d < 30) return `${d}d old`
  const m = Math.floor(d / 30)
  return `${m}mo old`
}

function StagePill({ stage }: { stage: string }) {
  const c = stageColor(stage)
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: `2px ${SP[2]}`,
      borderRadius: RADIUS['2xl'], background: `${c}1A`, color: c, whiteSpace: 'nowrap',
    }}>{stageLabel(stage)}</span>
  )
}

const PAGE_SIZE = 50

export default function SalesLeads() {
  const [params, setParams] = useSearchParams()
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [funnel, setFunnel] = useState<Funnel | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const stage = params.get('stage') ?? ''
  const owner = params.get('owner_id') ?? ''
  const due = params.get('due') ?? ''
  const line = params.get('line') ?? ''
  const source = params.get('source') ?? ''
  const stalled = params.get('stalled') ?? ''
  const includeCustomers = params.get('include_customers') === '1'
  const [search, setSearch] = useState('')

  // Head vs officer: heads (and executives) get the owner filter, the Distribute
  // action and per-lead assignment; officers work their own book + claim from the pool.
  const me = currentUser()
  const isHead = isSalesHead(me) || (!!me && allRoles(me).some(r => MGMT.has(r)))
  const [distOpen, setDistOpen] = useState(false)
  const [assignLead, setAssignLead] = useState<Lead | null>(null)
  const [raiseLead, setRaiseLead] = useState<Lead | null>(null)

  // New-lead form
  const [newOpen, setNewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '', email: '',
    state: '', city: '', occupation: '', employer: '',
    lead_source: '', product_interest: '', estimated_value: '', next_action_at: '', notes: '',
  })
  // Only the fields the create actually requires — a name, a way to reach them, and a
  // source — are shown up front. The other seven are enrichment and sit behind this
  // disclosure; they still submit if filled.
  const [moreOpen, setMoreOpen] = useState(false)

  // Grouped-by-product view: fold the current page's leads into collapsible sections,
  // one per product line (plus an "untagged" section), for a product-first read.
  const [groupView, setGroupView] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Stage / convert / disqualify
  const [acting, setActing] = useState<Lead | null>(null)
  const [action, setAction] = useState<'stage' | 'convert' | 'disqualify'>('stage')
  const [actionStage, setActionStage] = useState('contacted')
  const [actionCIF, setActionCIF] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke
  const query = useMemo(() => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE)); p.set('offset', String(offset))
    if (stage) p.set('stage', stage)
    if (owner) p.set('owner_id', owner)
    if (due) p.set('due', due)
    if (line) p.set('line', line)
    if (source) p.set('source', source)
    if (stalled) p.set('stalled', stalled)
    if (includeCustomers) p.set('include_customers', '1')
    if (dq) p.set('q', dq)
    return p.toString()
  }, [offset, stage, owner, due, line, source, stalled, includeCustomers, dq])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [l, f, s, o] = await Promise.all([
        apiFetch<{ data: Lead[]; total: number }>(`/api/sales/leads?${query}`),
        apiFetch<{ data: Funnel }>('/api/sales/leads/funnel'),
        apiFetch<{ data: Source[] }>('/api/sales/leads/sources'),
        apiFetch<{ data: Officer[] }>('/api/sales/officers'),
      ])
      setLeads(l.data ?? []); setTotal(l.total ?? 0)
      setFunnel(f.data); setSources(s.data ?? []); setOfficers(o.data ?? [])
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load leads')
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { load() }, [load])
  useEffect(() => { setOffset(0) }, [stage, owner, due, line, source, stalled, includeCustomers, dq])

  // Assign a single lead to an officer (heads). Reuses the lead PATCH — no bespoke
  // endpoint needed — then refreshes so the owner column updates in place.
  async function assignTo(leadId: number, officerId: number) {
    try {
      await apiFetch(`/api/sales/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify({ lead_owner_id: officerId }) })
      toast.success('Lead assigned')
      setAssignLead(null)
      await load()
    } catch (e: any) { toast.error(e?.message ?? 'Could not assign') }
  }

  async function createLead() {
    setSaving(true); setErr(null)
    try {
      const res = await apiFetch<{ data: { id: number; warning?: string } }>('/api/sales/leads', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          estimated_value_kobo: form.estimated_value
            ? Math.round(Number(form.estimated_value) * 100)
            : null,
          next_action_at: form.next_action_at || '',
        }),
      })
      setNewOpen(false)
      setMoreOpen(false)
      setForm({
        first_name: '', last_name: '', phone: '', email: '', state: '', city: '',
        occupation: '', employer: '', lead_source: '', product_interest: '', estimated_value: '',
        next_action_at: '', notes: '',
      })
      if (res.data?.warning) setNotice(res.data.warning)
      await load()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not create the lead')
    } finally {
      setSaving(false)
    }
  }

  async function runAction() {
    if (!acting) return
    setActionBusy(true); setErr(null)
    try {
      if (action === 'convert') {
        await apiFetch(`/api/sales/leads/${acting.id}/convert`, {
          method: 'POST', body: JSON.stringify({ cif: actionCIF, note: actionNote }),
        })
      } else if (action === 'disqualify') {
        await apiFetch(`/api/sales/leads/${acting.id}/disqualify`, {
          method: 'POST', body: JSON.stringify({ reason: actionNote }),
        })
      } else {
        await apiFetch(`/api/sales/leads/${acting.id}/stage`, {
          method: 'POST', body: JSON.stringify({ stage: actionStage, note: actionNote }),
        })
      }
      setActing(null); setActionCIF(''); setActionNote('')
      await load()
    } catch (e: any) {
      setErr(e?.message ?? 'That did not work')
    } finally {
      setActionBusy(false)
    }
  }

  // Claim a lead the call centre forwarded (or any unowned lead). This tells the
  // forwarding agent's tracker that Sales has picked it up.
  async function claim(id: number) {
    try {
      await apiFetch(`/api/sales/leads/${id}/claim`, { method: 'POST' })
      toast.success('Lead claimed — it is yours now')
      await load()
    } catch (e: any) { toast.error(e?.message ?? 'Could not claim') }
  }
  const meId = currentUser()?.id

  const cols: TableCol<Lead>[] = [
    {
      key: 'first_name', label: 'Lead', sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}
            {r.already_customer && (
              <span title={r.matched_customer_cif ? `Already customer CIF ${r.matched_customer_cif}` : 'Already a customer'}
                style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: AMBER, background: `${AMBER}1A`, padding: '1px 7px', borderRadius: RADIUS['2xl'], whiteSpace: 'nowrap' }}>
                Already a customer
              </span>
            )}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {r.phone || r.email}{r.created_at ? <span style={{ color: 'var(--txt3)' }}> · {leadAge(r.created_at)}</span> : null}
          </div>
        </div>
      ),
    },
    {
      key: 'lead_stage', label: 'Stage', sortable: true,
      render: r => {
        const open = ['new', 'contacted', 'qualified'].includes(r.lead_stage)
        const since = r.last_activity_at || r.created_at
        const idle = open && since ? Math.floor((Date.now() - new Date(since).getTime()) / 864e5) : -1
        const c = idle > 14 ? RED : idle > 7 ? AMBER : GREEN
        return (
          <div>
            <StagePill stage={r.lead_stage} />
            {idle >= 0 && (
              <div style={{ fontSize: TEXT['2xs'], color: c, marginTop: 3, fontWeight: FW.semibold }}>
                {idle <= 0 ? 'active today' : `idle ${idle}d`}
              </div>
            )}
          </div>
        )
      },
    },
    {
      key: 'lead_source', label: 'Source', sortable: true,
      render: r => r.lead_source === 'call_centre'
        ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: PURPLE, background: `${PURPLE}16`, padding: '2px 9px', borderRadius: RADIUS['2xl'], display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>headset_mic</span> Call Centre
          </span>
        : <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>
            {sources.find(s => s.code === r.lead_source)?.label ?? r.lead_source ?? '—'}
          </span>,
    },
    {
      key: 'state', label: 'State', sortable: true,
      render: r => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>{r.state || '—'}</span>,
    },
    {
      key: 'product_interest', label: 'Product', sortable: true,
      render: r => {
        if (!r.product_interest) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const c = lineColor(lineOfCode(r.product_interest))
        return <span style={{
          fontSize: TEXT.xs, fontWeight: FW.semibold, padding: `2px ${SP[2]}`,
          borderRadius: RADIUS['2xl'], background: `${c}1A`, color: c, whiteSpace: 'nowrap',
        }}>{productLabel(r.product_interest)}</span>
      },
    },
    {
      key: 'owner_name', label: 'Owner', sortable: true,
      render: r => r.owner_name
        ? <span style={{ color: 'var(--txt2)' }}>{r.owner_name}</span>
        : <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${AMBER}1A`, color: AMBER }}>Unowned</span>,
    },
    {
      key: 'estimated_value_kobo', label: 'Value', sortable: true, align: 'right',
      render: r => <span style={NUM}>{r.estimated_value_kobo ? fmtKobo(r.estimated_value_kobo) : '—'}</span>,
    },
    {
      key: 'next_action_at', label: 'Next action', sortable: true,
      render: r => {
        if (!r.next_action_at) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const overdue = new Date(r.next_action_at) <= new Date()
        return (
          <span style={{ fontSize: TEXT.sm, color: overdue ? RED : 'var(--txt2)', fontWeight: overdue ? FW.semibold : FW.normal }}>
            {fmtDate(r.next_action_at)}{overdue ? ' • overdue' : ''}
          </span>
        )
      },
    },
    {
      key: 'actions', label: '', sortable: false, width: 270,
      render: r => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
          {r.lead_source === 'call_centre' && r.lead_owner_id !== meId
            && r.lead_stage !== 'converted' && r.lead_stage !== 'disqualified' && (
            <Button size="sm" variant="secondary" onClick={() => claim(r.id)}>Claim</Button>
          )}
          {isHead && r.lead_stage !== 'converted' && r.lead_stage !== 'disqualified' && (
            <Button size="sm" variant="secondary" onClick={() => setAssignLead(r)}>Assign</Button>
          )}
          {r.lead_stage !== 'converted' && r.lead_stage !== 'disqualified' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => {
                setActing(r); setAction('stage')
                setActionStage(r.lead_stage === 'new' ? 'contacted' : 'qualified')
              }}>Advance</Button>
              {/* Origination on-ramp: raise a loan/card/FD application straight from the
                  lead. A prospect with no CIF yet lands provisional and links later. */}
              <Button size="sm" variant="secondary" onClick={() => setRaiseLead(r)}>Raise app</Button>
              <Button size="sm" variant="primary" onClick={() => { setActing(r); setAction('convert') }}>
                Convert
              </Button>
            </>
          )}
        </div>
      ),
    },
  ]

  const openLeads = n(funnel?.counts?.new) + n(funnel?.counts?.contacted) + n(funnel?.counts?.qualified)

  return (
    <Page
      loading={loading && leads.length === 0}
      skeletonKpis={4}
      title="Leads"
      subtitle="Capture, qualify and convert: from Business Development, campaigns, the call centre or your own prospecting"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setGroupView(v => !v)}
            title="Group leads into collapsible sections by product line"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: RADIUS.md,
              fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
              border: `1px solid ${groupView ? NAVY : 'var(--bdr)'}`,
              background: groupView ? `${NAVY}12` : 'var(--card)', color: groupView ? NAVY : 'var(--txt2)',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{groupView ? 'view_list' : 'category'}</span>
            {groupView ? 'Flat list' : 'By product'}
          </button>
          <input
            placeholder="Search name, phone, email…"
            defaultValue={search}
            onKeyDown={e => { if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value) }}
            style={{
              padding: '7px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, width: 220,
              border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
            }}
          />
          {isHead && (
            <select value={owner}
              onChange={e => { const p = new URLSearchParams(params); e.target.value ? p.set('owner_id', e.target.value) : p.delete('owner_id'); setParams(p) }}
              title="Filter by owner"
              style={{ padding: '7px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', maxWidth: 180 }}>
              <option value="">All officers</option>
              <option value="unassigned">Unassigned pool</option>
              {officers.map(o => <option key={o.id} value={String(o.id)}>{o.full_name}</option>)}
            </select>
          )}
          {isHead && <Button variant="secondary" icon="shuffle" onClick={() => setDistOpen(true)}>Distribute</Button>}
          <Button variant="primary" icon="person_add" onClick={() => setNewOpen(true)}>New Lead</Button>
        </div>
      }
    >
      {(err || notice) && (
        <div style={{
          marginBottom: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md,
          background: err ? `${RED}0F` : `${AMBER}0F`,
          border: `1px solid ${err ? RED : AMBER}33`,
          fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>
          {err ?? notice}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Open leads" value={fmtNum(openLeads)} icon="filter_alt" accent={BLUE} loading={loading} />
        <KpiCard label="Qualified" value={fmtNum(funnel?.counts?.qualified ?? 0)} icon="verified" accent={NAVY} loading={loading} />
        <KpiCard label="Converted" value={fmtNum(funnel?.counts?.converted ?? 0)} icon="handshake" accent={GREEN} loading={loading} />
        <KpiCard label="Pipeline value"
          value={fmtKobo(n(funnel?.value_kobo?.new) + n(funnel?.value_kobo?.contacted) + n(funnel?.value_kobo?.qualified))}
          icon="payments" accent={AMBER} loading={loading} />
      </div>

      {/* Conversion funnel — how leads narrow from new to converted */}
      <SectionCard title="Conversion funnel" subtitle="Progression from new to converted, with step conversion" style={{ marginBottom: SP[4] }}>
        {(() => {
          const steps = [
            { key: 'new',       label: 'New',       color: '#6B7280' },
            { key: 'contacted', label: 'Contacted', color: BLUE },
            { key: 'qualified', label: 'Qualified', color: '#7C3AED' },
            { key: 'converted', label: 'Converted', color: GREEN },
          ]
          const vals = steps.map(s => n(funnel?.counts?.[s.key]))
          const max = Math.max(1, ...vals)
          const top = vals[0] || 0
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {steps.map((s, i) => {
                const v = vals[i]
                const w = Math.max(2, (v / max) * 100)
                const conv = top > 0 ? Math.round((v / top) * 100) : 0
                return (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ width: 84, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', flexShrink: 0 }}>{s.label}</span>
                    <div style={{ flex: 1, height: 22, background: 'var(--th-bg)', borderRadius: RADIUS.md, overflow: 'hidden', position: 'relative' }}>
                      <div style={{ width: `${w}%`, height: '100%', background: s.color, borderRadius: RADIUS.md, transition: 'width .4s', opacity: 0.92 }} />
                      <span style={{ position: 'absolute', left: 10, top: 0, height: '100%', display: 'flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>{fmtNum(v)}</span>
                    </div>
                    <span style={{ width: 46, textAlign: 'right', fontSize: TEXT.xs, ...NUM, color: 'var(--txt3)', flexShrink: 0 }}>{i === 0 ? '100%' : `${conv}%`}</span>
                  </div>
                )
              })}
            </div>
          )
        })()}
      </SectionCard>

      {/* Stage filter strip — doubles as the funnel */}
      <div style={{ display: 'flex', gap: 8, marginBottom: SP[4], flexWrap: 'wrap' }}>
        <FilterChip label="All" active={!stage && !due} count={undefined}
          onClick={() => { const p = new URLSearchParams(params); p.delete('stage'); p.delete('due'); setParams(p) }} />
        {STAGES.map(s => (
          <FilterChip
            key={s.key} label={s.label} color={s.color}
            count={funnel?.counts?.[s.key]}
            active={stage === s.key}
            onClick={() => {
              const p = new URLSearchParams(params); p.delete('due')
              stage === s.key ? p.delete('stage') : p.set('stage', s.key)
              setParams(p)
            }}
          />
        ))}
        <FilterChip label="Overdue" color={RED} active={due === '1'}
          onClick={() => {
            const p = new URLSearchParams(params); p.delete('stage')
            due === '1' ? p.delete('due') : p.set('due', '1')
            setParams(p)
          }} />
        <FilterChip label="Already customers" color={AMBER} active={includeCustomers}
          onClick={() => {
            const p = new URLSearchParams(params)
            includeCustomers ? p.delete('include_customers') : p.set('include_customers', '1')
            setParams(p)
          }} />

        {/* Product-line filter — vertical rule then the three lines */}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--bdr)', margin: '2px 4px' }} />
        {PRODUCT_LINES.map(pl => (
          <FilterChip
            key={pl.line} label={pl.label} color={pl.color}
            count={funnel?.product_mix?.[pl.line]?.count}
            active={line === pl.line}
            onClick={() => {
              const p = new URLSearchParams(params)
              line === pl.line ? p.delete('line') : p.set('line', pl.line)
              setParams(p)
            }}
          />
        ))}
      </div>

      {groupView ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {[...PRODUCT_LINES.map(pl => ({ key: pl.line as string, label: pl.label, color: pl.color })), { key: '', label: 'Untagged', color: '#9CA3AF' }].map(g => {
            const groupLeads = leads.filter(l => (lineOfCode(l.product_interest) || '') === g.key)
            const openCount = g.key ? funnel?.product_mix?.[g.key]?.count : undefined
            if (groupLeads.length === 0 && !openCount) return null
            const id = g.key || 'untagged'
            const open = !collapsed.has(id)
            return (
              <div key={id} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
                <button
                  onClick={() => setCollapsed(c => { const nx = new Set(c); nx.has(id) ? nx.delete(id) : nx.add(id); return nx })}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'transparent', border: 'none', borderBottom: open ? '1px solid var(--bdr)' : 'none', cursor: 'pointer', textAlign: 'left' }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)' }}>{open ? 'expand_more' : 'chevron_right'}</span>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.color, flexShrink: 0 }} />
                  <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{g.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                    {groupLeads.length} shown{openCount != null ? ` · ${fmtNum(openCount)} open` : ''}
                  </span>
                </button>
                {open && (groupLeads.length > 0
                  ? <DataTable<Lead> cols={cols} rows={groupLeads} keyFn={r => r.id} />
                  : <div style={{ padding: '18px 16px', color: 'var(--txt3)', fontSize: TEXT.sm }}>No {g.label.toLowerCase()} leads on this page — use the {g.label} filter chip above to load them.</div>
                )}
              </div>
            )
          })}
          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${SP[2]} ${SP[1]}` }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(total / PAGE_SIZE)} · grouping this page</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <SectionCard
          title="Lead queue"
          subtitle={loading ? undefined : `${fmtNum(total)} lead${total === 1 ? '' : 's'}`}
          padding={false}
        >
          <DataTable<Lead>
            cols={cols}
            rows={leads}
            loading={loading}
            skeletonRows={8}
            emptyText="No leads match. Create one with New Lead"
            keyFn={r => r.id}
          />
          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${SP[3]} ${SP[4]}`, borderTop: '1px solid var(--bdr)' }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
                Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" size="sm" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          )}
        </SectionCard>
      )}

      {/* New lead */}
      <Modal
        open={newOpen} onClose={() => { setNewOpen(false); setMoreOpen(false) }} title="New lead" width={620}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => { setNewOpen(false); setMoreOpen(false) }}>Cancel</Button>
            <Button variant="primary" loading={saving}
              disabled={(!form.first_name && !form.last_name) || (!form.phone && !form.email) || !form.lead_source}
              onClick={createLead}>Create lead</Button>
          </div>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="First name" value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} />
          <Input label="Last name" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} />
          <Input label="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
          <Input label="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <Select label="Lead source" value={form.lead_source} onChange={e => setForm({ ...form, lead_source: e.target.value })}>
            <option value="">Choose a source…</option>
            {sources.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
          </Select>
          <Select label="Product interest" value={form.product_interest} onChange={e => setForm({ ...form, product_interest: e.target.value })}>
            <option value="">Which product…</option>
            {PRODUCT_LINES.map(pl => (
              <optgroup key={pl.line} label={pl.label}>
                {PRODUCT_SUBS.filter(s => s.line === pl.line).map(s => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </Select>
          <button
            type="button"
            onClick={() => setMoreOpen(o => !o)}
            style={{
              gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 0', border: 'none', background: 'none', cursor: 'pointer',
              color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{moreOpen ? 'expand_less' : 'expand_more'}</span>
            {moreOpen ? 'Fewer details' : 'More details'}
          </button>

          {moreOpen && (<>
            <Input label="Estimated value (₦)" type="number" value={form.estimated_value}
              onChange={e => setForm({ ...form, estimated_value: e.target.value })} />
            <Input label="Next action" type="date" value={form.next_action_at}
              onChange={e => setForm({ ...form, next_action_at: e.target.value })} />
            <Input label="State" value={form.state} onChange={e => setForm({ ...form, state: e.target.value })} />
            <Input label="City" value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} />
            <Input label="Occupation" value={form.occupation} onChange={e => setForm({ ...form, occupation: e.target.value })} />
            <Input label="Employer" value={form.employer} onChange={e => setForm({ ...form, employer: e.target.value })} />
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes">
                <textarea
                  value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  rows={3}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, resize: 'vertical',
                    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
                    fontSize: TEXT.sm, fontFamily: 'inherit',
                  }}
                />
              </Field>
            </div>
          </>)}

          <p style={{ gridColumn: '1 / -1', fontSize: TEXT.xs, color: 'var(--txt3)', margin: 0, lineHeight: 1.5 }}>
            A phone or email is required, a lead with no way to reach it is not a lead, and
            the source is required so origination can be credited. The lead is assigned to you.
          </p>
        </div>
      </Modal>

      {/* Advance / convert / disqualify */}
      <Modal
        open={!!acting}
        onClose={() => setActing(null)}
        title={
          action === 'convert' ? 'Convert to customer'
            : action === 'disqualify' ? 'Disqualify lead'
              : 'Advance lead'
        }
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
            {action !== 'disqualify' ? (
              <Button variant="danger" onClick={() => { setAction('disqualify'); setActionNote('') }}>
                Disqualify
              </Button>
            ) : <span />}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" onClick={() => setActing(null)}>Cancel</Button>
              <Button
                variant="primary" loading={actionBusy}
                disabled={
                  (action === 'convert' && !actionCIF.trim()) ||
                  (action === 'disqualify' && !actionNote.trim())
                }
                onClick={runAction}
              >
                {action === 'convert' ? 'Convert' : action === 'disqualify' ? 'Disqualify' : 'Move'}
              </Button>
            </div>
          </div>
        }
      >
        {acting && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              {[acting.first_name, acting.last_name].filter(Boolean).join(' ')} · currently{' '}
              <StagePill stage={acting.lead_stage} />
            </div>

            {action === 'stage' && (
              <Select label="Move to" value={actionStage} onChange={e => setActionStage(e.target.value)}>
                <option value="contacted">Contacted</option>
                <option value="qualified">Qualified</option>
              </Select>
            )}

            {action === 'convert' && (
              <>
                <Input
                  label="Customer CIF" value={actionCIF}
                  onChange={e => setActionCIF(e.target.value)}
                  placeholder="00040093"
                  hint="The customer must already exist in the card system"
                />
                <div style={{
                  padding: `${SP[3]} ${SP[3]}`, borderRadius: RADIUS.md,
                  background: `${BLUE}0F`, border: `1px solid ${BLUE}33`,
                  fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5,
                }}>
                  Customers are created in the card system and reach the workspace through
                  the 15-minute feed. Converting links this lead to that customer and makes
                  you their account officer.
                </div>
              </>
            )}

            {action === 'disqualify' && (
              <Field label="Reason" hint="Required: it is what makes the source conversion rates meaningful">
                <textarea
                  value={actionNote} onChange={e => setActionNote(e.target.value)} rows={3}
                  placeholder="e.g. Not eligible, no longer interested, duplicate"
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, resize: 'vertical',
                    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
                    fontSize: TEXT.sm, fontFamily: 'inherit',
                  }}
                />
              </Field>
            )}

            {action !== 'disqualify' && (
              <Input label="Note (optional)" value={actionNote} onChange={e => setActionNote(e.target.value)} />
            )}
          </div>
        )}
      </Modal>

      {isHead && distOpen && (
        <DistributeModal officers={officers} meId={meId} onClose={() => setDistOpen(false)} onDone={() => { setDistOpen(false); load() }} />
      )}
      {assignLead && (
        <AssignModal lead={assignLead} officers={officers} onClose={() => setAssignLead(null)} onAssign={assignTo} />
      )}
      <NewApplicationModal
        open={!!raiseLead}
        onClose={() => setRaiseLead(null)}
        leadId={raiseLead?.id}
        presetCif={raiseLead?.matched_customer_cif ?? undefined}
        presetName={raiseLead ? `${raiseLead.first_name ?? ''} ${raiseLead.last_name ?? ''}`.trim() : undefined}
        onSaved={() => { setRaiseLead(null); load() }}
      />
    </Page>
  )
}

// Assign one lead to an officer.
function AssignModal({ lead, officers, onClose, onAssign }: {
  lead: Lead; officers: Officer[]; onClose: () => void; onAssign: (leadId: number, officerId: number) => void
}) {
  const [officerId, setOfficerId] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <Modal open onClose={onClose} title="Assign lead" width={420}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!officerId}
            onClick={() => { setSaving(true); onAssign(lead.id, Number(officerId)) }}>Assign</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          Hand <strong style={{ color: 'var(--txt)' }}>{[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'this lead'}</strong> to an officer.
        </div>
        <Select label="Officer" value={officerId} onChange={e => setOfficerId(e.target.value)}>
          <option value="">Choose an officer…</option>
          {officers.filter(o => o.is_active).map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
        </Select>
      </div>
    </Modal>
  )
}

// Bulk-distribute the unowned lead pool across a set of officers. A team head is
// pre-scoped to their own team (loaded from /api/sales/teams); executives can pick
// anyone. Dry-run previews the split before committing.
function DistributeModal({ officers, meId, onClose, onDone }: {
  officers: Officer[]; meId: number | undefined; onClose: () => void; onDone: () => void
}) {
  const [picked, setPicked]   = useState<Set<number>>(new Set())
  const [strategy, setStrategy] = useState<'round_robin' | 'by_state'>('round_robin')
  const [limit, setLimit]     = useState('')
  const [preview, setPreview] = useState<{ officer_id: number; full_name: string; count: number }[] | null>(null)
  const [busy, setBusy]       = useState(false)
  const [teamScoped, setTeamScoped] = useState(false)

  // A team head only distributes to their team. Resolve the eligible officer set from
  // the teams this user heads; fall back to all officers (executive / no team).
  useEffect(() => {
    let cancelled = false
    apiFetch<{ data: any[] } | any[]>('/api/sales/teams').then(res => {
      if (cancelled) return
      const teams = Array.isArray(res) ? res : (res?.data ?? [])
      const mine = teams.filter((t: any) => t.head_user_id === meId)
      if (mine.length > 0) {
        const ids = new Set<number>()
        mine.forEach((t: any) => (t.members ?? []).forEach((m: any) => ids.add(m.user_id)))
        setPicked(ids); setTeamScoped(true)
      } else {
        setPicked(new Set(officers.filter(o => o.is_active).map(o => o.id)))
      }
    }).catch(() => setPicked(new Set(officers.filter(o => o.is_active).map(o => o.id))))
    return () => { cancelled = true }
  }, [officers, meId])

  // When team-scoped, only show the head's own team members as options.
  const options = teamScoped ? officers.filter(o => picked.has(o.id) || false) : officers.filter(o => o.is_active)
  const eligible = teamScoped ? officers.filter(o => picked.has(o.id)) : officers.filter(o => o.is_active)

  function toggle(id: number) {
    setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
    setPreview(null)
  }

  async function run(dry: boolean) {
    const ids = [...picked]
    if (ids.length === 0) { toast.error('Pick at least one officer'); return }
    setBusy(true)
    try {
      const body: any = { officer_ids: ids, strategy, dry_run: dry }
      if (limit && Number(limit) > 0) body.limit = Number(limit)
      const res = await apiPost<{ assigned?: number; would_assign?: number; per_officer: any[] }>('/api/sales/leads/distribute', body)
      if (dry) {
        setPreview(res.per_officer ?? [])
        toast.info(`${res.would_assign ?? 0} lead(s) would be distributed`)
      } else {
        toast.success(`${res.assigned ?? 0} lead(s) distributed`)
        onDone()
      }
    } catch (e: any) { toast.error(e?.message ?? 'Distribute failed') }
    finally { setBusy(false) }
  }

  const list = (teamScoped ? eligible : options)

  return (
    <Modal open onClose={onClose} title="Distribute unowned leads" width={520}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
          <Button variant="secondary" onClick={() => run(true)} disabled={busy}>Preview split</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => run(false)}>Distribute</Button>
          </div>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
          Hands the <strong>unowned</strong> lead pool to the officers you pick. Safe to re-run —
          it never touches leads someone already owns.
          {teamScoped && <span style={{ color: PURPLE, fontWeight: FW.semibold }}> Scoped to your team.</span>}
        </div>

        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Officers</div>
          {list.length === 0 ? (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No eligible officers{teamScoped ? ' on your team — add some under Teams.' : '.'}</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {list.map(o => {
                const on = picked.has(o.id)
                return (
                  <button key={o.id} onClick={() => toggle(o.id)} style={{
                    padding: '5px 12px', borderRadius: RADIUS['2xl'], cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? `${NAVY}12` : 'var(--card)', color: on ? NAVY : 'var(--txt2)',
                  }}>{o.full_name}</button>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Select label="Strategy" value={strategy} onChange={e => { setStrategy(e.target.value as any); setPreview(null) }} wrapStyle={{ flex: 1, minWidth: 160 }}>
            <option value="round_robin">Round robin (even split)</option>
            <option value="by_state">By state (keep a state together)</option>
          </Select>
          <Input label="Limit (optional)" type="number" value={limit} onChange={e => setLimit(e.target.value)} placeholder="All" wrapStyle={{ width: 130 }} />
        </div>

        {preview && (
          <div style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', marginBottom: 6 }}>Preview</div>
            {preview.filter(p => p.count > 0).map(p => (
              <div key={p.officer_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, padding: '2px 0' }}>
                <span style={{ color: 'var(--txt)' }}>{p.full_name}</span>
                <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{p.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

function FilterChip({ label, count, color, active, onClick }: {
  label: string; count?: number; color?: string; active: boolean; onClick: () => void
}) {
  const c = color ?? NAVY
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: `6px ${SP[3]}`, borderRadius: RADIUS['2xl'], cursor: 'pointer',
        fontSize: TEXT.sm, fontWeight: active ? FW.semibold : FW.normal,
        border: `1px solid ${active ? c : 'var(--bdr)'}`,
        background: active ? `${c}14` : 'var(--card)',
        color: active ? c : 'var(--txt2)',
      }}
    >
      {label}
      {count != null && (
        <span style={{ ...NUM, fontSize: TEXT.xs, opacity: 0.8 }}>{fmtNum(count)}</span>
      )}
    </button>
  )
}
