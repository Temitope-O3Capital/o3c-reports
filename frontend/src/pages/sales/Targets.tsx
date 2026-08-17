import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, ErrBanner, Spinner, Modal, DataTable, DateFilter,
  NameCell, ExpandableFilterBar,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { monthStart, today } from '../../lib/fmt'
import { currentUser, isSalesHead } from '../../hooks/useAuth'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesTarget {
  id:               number
  user_id:          number
  full_name:        string
  email:            string
  period:           string
  loan_count:       number
  disbursement_kobo: number
  fd_count:         number
  fd_amount_kobo:   number
  notes:            string
}

interface Actual {
  user_id:      number
  full_name:    string
  target_loans: number
  target_kobo:  number
  target_fds:   number
  target_fd_kobo: number
  actual_loans: number
  actual_kobo:  number
  actual_fds:   number
  actual_fd_kobo: number
}

interface User { id: number; full_name: string; role: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtNaira(kobo: number) {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`
}

function ragColor(pct: number) {
  if (pct >= 100) return GREEN
  if (pct >= 50)  return AMBER
  return RED
}

function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── RAG bar ───────────────────────────────────────────────────────────────────

function RagBar({ actual, target }: { actual: number; target: number }) {
  const pct = target > 0 ? Math.min(Math.round((actual / target) * 100), 100) : 0
  const color = ragColor(pct)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 7, background: 'var(--th-bg)', borderRadius: RADIUS.xs, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: RADIUS.xs, transition: 'width .4s' }} />
      </div>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color, minWidth: 32, ...NUM }}>{pct}%</span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SalesTargets() {
  // A target is set for you, not by you. Heads get the editing controls; everyone
  // else gets the same numbers read-only, plus their own row pulled out at the top
  // — an officer opening this page wants their figure first, not to hunt the table.
  const me      = currentUser()
  const canEdit = isSalesHead(me)

  const [actuals,  setActuals]  = useState<Actual[]>([])
  const [targets,  setTargets]  = useState<SalesTarget[]>([])
  const [users,    setUsers]    = useState<User[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [period,   setPeriod]   = useState(currentPeriod)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [showForm, setShowForm] = useState(false)
  const [saving,   setSaving]   = useState(false)
  const [bulkSel,  setBulkSel]  = useState<Set<string | number>>(new Set())
  const [search,   setSearch]   = useState('')

  // form state
  const [fUserId,  setFUserId]  = useState('')
  const [fLoans,   setFLoans]   = useState('')
  const [fDisb,    setFDisb]    = useState('')
  const [fFds,     setFFds]     = useState('')
  const [fFdAmt,   setFFdAmt]   = useState('')
  const [fNotes,   setFNotes]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [act, tgt] = await Promise.all([
        apiFetch<{ data: Actual[] }>(`/api/sales/targets/actuals?period=${period}&from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: SalesTarget[] }>(`/api/sales/targets?period=${period}&from=${dateFrom}&to=${dateTo}`),
      ])
      setActuals(act?.data ?? [])
      setTargets(tgt?.data ?? [])
      // Only a head needs the assignable-officer list, and /api/admin/users is
      // admin-scoped — fetching it as an officer just 403s and blanks the page.
      // The sales officers endpoint is the right source anyway: it lists who can
      // actually hold a book rather than filtering on a role label that nobody carries.
      if (canEdit) {
        // /api/sales/officers is the shared officer list (id, full_name, role) that
        // Book.tsx and Leads.tsx use; /book/officers does not exist and falls through
        // to /book/{cif}.
        const usr = await apiFetch<{ data: User[] }>('/api/sales/officers')
        setUsers(Array.isArray(usr) ? usr : (usr?.data ?? []))
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [period, dateFrom, dateTo, canEdit])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals','crm'] })

  async function handleSave() {
    setSaving(true)
    try {
      await apiPost('/api/sales/targets', {
        user_id:           parseInt(fUserId),
        period,
        loan_count:        parseInt(fLoans) || 0,
        disbursement_kobo: Math.round(parseFloat(fDisb) * 100) || 0,
        fd_count:          parseInt(fFds) || 0,
        fd_amount_kobo:    Math.round(parseFloat(fFdAmt) * 100) || 0,
        notes:             fNotes,
      })
      toast.success('Target saved')
      setShowForm(false); setFUserId(''); setFLoans(''); setFDisb(''); setFFds(''); setFFdAmt(''); setFNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  // Merge actuals with any targets not yet in actuals — then search-filter
  const leaderboard: Actual[] = actuals.map(a => {
    const t = targets.find(t => t.user_id === a.user_id)
    return {
      ...a,
      target_loans:   t?.loan_count ?? a.target_loans,
      target_kobo:    t?.disbursement_kobo ?? a.target_kobo,
      target_fds:     t?.fd_count ?? a.target_fds,
      target_fd_kobo: t?.fd_amount_kobo ?? a.target_fd_kobo,
    }
  })

  const myRow = useMemo(
    () => (me ? leaderboard.find(r => Number(r.user_id) === Number(me.id)) ?? null : null),
    [leaderboard, me],
  )

  const filteredBoard = useMemo(() => {
    if (!search) return leaderboard
    const q = search.toLowerCase()
    return leaderboard.filter(r => r.full_name.toLowerCase().includes(q))
  }, [leaderboard, search])

  function exportBoardCsv(data: Actual[]) {
    const header = ['Officer', 'Actual Loans', 'Target Loans', 'Actual Disbursement (kobo)', 'Target Disbursement (kobo)', 'Actual FDs', 'Target FDs', 'Actual FD Amount (kobo)', 'Target FD Amount (kobo)']
    const lines = data.map(r => [
      `"${String(r.full_name ?? '').replace(/"/g, '""')}"`,
      r.actual_loans,
      r.target_loans,
      r.actual_kobo,
      r.target_kobo,
      r.actual_fds,
      r.target_fds,
      r.actual_fd_kobo,
      r.target_fd_kobo,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `sales-targets-${period}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const totalTargetLoans = leaderboard.reduce((s, r) => s + Number(r.target_loans), 0)
  const totalActualLoans = leaderboard.reduce((s, r) => s + Number(r.actual_loans), 0)
  const totalTargetKobo  = leaderboard.reduce((s, r) => s + Number(r.target_kobo), 0)
  const totalActualKobo  = leaderboard.reduce((s, r) => s + Number(r.actual_kobo), 0)
  const totalTargetFds   = leaderboard.reduce((s, r) => s + Number(r.target_fds), 0)
  const totalActualFds   = leaderboard.reduce((s, r) => s + Number(r.actual_fds), 0)
  const totalTargetFdKobo = leaderboard.reduce((s, r) => s + Number(r.target_fd_kobo), 0)
  const totalActualFdKobo = leaderboard.reduce((s, r) => s + Number(r.actual_fd_kobo), 0)

  const COLS: TableCol<Actual>[] = [
    {
      key: 'full_name', label: 'Officer',
      render: r => <NameCell name={r.full_name} />,
    },
    {
      key: 'actual_loans', label: 'Loans',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: ragColor(r.target_loans > 0 ? (r.actual_loans / r.target_loans) * 100 : 100) }}>
            {r.actual_loans} / {r.target_loans}
          </div>
          <RagBar actual={r.actual_loans} target={r.target_loans} />
        </div>
      ),
    },
    {
      key: 'actual_kobo', label: 'Disbursement',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: ragColor(r.target_kobo > 0 ? (r.actual_kobo / r.target_kobo) * 100 : 100) }}>
            {fmtNaira(r.actual_kobo)} / {fmtNaira(r.target_kobo)}
          </div>
          <RagBar actual={r.actual_kobo} target={r.target_kobo} />
        </div>
      ),
    },
    {
      key: 'actual_fds', label: 'Fixed Deposits',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: ragColor(r.target_fds > 0 ? (r.actual_fds / r.target_fds) * 100 : 100) }}>
            {r.actual_fds} / {r.target_fds}
          </div>
          <RagBar actual={r.actual_fds} target={r.target_fds} />
        </div>
      ),
    },
    {
      key: 'actual_fd_kobo', label: 'FD Amount',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: ragColor(r.target_fd_kobo > 0 ? (r.actual_fd_kobo / r.target_fd_kobo) * 100 : 100) }}>
            {fmtNaira(r.actual_fd_kobo)} / {fmtNaira(r.target_fd_kobo)}
          </div>
          <RagBar actual={r.actual_fd_kobo} target={r.target_fd_kobo} />
        </div>
      ),
    },
    {
      key: 'user_id', label: 'Rank',
      render: (_, i) => (
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: i === 0 ? '#F59E0B' : i === 1 ? 'var(--chart-lbl)' : i === 2 ? '#C2820E' : 'var(--txt3)' }}>
          #{(i ?? 0) + 1}
        </span>
      ),
    },
  ]

  return (
    <Page
      title="Sales Targets"
      subtitle={`Performance vs targets — ${period}`}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: INTER }} />
          {canEdit && (
            <button onClick={() => setShowForm(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              Set Target
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* An officer's own number, first. Without this they have to find themselves in
          a league table sorted by performance — which is exactly the row they are
          least motivated to scroll to when they are behind. */}
      {!canEdit && myRow && (
        <div style={{ background: 'var(--card)', border: `1px solid ${BLUE}33`, borderLeft: `3px solid ${BLUE}`, borderRadius: RADIUS.xl, padding: '16px 18px', marginBottom: SP[5] }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>
            My target — {period}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {myRow.actual_loans} / {myRow.target_loans} loans
              </div>
              <RagBar actual={Number(myRow.actual_loans)} target={Number(myRow.target_loans)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {fmtNaira(Number(myRow.actual_kobo))} / {fmtNaira(Number(myRow.target_kobo))}
              </div>
              <RagBar actual={Number(myRow.actual_kobo)} target={Number(myRow.target_kobo)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {myRow.actual_fds} / {myRow.target_fds} FDs
              </div>
              <RagBar actual={Number(myRow.actual_fds)} target={Number(myRow.target_fds)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {fmtNaira(Number(myRow.actual_fd_kobo))} / {fmtNaira(Number(myRow.target_fd_kobo))}
              </div>
              <RagBar actual={Number(myRow.actual_fd_kobo)} target={Number(myRow.target_fd_kobo)} />
            </div>
          </div>
        </div>
      )}
      {!canEdit && !loading && !myRow && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 18px', marginBottom: SP[5], fontSize: TEXT.base, color: 'var(--txt2)' }}>
          No target has been set for you for {period}. Your team lead sets these.
        </div>
      )}

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[5] }}>
        {[
          { label: 'Target Loans',    value: totalTargetLoans,              fmt: (v: number) => v.toLocaleString() },
          { label: 'Actual Loans',    value: totalActualLoans,              fmt: (v: number) => v.toLocaleString(),      color: ragColor(totalTargetLoans > 0 ? (totalActualLoans / totalTargetLoans) * 100 : 100) },
          { label: 'Target Disb.',    value: totalTargetKobo,               fmt: fmtNaira },
          { label: 'Actual Disb.',    value: totalActualKobo,               fmt: fmtNaira,                               color: ragColor(totalTargetKobo > 0 ? (totalActualKobo / totalTargetKobo) * 100 : 100) },
          { label: 'Target FDs',      value: totalTargetFds,                fmt: (v: number) => v.toLocaleString() },
          { label: 'Actual FDs',      value: totalActualFds,                fmt: (v: number) => v.toLocaleString(),      color: ragColor(totalTargetFds > 0 ? (totalActualFds / totalTargetFds) * 100 : 100) },
          { label: 'Target FD Amt.',  value: totalTargetFdKobo,             fmt: fmtNaira },
          { label: 'Actual FD Amt.',  value: totalActualFdKobo,             fmt: fmtNaira,                               color: ragColor(totalTargetFdKobo > 0 ? (totalActualFdKobo / totalTargetFdKobo) * 100 : 100) },
        ].map(({ label, value, fmt, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: color ?? 'var(--txt)', ...NUM }}>{fmt(value)}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Leaderboard" badge={leaderboard.length} padding={false}>
          <ExpandableFilterBar
            search={search}
            onSearch={setSearch}
            placeholder="Search officer…"
            groups={[]}
            onReset={() => setSearch('')}
            resultCount={filteredBoard.length}
            totalCount={leaderboard.length}
          />
          <DataTable
            cols={COLS}
            rows={filteredBoard}
            keyFn={r => r.user_id}
            emptyText="No targets set for this period"
            selectable
            selectedIds={bulkSel}
            onSelect={setBulkSel}
            bulkBar={
              <button onClick={() => exportBoardCsv(bulkSel.size ? filteredBoard.filter(r => bulkSel.has(r.user_id)) : filteredBoard)}
                style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer' }}>Export</button>
            }
          />
        </SectionCard>
      )}

      {/* Set Target modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title="Set Sales Target" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving}
              style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}Save
            </button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Officer</label>
            <select value={fUserId} onChange={e => setFUserId(e.target.value)}
              style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              <option value="">— Select officer —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
          {[
            { label: 'Loan Count Target', value: fLoans, set: setFLoans, type: 'number', placeholder: '0' },
            { label: 'Disbursement Target (₦)', value: fDisb, set: setFDisb, type: 'number', placeholder: '0.00' },
            { label: 'FD Count Target', value: fFds, set: setFFds, type: 'number', placeholder: '0' },
            { label: 'FD Amount Target (₦)', value: fFdAmt, set: setFFdAmt, type: 'number', placeholder: '0.00' },
          ].map(({ label, value, set, type, placeholder }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)} placeholder={placeholder}
                style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={fNotes} onChange={e => setFNotes(e.target.value)} rows={2} placeholder="Optional notes…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
