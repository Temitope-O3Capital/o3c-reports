import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useSearchParams } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, DataTable, Modal, Button, Input, Select, Field,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime, n } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  lead_owner_id: number | null; owner_name: string | null
  estimated_value_kobo: number | null
  next_action_at: string | null
  last_activity_at: string | null
  qualified_at: string | null
  created_at: string
}

interface Funnel { counts: Record<string, number>; value_kobo: Record<string, number> }
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
  const [search, setSearch] = useState('')

  // New-lead form
  const [newOpen, setNewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    first_name: '', last_name: '', phone: '', email: '',
    state: '', city: '', occupation: '', employer: '',
    lead_source: '', estimated_value: '', next_action_at: '', notes: '',
  })
  // Only the fields the create actually requires — a name, a way to reach them, and a
  // source — are shown up front. The other seven are enrichment and sit behind this
  // disclosure; they still submit if filled.
  const [moreOpen, setMoreOpen] = useState(false)

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
    if (dq) p.set('q', dq)
    return p.toString()
  }, [offset, stage, owner, due, dq])

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
  useEffect(() => { setOffset(0) }, [stage, owner, due, dq])

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
        occupation: '', employer: '', lead_source: '', estimated_value: '',
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

  const cols: TableCol<Lead>[] = [
    {
      key: 'first_name', label: 'Lead', sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>
            {[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.phone || r.email}</div>
        </div>
      ),
    },
    { key: 'lead_stage', label: 'Stage', sortable: true, render: r => <StagePill stage={r.lead_stage} /> },
    {
      key: 'lead_source', label: 'Source', sortable: true,
      render: r => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>
        {sources.find(s => s.code === r.lead_source)?.label ?? r.lead_source ?? '—'}
      </span>,
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
      key: 'actions', label: '', sortable: false, width: 190,
      render: r => (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          {r.lead_stage !== 'converted' && r.lead_stage !== 'disqualified' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => {
                setActing(r); setAction('stage')
                setActionStage(r.lead_stage === 'new' ? 'contacted' : 'qualified')
              }}>Advance</Button>
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
      title="Leads"
      subtitle="Capture, qualify and convert — from Business Development, campaigns, the call centre or your own prospecting"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            placeholder="Search name, phone, email…"
            defaultValue={search}
            onKeyDown={e => { if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value) }}
            style={{
              padding: '7px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, width: 220,
              border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
            }}
          />
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
      </div>

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
          emptyText="No leads match — create one with New Lead"
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
            A phone or email is required — a lead with no way to reach it is not a lead — and
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
              <Field label="Reason" hint="Required — it is what makes the source conversion rates meaningful">
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
    </Page>
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
