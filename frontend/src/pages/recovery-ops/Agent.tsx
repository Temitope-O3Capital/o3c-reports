import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { EArea } from '../../components/echarts'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, ExpandableFilterBar, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LogPaymentModal } from '../../components/LogPaymentModal'
import { RECOVERY_PAYMENT_CHANNELS } from '../../lib/paymentChannels'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { fmtKoboExact, fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, NAVY, GREEN, BLUE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, StatusPill, HeroButton, myUserId } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Case {
  id: number; case_ref: string; debtor_name: string
  outstanding_kobo: number; dpd: number; next_action: string
  next_action_date: string; status: string
}

interface Visit {
  id: number; case_ref: string; debtor_name: string
  outcome: string; visited_at: string; amount_promised_kobo: number
}

interface RecoveryAgentDash {
  assigned_cases: number; cases_closed_mtd: number
  calls_made_mtd: number; amount_collected_mtd_kobo: number
  cases: Case[]
  recent_visits: Visit[]
  monthly_trend: { month: string; collected: number; calls: number }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function DpdCell({ dpd }: { dpd: number }) {
  const color = dpd > 90 ? RED : dpd > 30 ? AMBER : 'var(--txt)'
  return <span style={{ color, fontWeight: dpd > 30 ? FW.semibold : FW.normal, ...NUM }}>{dpd}d</span>
}

function outcomeColor(o: string) {
  const l = o.toLowerCase()
  if (l.includes('paid') || l.includes('promise')) return GREEN
  if (l.includes('refus') || l.includes('absent')) return RED
  return AMBER
}

// ── Case-action modals ─────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, width: '100%',
}
const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6,
}

const actionBtn = (color: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 9px', borderRadius: '6px',
  border: `1.5px solid ${color}40`, background: `${color}0A`,
  color, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
  whiteSpace: 'nowrap',
})
const actionIcon: React.CSSProperties = { fontSize: 14, lineHeight: 1 }

function Chip({ active, color, onClick, children }: { active: boolean; color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: RADIUS.md, cursor: 'pointer',
        border: active ? `1.5px solid ${color}` : '1.5px solid var(--input-bdr)',
        background: active ? `${color}12` : 'var(--input-bg)',
        color: active ? color : 'var(--txt)',
        fontSize: TEXT.xs, fontWeight: active ? FW.semibold : FW.normal,
      }}
    >
      {children}
    </button>
  )
}

const VISIT_TYPES: { value: string; label: string }[] = [
  { value: 'field', label: 'Field Visit' },
  { value: 'phone', label: 'Phone Call' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal Notice' },
]
const VISIT_OUTCOMES: { value: string; label: string }[] = [
  { value: 'paid', label: 'Paid' },
  { value: 'promised', label: 'Promised to Pay' },
  { value: 'refused', label: 'Refused' },
  { value: 'absent', label: 'Not Available' },
  { value: 'no_contact', label: 'No Contact' },
]

function LogVisitModal({ caseItem, onClose, onSuccess }: { caseItem: Case | null; onClose: () => void; onSuccess: () => void }) {
  const [visitDate, setVisitDate] = useState('')
  const [visitType, setVisitType] = useState('')
  const [outcome, setOutcome] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (caseItem) {
      setVisitDate(new Date().toISOString().slice(0, 10))
      setVisitType(''); setOutcome(''); setNotes('')
    }
  }, [caseItem])

  const save = useCallback(async () => {
    if (!caseItem) return
    if (!visitDate) { toast.error('Visit date is required'); return }
    if (!visitType) { toast.error('Visit type is required'); return }
    setSaving(true)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseItem.id}/visit`, {
        visit_date: visitDate, visit_type: visitType, outcome: outcome || null, notes: notes || null,
      })
      toast.success('Visit logged')
      onSuccess()
    } catch (e: any) { toast.error(e?.message || 'Could not log visit') }
    finally { setSaving(false) }
  }, [caseItem, visitDate, visitType, outcome, notes, onSuccess])

  return (
    <Modal
      open={!!caseItem}
      onClose={onClose}
      title={`Log Visit: ${caseItem?.debtor_name ?? ''}`}
      width={520}
      footer={<>
        <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Log Visit'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        <div>
          <label style={fieldLabel}>Visit Date</label>
          <input type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={fieldLabel}>Visit Type</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[2] }}>
            {VISIT_TYPES.map(t => (
              <Chip key={t.value} active={visitType === t.value} color={NAVY} onClick={() => setVisitType(t.value)}>{t.label}</Chip>
            ))}
          </div>
        </div>
        <div>
          <label style={fieldLabel}>Outcome</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[2] }}>
            {VISIT_OUTCOMES.map(o => (
              <Chip key={o.value} active={outcome === o.value} color={NAVY} onClick={() => setOutcome(outcome === o.value ? '' : o.value)}>{o.label}</Chip>
            ))}
          </div>
        </div>
        <div>
          <label style={fieldLabel}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What happened on this visit?" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
      </div>
    </Modal>
  )
}

function WriteoffModal({ caseItem, onClose, onSuccess }: { caseItem: Case | null; onClose: () => void; onSuccess: () => void }) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (caseItem) { setAmount(''); setReason('') }
  }, [caseItem])

  const save = useCallback(async () => {
    if (!caseItem) return
    const amt = parseFloat(amount)
    if (!(amt > 0)) { toast.error('Enter a write-off amount greater than zero'); return }
    if (!reason.trim()) { toast.error('A reason is required'); return }
    setSaving(true)
    try {
      await apiPost(`/api/recovery-ops/cases/${caseItem.id}/write-off`, {
        amount_kobo: Math.round(amt * 100), reason: reason.trim(),
      })
      toast.success('Write-off request submitted')
      onSuccess()
    } catch (e: any) { toast.error(e?.message || 'Could not submit write-off') }
    finally { setSaving(false) }
  }, [caseItem, amount, reason, onSuccess])

  return (
    <Modal
      open={!!caseItem}
      onClose={onClose}
      title={`Request Write-off: ${caseItem?.debtor_name ?? ''}`}
      width={480}
      footer={<>
        <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Submitting…' : 'Submit Request'}</button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        {caseItem && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
            Outstanding: <strong style={{ ...NUM, color: 'var(--txt)' }}>{fmtKoboExact(caseItem.outstanding_kobo)}</strong>
          </div>
        )}
        <div>
          <label style={fieldLabel}>Write-off Amount (₦)</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
        </div>
        <div>
          <label style={fieldLabel}>Reason</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={4} placeholder="Justification for this write-off request" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ fontSize: TEXT['2xs'], color: AMBER, fontWeight: FW.medium }}>
          Write-offs require approval before they take effect.
        </div>
      </div>
    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RecoveryAgentDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<RecoveryAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchCases, setSearchCases] = useState('')
  const [searchVisits, setSearchVisits] = useState('')
  const [payCase, setPayCase] = useState<Case | null>(null)
  const [visitCase, setVisitCase] = useState<Case | null>(null)
  const [writeoffCase, setWriteoffCase] = useState<Case | null>(null)
  const [status, setStatus] = useState('available')

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<{ data: RecoveryAgentDash }>('/api/recovery-ops/agent-dashboard')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  const changeStatus = useCallback(async (s: string) => {
    setStatus(s)
    const uid = myUserId()
    if (!uid) return
    try { await apiFetch(`/api/helpdesk/agents/${uid}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }) }
    catch (e: any) { toast.error(e?.message || 'Could not update status') }
  }, [])

  const displayedCases = useMemo(() => {
    const rows = data?.cases ?? []
    if (!searchCases.trim()) return rows
    const q = searchCases.toLowerCase()
    return rows.filter(r =>
      [r.case_ref, r.debtor_name, r.status, r.next_action].some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [data?.cases, searchCases])

  const displayedVisits = useMemo(() => {
    const rows = data?.recent_visits ?? []
    if (!searchVisits.trim()) return rows
    const q = searchVisits.toLowerCase()
    return rows.filter(r =>
      [r.debtor_name, r.outcome, r.case_ref].some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [data?.recent_visits, searchVisits])

  if (loading && !data) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !data) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!data) return null

  const now = Date.now()
  const actionsDue = data.cases.filter(c => c.next_action_date && new Date(c.next_action_date).getTime() <= now).length
  const severe = data.cases.filter(c => c.dpd > 90).length
  const clearMax = Math.max(1, data.assigned_cases + data.cases_closed_mtd)

  const caseCols: TableCol<Case>[] = [
    { key: 'case_ref', label: 'Case Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.case_ref}</span> },
    { key: 'debtor_name', label: 'Debtor' },
    { key: 'outstanding_kobo', label: 'Outstanding', render: r => <span style={NUM}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'dpd', label: 'DPD', render: r => <DpdCell dpd={r.dpd} /> },
    { key: 'next_action', label: 'Next Action', render: r => (
      <div>
        <div style={{ fontSize: TEXT.xs }}>{r.next_action}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{fmtDate(r.next_action_date)}</div>
      </div>
    )},
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={NAVY} /> },
    {
      key: 'id', label: 'Actions',
      render: r => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); setPayCase(r) }}
            style={actionBtn(GREEN)}
          >
            <span className="material-symbols-rounded" style={actionIcon}>payments</span>
            Payment
          </button>
          <button
            onClick={e => { e.stopPropagation(); setVisitCase(r) }}
            style={actionBtn(NAVY)}
          >
            <span className="material-symbols-rounded" style={actionIcon}>directions_walk</span>
            Visit
          </button>
          <button
            onClick={e => { e.stopPropagation(); setWriteoffCase(r) }}
            style={actionBtn(RED)}
          >
            <span className="material-symbols-rounded" style={actionIcon}>money_off</span>
            Write-off
          </button>
        </div>
      ),
    },
  ]

  const visitCols: TableCol<Visit>[] = [
    { key: 'debtor_name', label: 'Debtor', render: r => (
      <div>
        <div>{r.debtor_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.case_ref}</div>
      </div>
    )},
    { key: 'outcome', label: 'Outcome', render: r => <StatusPill label={r.outcome} color={outcomeColor(r.outcome)} /> },
    { key: 'visited_at', label: 'Date', render: r => fmtDate(r.visited_at) },
    { key: 'amount_promised_kobo', label: 'Promised', render: r => <span style={NUM}>{fmtKoboExact(r.amount_promised_kobo)}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your recovery station: cases, visits and collections">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={<>You've collected <strong style={{ color: '#fff' }}>{fmtKoboExact(data.amount_collected_mtd_kobo)}</strong> this month · {fmtNum(data.cases_closed_mtd)} case{data.cases_closed_mtd === 1 ? '' : 's'} closed{severe > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{severe}</strong> at 90+ DPD</> : ''}</>}
        ring={{ value: data.cases_closed_mtd, max: clearMax, unit: 'cases' }}
        stats={[
          { label: 'Assigned Cases', value: fmtNum(data.assigned_cases) },
          { label: 'Closed MTD', value: fmtNum(data.cases_closed_mtd), color: '#4ADE80' },
          { label: 'Calls MTD', value: fmtNum(data.calls_made_mtd) },
          { label: 'Collected MTD', value: fmtKoboExact(data.amount_collected_mtd_kobo), color: '#4ADE80' },
        ]}
        actions={<>
          <HeroButton icon="folder_open" label="My Cases" primary onClick={() => navigate('/recovery/cases')} />
          <HeroButton icon="gavel" label="Legal Tracker" onClick={() => navigate('/recovery/legal')} />
          <HeroButton icon="sell" label="Debt Sales" onClick={() => navigate('/recovery/debt-sales')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="cases to work today">
        <MyDayTile icon="event_available" count={fmtNum(actionsDue)} label="Actions due"
          sub={actionsDue > 0 ? 'follow-ups scheduled by now' : 'nothing due'}
          color={AMBER} urgent={actionsDue > 0} onClick={() => navigate('/recovery/cases')} />
        <MyDayTile icon="priority_high" count={fmtNum(severe)} label="Severe (90+ DPD)"
          sub={severe > 0 ? 'escalate or push hard' : 'none at 90+ DPD'}
          color={severe > 0 ? RED : GREEN} urgent={severe > 0} onClick={() => navigate('/recovery/cases')} />
        <MyDayTile icon="directions_walk" count={fmtNum(data.recent_visits.length)} label="Recent visits"
          sub="field visits logged" color={BLUE} />
        <MyDayTile icon="payments" count={fmtKoboExact(data.amount_collected_mtd_kobo)} label="Collected MTD"
          sub="recovered this month" color={GREEN} />
      </MyDaySection>

      {/* Cases table */}
      <SectionCard title="My Cases" badge={data.cases.length} padding={false} style={{ marginBottom: SP[4] }}>
        <ExpandableFilterBar
          search={searchCases}
          onSearch={setSearchCases}
          groups={[]}
          onReset={() => setSearchCases('')}
          resultCount={displayedCases.length}
          totalCount={data.cases.length}
          placeholder="Search cases…"
        />
        <DataTable
          cols={caseCols}
          rows={displayedCases}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/recovery/cases/${r.id}`)}
          pageSize={10}
          emptyText="No cases assigned"
        />
      </SectionCard>

      {/* Trend chart + recent visits */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <SectionCard title="Monthly Collection Trend">
          <EArea
            data={data.monthly_trend}
            xKey="month"
            height={200}
            endLabel
            hideYAxis
            valueFmt={(v) => fmtKoboExact(v)}
            series={[{ key: 'collected', name: 'Collected', color: GREEN }]}
          />
        </SectionCard>

        <SectionCard title="Recent Field Visits" padding={false}>
          <ExpandableFilterBar
            search={searchVisits}
            onSearch={setSearchVisits}
            groups={[]}
            onReset={() => setSearchVisits('')}
            resultCount={displayedVisits.length}
            totalCount={data.recent_visits.length}
            placeholder="Search visits…"
          />
          <DataTable
            cols={visitCols}
            rows={displayedVisits}
            keyFn={r => r.id}
            emptyText="No visits recorded"
          />
        </SectionCard>
      </div>
      <LogPaymentModal
        open={!!payCase}
        onClose={() => setPayCase(null)}
        title={`Log Payment: ${payCase?.debtor_name ?? ''}`}
        endpoint={payCase ? `/api/recovery-ops/cases/${payCase.id}/payment` : ''}
        onSuccess={() => { setPayCase(null); load() }}
        channels={RECOVERY_PAYMENT_CHANNELS}
      />
      <LogVisitModal
        caseItem={visitCase}
        onClose={() => setVisitCase(null)}
        onSuccess={() => { setVisitCase(null); load() }}
      />
      <WriteoffModal
        caseItem={writeoffCase}
        onClose={() => setWriteoffCase(null)}
        onSuccess={() => { setWriteoffCase(null); load() }}
      />
    </Page>
  )
}
