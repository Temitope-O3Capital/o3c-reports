import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, Modal, ErrBanner, btnPrimary, btnSecondary, filterInputStyle, Spinner,
  NameCell, ActionRow, StatusBadge, ExpandableFilterBar,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { PRODUCT_LINES, PRODUCT_SUBS, productLabel } from '../../lib/products'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Stage {
  id: number
  name: string
  color?: string
  is_won?: boolean
  is_lost?: boolean
  order_index?: number
}

interface Deal {
  id: number
  title: string
  contact_id?: number
  first_name?: string
  last_name?: string
  stage_id?: number
  stage_name?: string
  stage_color?: string
  is_won?: boolean
  is_lost?: boolean
  expected_value?: number
  probability?: number
  assigned_name?: string
  updated_at: string
  expected_close_date?: string
  notes?: string
  product?: string
}

interface PipelineResponse {
  stages: Stage[]
  deals: Record<string, Deal[]>
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stagePillStyle(color?: string, isWon?: boolean, isLost?: boolean) {
  const c = isWon ? GREEN : isLost ? '#6B7280' : (color || NAVY)
  return { background: `${c}18`, color: c }
}

function StagePill({ name, color, is_won, is_lost }: Pick<Stage, 'name' | 'color' | 'is_won' | 'is_lost'>) {
  const s = stagePillStyle(color, is_won, is_lost)
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], ...s }}>
      {name}
    </span>
  )
}

const DAYS_IN_STAGE_MS = 24 * 60 * 60 * 1000

function daysInStage(deal: Deal): number {
  return Math.floor((Date.now() - new Date(deal.updated_at).getTime()) / DAYS_IN_STAGE_MS)
}

// ── Create Deal Modal ──────────────────────────────────────────────────────────

interface CRMContact { id: number; first_name: string; last_name: string }

function CreateDealModal({
  open, stages, onClose, onCreated,
}: {
  open: boolean
  stages: Stage[]
  onClose: () => void
  onCreated: () => void
}) {
  const [contacts, setContacts] = useState<CRMContact[]>([])
  const [title, setTitle] = useState('')
  const [contactId, setContactId] = useState('')
  const [stageId, setStageId] = useState('')
  const [product, setProduct] = useState('')
  const [value, setValue] = useState('')
  const [probability, setProbability] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    apiFetch<{ data: CRMContact[] }>('/api/crm/contacts?limit=200')
      .then(r => setContacts(r?.data ?? []))
      .catch(() => setContacts([]))
  }, [open])

  useEffect(() => {
    if (!open) {
      setTitle(''); setContactId(''); setStageId(''); setProduct('')
      setValue(''); setProbability(''); setCloseDate('')
    }
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { toast.error('Title is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/crm/deals', {
        title: title.trim(),
        contact_id: contactId ? Number(contactId) : undefined,
        stage_id: stageId ? Number(stageId) : undefined,
        product: product.trim() || undefined,
        expected_value: value ? Number(value) : undefined,
        probability: probability ? Number(probability) : undefined,
        expected_close_date: closeDate || undefined,
      })
      toast.success('Deal created')
      onCreated()
      onClose()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to create deal')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Deal" width={480}
      footer={
        <>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button
            form="create-deal-form" type="submit"
            disabled={saving}
            title="Cmd+Enter"
            style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {saving && <Spinner size={14} color="#fff" />}
            Create Deal
          </button>
        </>
      }
    >
      <form id="create-deal-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Title *</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. ACME Corp: Business Loan"
            required
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38, fontSize: TEXT.base }}
          />
        </div>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Contact</label>
          <select
            value={contactId}
            onChange={e => setContactId(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', height: 38 }}
          >
            <option value="">— Select contact —</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Stage</label>
            <select
              value={stageId}
              onChange={e => setStageId(e.target.value)}
              style={{ ...filterInputStyle, width: '100%', height: 38 }}
            >
              <option value="">— Select stage —</option>
              {stages.filter(s => !s.is_won && !s.is_lost).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Product</label>
            <select
              value={product}
              onChange={e => setProduct(e.target.value)}
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }}
            >
              <option value="">— Select product —</option>
              {PRODUCT_LINES.map(pl => (
                <optgroup key={pl.line} label={pl.label}>
                  {PRODUCT_SUBS.filter(s => s.line === pl.line).map(s => (
                    <option key={s.code} value={s.code}>{s.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Est. Value (₦)</label>
            <input
              type="number"
              min="0"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="0"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }}
            />
          </div>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Probability %</label>
            <input
              type="number"
              min="0"
              max="100"
              value={probability}
              onChange={e => setProbability(e.target.value)}
              placeholder="50"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }}
            />
          </div>
        </div>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Expected Close Date</label>
          <input
            type="date"
            value={closeDate}
            onChange={e => setCloseDate(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }}
          />
        </div>
      </form>
    </Modal>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CRMPipeline() {
  const navigate = useNavigate()
  const [pipeline, setPipeline] = useState<PipelineResponse | null>(null)
  const [allDeals, setAllDeals] = useState<Deal[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [view, setView]         = useState<'table' | 'kanban'>('table')
  const [selected, setSelected] = useState<Deal | null>(null)
  const [newDealOpen, setNewDealOpen] = useState(false)
  const dragDealId  = useRef<number | null>(null)
  const [dragOverStage, setDragOverStage] = useState<number | null>(null)
  const [editing,     setEditing]     = useState<Deal | null>(null)
  const [activity,    setActivity]    = useState<Deal | null>(null)
  const [bulkSel,     setBulkSel]     = useState<Set<string | number>>(new Set())
  const [search,      setSearch]      = useState('')
  const [fStages,     setFStages]     = useState<Set<string>>(new Set())
  const [fAssignees,  setFAssignees]  = useState<Set<string>>(new Set())
  const [users,       setUsers]       = useState<{ id: number; full_name: string }[]>([])

  // Edit-stage modal
  const [editStageId, setEditStageId] = useState('')
  const [savingStage, setSavingStage] = useState(false)

  // Log-activity modal
  const [actType, setActType] = useState('call')
  const [actSubj, setActSubj] = useState('')
  const [actBody, setActBody] = useState('')
  const [actOutc, setActOutc] = useState('')
  const [savingAct, setSavingAct] = useState(false)

  // Bulk-assign modal
  const [assignOpen,   setAssignOpen]   = useState(false)
  const [assignTo,     setAssignTo]     = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  // No date filter here, deliberately. The endpoint filters on the deal's
  // created_at, and the board used to default to the current month — so a deal
  // opened in June and still sitting in Negotiation simply vanished, and the stage
  // counts and pipeline value understated the book by however much was carried over.
  // A pipeline is a snapshot of what is open right now; a created-date window is the
  // wrong question to ask of it. Period comparisons belong on closed/won reporting,
  // which lives in Reports.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const [p, d, us] = await Promise.all([
        apiFetch<PipelineResponse>('/api/crm/pipeline'),
        apiFetch<Deal[]>('/api/crm/deals'),
        apiFetch<{ id: number; full_name: string }[]>('/api/crm/users'),
      ])
      setPipeline(p)
      setAllDeals(Array.isArray(d) ? d : [])
      setUsers(Array.isArray(us) ? us : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  async function saveStage() {
    if (!editing) return
    setSavingStage(true)
    try {
      await apiFetch(`/api/crm/deals/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ stage_id: Number(editStageId) }),
        headers: { 'Content-Type': 'application/json' },
      })
      toast.success('Stage updated')
      setEditing(null); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSavingStage(false) }
  }

  async function saveActivity() {
    if (!activity) return
    if (!activity.contact_id) { toast.error('This deal has no linked contact to log against'); return }
    setSavingAct(true)
    try {
      await apiPost('/api/crm/activities', {
        contact_id: activity.contact_id,
        deal_id:    activity.id,
        type:       actType,
        subject:    actSubj,
        body:       actBody,
        outcome:    actOutc,
      })
      toast.success('Activity logged')
      setActivity(null); setActSubj(''); setActBody(''); setActOutc(''); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSavingAct(false) }
  }

  async function bulkAssignDeals() {
    if (!assignTo || bulkSel.size === 0) return
    setAssignSaving(true)
    try {
      await Promise.all([...bulkSel].map(id => apiFetch(`/api/crm/deals/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ assigned_to: Number(assignTo) }),
        headers: { 'Content-Type': 'application/json' },
      })))
      toast.success(`${bulkSel.size} deal${bulkSel.size > 1 ? 's' : ''} reassigned`)
      setAssignOpen(false); setAssignTo(''); setBulkSel(new Set()); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setAssignSaving(false) }
  }


  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  const moveDeal = useCallback(async (dealId: number, targetStageId: number) => {
    try {
      await apiFetch(`/api/crm/deals/${dealId}`, {
        method: 'PUT',
        body: JSON.stringify({ stage_id: targetStageId }),
        headers: { 'Content-Type': 'application/json' },
      })
      load()
    } catch (e: any) { toast.error(e.message) }
  }, [load])

  const tableCols: TableCol<Deal>[] = [
    {
      key: 'title', label: 'Deal',
      render: r => <NameCell name={r.title} sub={`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null} />,
    },
    {
      key: 'stage_name', label: 'Stage',
      render: r => <StatusBadge status={r.stage_name ?? '—'} />,
    },
    {
      key: 'expected_value', label: 'Est. Value', align: 'right',
      render: r => r.expected_value
        ? <span style={NUM}>{fmtKobo(r.expected_value * 100)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    { key: 'assigned_name', label: 'Owner', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    {
      key: 'expected_close_date', label: 'Close Date',
      render: r => r.expected_close_date
        ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.expected_close_date)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'updated_at', label: 'Last Activity',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
    {
      key: '_actions', label: '', sortable: false,
      render: r => <ActionRow actions={[
        { icon: 'visibility', label: 'View', onClick: () => setSelected(r) },
        { icon: 'edit', label: 'Edit Stage', onClick: () => { setEditing(r); setEditStageId(String(r.stage_id ?? '')) } },
        { icon: 'add_call', label: 'Log Activity', onClick: () => { setActivity(r); setActType('call'); setActSubj(''); setActBody(''); setActOutc('') } },
      ]} />,
    },
  ]

  const stages = (pipeline?.stages ?? []).slice().sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

  const uniqueAssignees = useMemo(
    () => [...new Set(allDeals.map(d => d.assigned_name).filter(Boolean))] as string[],
    [allDeals],
  )

  const filteredDeals = useMemo(() => allDeals.filter(d => {
    if (fStages.size && (d.stage_name == null || !fStages.has(d.stage_name))) return false
    if (fAssignees.size && (d.assigned_name == null || !fAssignees.has(d.assigned_name))) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(d.title?.toLowerCase().includes(q) || d.first_name?.toLowerCase().includes(q) || d.last_name?.toLowerCase().includes(q) || d.stage_name?.toLowerCase().includes(q))) return false
    }
    return true
  }), [allDeals, fStages, fAssignees, search])

  function resetFilters() { setSearch(''); setFStages(new Set()); setFAssignees(new Set()) }

  return (
    <Page
      title="Sales Pipeline"
      subtitle="Deal management and sales pipeline"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setNewDealOpen(true)}
            style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Deal
          </button>
          <div style={{ display: 'flex', gap: 4, background: 'var(--th-bg)', padding: 3, borderRadius: RADIUS.md, border: '1px solid var(--bdr)' }}>
            {(['table', 'kanban'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{
                  padding: '5px 14px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                  background: view === v ? 'var(--card)' : 'transparent',
                  color: view === v ? 'var(--txt)' : 'var(--txt2)',
                  boxShadow: view === v ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
                }}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {view === 'table' ? (
        <SectionCard title="All Deals" badge={allDeals.length} padding={false}>
            <ExpandableFilterBar
            search={search}
            onSearch={setSearch}
            groups={[
              {
                key: 'stage',
                label: 'Stage',
                options: stages.map(s => ({
                  value: s.name,
                  label: s.name,
                  color: s.is_won ? GREEN : s.is_lost ? '#6B7280' : (s.color || NAVY),
                  count: allDeals.filter(d => d.stage_name === s.name).length,
                })),
                selected: fStages,
                onChange: setFStages,
              },
              {
                key: 'assignee',
                label: 'Assignee',
                options: uniqueAssignees.map(name => ({
                  value: name,
                  avatarName: name,
                  count: allDeals.filter(d => d.assigned_name === name).length,
                })),
                selected: fAssignees,
                onChange: setFAssignees,
              },
            ]}
            onReset={resetFilters}
            resultCount={filteredDeals.length}
            totalCount={allDeals.length}
          />
          <DataTable<Deal>
            cols={tableCols}
            rows={filteredDeals}
            keyFn={r => r.id}
            onRowClick={r => setSelected(r)}
            emptyText="No deals found."
            skeletonRows={loading ? 8 : 0}
            selectable
            selectedIds={bulkSel}
            onSelect={setBulkSel}
            bulkBar={
              <>
                <button onClick={() => setAssignOpen(true)}
                  style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Bulk Assign</button>
              </>
            }
          />
        </SectionCard>
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
          <div style={{ display: 'flex', gap: 12, minWidth: stages.length * 240 }}>
            {stages.map(stage => {
              const deals = pipeline?.deals?.[String(stage.id)] ?? []
              const headerColor = stage.is_won ? GREEN : stage.is_lost ? '#6B7280' : (stage.color || NAVY)
              const isOver = dragOverStage === stage.id
              return (
                <div key={stage.id} style={{ flex: '0 0 230px', minWidth: 230 }}
                  onDragOver={e => { e.preventDefault(); setDragOverStage(stage.id) }}
                  onDragLeave={() => setDragOverStage(null)}
                  onDrop={e => {
                    e.preventDefault()
                    setDragOverStage(null)
                    if (dragDealId.current !== null) {
                      moveDeal(dragDealId.current, stage.id)
                      dragDealId.current = null
                    }
                  }}
                >
                  {/* Stage header */}
                  <div style={{
                    padding: `${SP[2]} ${SP[3]}`, borderRadius: `${RADIUS.lg} ${RADIUS.lg} 0 0`, marginBottom: 8,
                    background: isOver ? `${headerColor}28` : `${headerColor}14`,
                    borderBottom: `2px solid ${isOver ? headerColor : headerColor + '40'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    transition: 'background .15s, border-color .15s',
                  }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: headerColor }}>{stage.name}</span>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.xl, background: `${headerColor}20`, color: headerColor }}>
                      {deals.length}
                    </span>
                  </div>
                  {/* Drop zone indicator */}
                  {isOver && (
                    <div style={{ height: 3, background: headerColor, borderRadius: 2, marginBottom: 8, opacity: 0.6 }} />
                  )}
                  {/* Deal cards */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 60 }}>
                    {deals.map(deal => (
                      <div key={deal.id}
                        draggable
                        onDragStart={() => { dragDealId.current = deal.id }}
                        onDragEnd={() => setDragOverStage(null)}
                        onClick={() => setSelected(deal)}
                        style={{
                          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg,
                          padding: `${SP[3]} 14px`, cursor: 'grab', transition: 'box-shadow .15s, opacity .15s',
                          userSelect: 'none',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--card-shadow)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 5, lineHeight: 1.3 }}>
                          {deal.title}
                        </div>
                        {(deal.first_name || deal.last_name) && (
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 5 }}>
                            {deal.first_name} {deal.last_name}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: TEXT.xs }}>
                          {deal.expected_value
                            ? <span style={{ ...NUM, color: NAVY, fontWeight: FW.bold }}>{fmtKobo(deal.expected_value * 100)}</span>
                            : <span style={{ color: 'var(--txt3)' }}>—</span>}
                          <span style={{ color: 'var(--txt3)' }}>{daysInStage(deal)}d</span>
                        </div>
                        {deal.assigned_name && (
                          <div style={{ marginTop: 6, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{deal.assigned_name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* New deal modal */}
      <CreateDealModal
        open={newDealOpen}
        stages={stages}
        onClose={() => setNewDealOpen(false)}
        onCreated={load}
      />

      {/* Deal detail modal */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? 'Deal Detail'} width={500}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <button
              onClick={() => {
                const q = selected?.contact_id ? `?contact=${selected.contact_id}` : ''
                setSelected(null); navigate(`/sales/applications/new${q}`)
              }}
              style={{ ...btnPrimary, background: GREEN }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>receipt_long</span>
              Convert to LOS
            </button>
            <button onClick={() => setSelected(null)} style={btnSecondary}>Close</button>
          </div>
        }
      >
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <StagePill name={selected.stage_name ?? '—'} color={selected.stage_color} is_won={selected.is_won} is_lost={selected.is_lost} />
              {selected.product && (
                <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${BLUE}12`, color: BLUE }}>
                  {productLabel(selected.product)}
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: TEXT.base }}>
              {[
                ['Contact',    `${selected.first_name ?? ''} ${selected.last_name ?? ''}`.trim() || '—'],
                ['Est. Value', selected.expected_value ? fmtKobo(selected.expected_value * 100) : '—'],
                ['Owner',      selected.assigned_name ?? '—'],
                ['Probability',selected.probability != null ? `${selected.probability}%` : '—'],
                ['Close Date', selected.expected_close_date ? fmtDate(selected.expected_close_date) : '—'],
                ['Last Update', fmtDatetime(selected.updated_at)],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 2 }}>{label}</div>
                  <div style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{value}</div>
                </div>
              ))}
            </div>

            {selected.notes && (
              <div style={{ padding: '10px 12px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6 }}>
                {selected.notes}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Edit stage modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Stage" width={420}
        footer={
          <>
            <button onClick={() => setEditing(null)} style={btnSecondary}>Cancel</button>
            <button onClick={saveStage} disabled={savingStage || !editStageId}
              style={{ ...btnPrimary, opacity: (savingStage || !editStageId) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {savingStage && <Spinner size={14} color="#fff" />}Save
            </button>
          </>
        }
      >
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{editing.title}</div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Stage</label>
              <select value={editStageId} onChange={e => setEditStageId(e.target.value)}
                style={{ ...filterInputStyle, width: '100%', height: 38 }}>
                <option value="">— Select stage —</option>
                {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
        )}
      </Modal>

      {/* Log activity modal */}
      <Modal open={!!activity} onClose={() => setActivity(null)} title="Log Activity" width={440}
        footer={
          <>
            <button onClick={() => setActivity(null)} style={btnSecondary}>Cancel</button>
            <button onClick={saveActivity} disabled={savingAct}
              style={{ ...btnPrimary, opacity: savingAct ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {savingAct && <Spinner size={14} color="#fff" />}Log
            </button>
          </>
        }
      >
        {activity && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              {activity.title}
              {(activity.first_name || activity.last_name) && ` · ${`${activity.first_name ?? ''} ${activity.last_name ?? ''}`.trim()}`}
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Type</label>
              <select value={actType} onChange={e => setActType(e.target.value)}
                style={{ ...filterInputStyle, width: '100%', height: 38 }}>
                {['call', 'email', 'meeting', 'note', 'other'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Subject</label>
              <input value={actSubj} onChange={e => setActSubj(e.target.value)}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Notes</label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={actBody} onChange={e => setActBody(e.target.value)} rows={3}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, resize: 'vertical' }} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Outcome</label>
              <input value={actOutc} onChange={e => setActOutc(e.target.value)}
                style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const, height: 38 }} />
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk-assign modal */}
      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Assign ${bulkSel.size} deal${bulkSel.size > 1 ? 's' : ''}`} width={420}
        footer={
          <>
            <button onClick={() => setAssignOpen(false)} style={btnSecondary}>Cancel</button>
            <button onClick={bulkAssignDeals} disabled={assignSaving || !assignTo}
              style={{ ...btnPrimary, opacity: (assignSaving || !assignTo) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {assignSaving && <Spinner size={14} color="#fff" />}Assign
            </button>
          </>
        }
      >
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Owner</label>
          <select value={assignTo} onChange={e => setAssignTo(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', height: 38 }}>
            <option value="">— Select owner —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
      </Modal>
    </Page>
  )
}
