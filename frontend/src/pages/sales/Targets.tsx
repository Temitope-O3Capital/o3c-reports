import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, ErrBanner, Spinner, Modal, DataTable,
  NameCell, ExpandableFilterBar,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { SelectMenu } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
  card_count:       number
  notes:            string
}

interface Actual {
  user_id:      number
  full_name:    string
  target_loans: number
  target_kobo:  number
  target_fds:   number
  target_fd_kobo: number
  target_cards: number
  actual_loans: number
  actual_kobo:  number
  actual_fds:   number
  actual_fd_kobo: number
  actual_cards: number
  commission_kobo: number
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

// A target of 0 means "not set", not "0% achieved". Submissions from Sales arrive as
// naira only — no counts — so the loan/FD/card COUNT targets sit at 0 for the whole
// team. The old code passed 100 here, painting the actual GREEN as though it had been
// hit, while RagBar painted the same cell RED at 0%. Both are wrong: show it as unset.
function metricColor(actual: number, target: number) {
  return target > 0 ? ragColor((actual / target) * 100) : 'var(--txt)'
}

const NOT_SET = '—'

// ── Cards cannot be measured yet, and the page has to say so ──────────────────
//
// app.v_card_sale_officer holds 18,407 rows and officer_id is NULL on EVERY ONE — not a
// single card in the whole history is attributed to a seller. Its three sources explain
// why: card_sale_attributions has 0 rows, card_issuance_requests has 0 rows, and the
// legacy customer_officers fallback is Udara-keyed, so it names a different person's
// officer on most rows and is deliberately not trusted.
//
// So `actual_cards` is structurally zero for every officer, in every period, and will
// stay that way until cards are sold through the Issuance flow. Rendering that as "0"
// next to a target is a false statement: "nobody sold a card" and "nothing records who
// sold a card" look identical on screen and mean completely different things — the first
// is a performance problem, the second is a missing pipeline, and only one of them is
// the officer's fault.
//
// Measured 28 Sept 2026. The moment the Issuance flow is used this flips on its own: the
// gate is whether ANY card has ever been attributed, not a hard-coded switch.
const CARDS_UNMEASURABLE_NOTE =
  'No card sale has ever been attributed to a seller — the Issuance flow is what records ' +
  'it, and it has not been used yet. Until then this cannot be measured, so it is not ' +
  'scored rather than shown as zero.'

function fmtCountTarget(n: number) {
  return n > 0 ? n.toLocaleString() : NOT_SET
}

function fmtNairaTarget(kobo: number) {
  return kobo > 0 ? fmtNaira(kobo) : NOT_SET
}

function currentPeriod() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Targets arrive from Sales as one figure against a range of months ("January - June:
// Deposit N130m | Risk N25m"), but a target row is per month. Rather than making a head
// repeat the same entry twelve times, one save writes one row per month in the range.
const MAX_RANGE_MONTHS = 24

// Inclusive list of 'YYYY-MM' between two months. Returns [] for a backwards or
// unparseable range, or one longer than the cap — callers treat that as "do not save",
// so a mistyped year cannot quietly write hundreds of rows.
function monthsInRange(from: string, to: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return []
  const [fromYear, fromMonth] = from.split('-').map(Number)
  const [toYear, toMonth] = to.split('-').map(Number)
  let cursor = fromYear * 12 + (fromMonth - 1)
  const end = toYear * 12 + (toMonth - 1)
  if (cursor > end || end - cursor >= MAX_RANGE_MONTHS) return []
  const out: string[] = []
  while (cursor <= end) {
    out.push(`${Math.floor(cursor / 12)}-${String((cursor % 12) + 1).padStart(2, '0')}`)
    cursor++
  }
  return out
}

// ── RAG bar ───────────────────────────────────────────────────────────────────

function RagBar({ actual, target }: { actual: number; target: number }) {
  // No target set: an empty track and a dash, rather than a red 0% that reads as failure.
  if (!(target > 0)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 7, background: 'var(--th-bg)', borderRadius: RADIUS.xs }} />
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt3)', minWidth: 32 }}>{NOT_SET}</span>
      </div>
    )
  }
  const pct = Math.min(Math.round((actual / target) * 100), 100)
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
  const [fCards,   setFCards]   = useState('')
  const [fNotes,   setFNotes]   = useState('')
  const [fFrom,    setFFrom]    = useState(currentPeriod)
  const [fTo,      setFTo]      = useState(currentPeriod)

  // What the range in the form covers right now. Drives the hint under the inputs and
  // the Save button's disabled state, so a head can see how many rows one click writes
  // before clicking it.
  const formMonths = monthsInRange(fFrom, fTo)


  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const [act, tgt] = await Promise.all([
        apiFetch<{ data: Actual[] }>(`/api/sales/targets/actuals?period=${period}`),
        apiFetch<{ data: SalesTarget[] }>(`/api/sales/targets?period=${period}`),
      ])
      setActuals(act?.data ?? [])
      setTargets(tgt?.data ?? [])
      // Commission RATE SETTING now lives under Finance (finance/Overview →
      // CommissionRatesModal). This page only shows the commission EARNED per officer.
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
  }, [period, canEdit])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  async function handleSave() {
    if (!fUserId) { toast.error('Pick an officer first'); return }
    if (!formMonths.length) {
      toast.error(`Check the range: ${fFrom} to ${fTo} runs backwards or is longer than ${MAX_RANGE_MONTHS} months`)
      return
    }
    setSaving(true)
    // Same figures against every month in the range. The endpoint upserts on
    // (user_id, period), so re-entering a range corrects those months rather than
    // duplicating them. Posted in sequence, not in parallel, so a failure part way
    // through can say exactly how far it got instead of leaving it a guess.
    const figures = {
      user_id:           parseInt(fUserId),
      loan_count:        parseInt(fLoans) || 0,
      disbursement_kobo: Math.round(parseFloat(fDisb) * 100) || 0,
      fd_count:          parseInt(fFds) || 0,
      fd_amount_kobo:    Math.round(parseFloat(fFdAmt) * 100) || 0,
      card_count:        parseInt(fCards) || 0,
      notes:             fNotes,
    }
    let saved = 0
    try {
      for (const month of formMonths) {
        await apiPost('/api/sales/targets', { ...figures, period: month })
        saved++
      }
      toast.success(formMonths.length === 1
        ? 'Target saved'
        : `Target saved for ${formMonths.length} months (${formMonths[0]} to ${formMonths[formMonths.length - 1]})`)
      setShowForm(false)
      setFUserId(''); setFLoans(''); setFDisb(''); setFFds(''); setFFdAmt(''); setFCards(''); setFNotes('')
      // Land on a month that was actually written, otherwise a save outside the month
      // being viewed looks like it did nothing. Changing the period reloads on its own.
      if (!formMonths.includes(period)) setPeriod(formMonths[0])
      else load()
    } catch (e: any) {
      toast.error(saved
        ? `Saved ${saved} of ${formMonths.length} months, then failed on ${formMonths[saved]}: ${e.message}`
        : e.message)
      load()
    }
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
      target_cards:   t?.card_count ?? a.target_cards,
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


  const totalTargetLoans = leaderboard.reduce((s, r) => s + Number(r.target_loans), 0)
  const totalActualLoans = leaderboard.reduce((s, r) => s + Number(r.actual_loans), 0)
  const totalTargetKobo  = leaderboard.reduce((s, r) => s + Number(r.target_kobo), 0)
  const totalActualKobo  = leaderboard.reduce((s, r) => s + Number(r.actual_kobo), 0)
  const totalTargetFds   = leaderboard.reduce((s, r) => s + Number(r.target_fds), 0)
  const totalActualFds   = leaderboard.reduce((s, r) => s + Number(r.actual_fds), 0)
  const totalTargetFdKobo = leaderboard.reduce((s, r) => s + Number(r.target_fd_kobo), 0)
  const totalActualFdKobo = leaderboard.reduce((s, r) => s + Number(r.actual_fd_kobo), 0)
  const totalTargetCards  = leaderboard.reduce((s, r) => s + Number(r.target_cards), 0)
  const totalActualCards  = leaderboard.reduce((s, r) => s + Number(r.actual_cards), 0)

  // Derived, not hard-coded: cards become measurable the moment ANY card in the period
  // resolves to a seller. So the day the Issuance flow is first used, this page starts
  // scoring cards on its own with no code change. See CARDS_UNMEASURABLE_NOTE.
  const cardsMeasurable = totalActualCards > 0

  // No target on ANY dimension for this period. Distinguished from "a target of zero",
  // which is a deliberate instruction and shows as 0.
  const untargeted = leaderboard.filter(r =>
    !Number(r.target_loans) && !Number(r.target_kobo) && !Number(r.target_fds) &&
    !Number(r.target_fd_kobo) && !Number(r.target_cards))
  const totalCommission   = leaderboard.reduce((s, r) => s + Number(r.commission_kobo ?? 0), 0)

  const COLS: TableCol<Actual>[] = [
    {
      key: 'full_name', label: 'Officer',
      render: r => <NameCell name={r.full_name} />,
    },
    {
      key: 'actual_loans', label: 'Loans',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: metricColor(r.actual_loans, r.target_loans) }}>
            {r.actual_loans} / {fmtCountTarget(r.target_loans)}
          </div>
          <RagBar actual={r.actual_loans} target={r.target_loans} />
        </div>
      ),
    },
    {
      key: 'actual_kobo', label: 'Disbursement',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: metricColor(r.actual_kobo, r.target_kobo) }}>
            {fmtNaira(r.actual_kobo)} / {fmtNairaTarget(r.target_kobo)}
          </div>
          <RagBar actual={r.actual_kobo} target={r.target_kobo} />
        </div>
      ),
    },
    {
      key: 'actual_fds', label: 'Fixed Deposits',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: metricColor(r.actual_fds, r.target_fds) }}>
            {r.actual_fds} / {fmtCountTarget(r.target_fds)}
          </div>
          <RagBar actual={r.actual_fds} target={r.target_fds} />
        </div>
      ),
    },
    {
      key: 'actual_fd_kobo', label: 'FD Amount',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: metricColor(r.actual_fd_kobo, r.target_fd_kobo) }}>
            {fmtNaira(r.actual_fd_kobo)} / {fmtNairaTarget(r.target_fd_kobo)}
          </div>
          <RagBar actual={r.actual_fd_kobo} target={r.target_fd_kobo} />
        </div>
      ),
    },
    {
      key: 'actual_cards', label: 'Cards',
      render: r => (
        <div>
          {cardsMeasurable ? (
            <>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: metricColor(r.actual_cards, r.target_cards) }}>
                {r.actual_cards} / {fmtCountTarget(r.target_cards)}
              </div>
              <RagBar actual={r.actual_cards} target={r.target_cards} />
            </>
          ) : (
            // Not scored. A dash with the reason on hover, rather than a zero that reads
            // as "sold none" — see CARDS_UNMEASURABLE_NOTE.
            <div title={CARDS_UNMEASURABLE_NOTE}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.sm, color: 'var(--txt3)' }}>
              <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 14 }}>help</span>
              Not tracked
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'commission_kobo', label: 'Commission', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtNaira(Number(r.commission_kobo ?? 0))}</span>,
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
      loading={loading && actuals.length === 0}
      skeletonKpis={5}
      title="Sales Targets"
      subtitle={`Performance vs targets: ${period}`}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* One filter only: targets are MONTHLY (keyed on period), so a month picker is
              the correct control. A from/to range used to sit here too and silently broke
              past-period actuals (it defaulted to the current month, filtering them to
              zero). Commission-rate SETTING now lives under Finance, not here. */}
          <label style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.medium }}>Period</label>
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: INTER }} />
          {canEdit && (
            <button onClick={() => { setFFrom(period); setFTo(period); setShowForm(true) }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              Set Target
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Said once, at the top, rather than leaving every reader to work out why a whole
          column is dashes. A head setting card targets deserves to know they cannot be
          scored yet BEFORE they set them. */}
      {!loading && !cardsMeasurable && (
        <div style={{
          marginBottom: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
          background: `${AMBER}0F`, border: `1px solid ${AMBER}33`,
          fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--txt)' }}>Card sales are not scored on this page.</strong>{' '}
          {CARDS_UNMEASURABLE_NOTE} Loans and fixed deposits are measured normally.
        </div>
      )}

      {/* Which officers have no target at all this period. A league table sorted by
          achievement puts them at the bottom looking like poor performers, when the real
          answer is that nobody set them a number. */}
      {!loading && canEdit && untargeted.length > 0 && (
        <div style={{
          marginBottom: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
          background: `${BLUE}0D`, border: `1px solid ${BLUE}33`,
          fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--txt)' }}>
            {untargeted.length} officer{untargeted.length === 1 ? ' has' : 's have'} no target for {period}.
          </strong>{' '}
          {untargeted.map(r => r.full_name).join(', ')} — they appear at the bottom of the
          table with dashes, which is a missing target and not a missing month's work.
        </div>
      )}

      {/* An officer's own number, first. Without this they have to find themselves in
          a league table sorted by performance — which is exactly the row they are
          least motivated to scroll to when they are behind. */}
      {!canEdit && myRow && (
        <div style={{ background: 'var(--card)', border: `1px solid ${BLUE}33`, borderLeft: `3px solid ${BLUE}`, borderRadius: RADIUS.xl, padding: '16px 18px', marginBottom: SP[5] }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>
            My Target: {period}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {myRow.actual_loans} / {fmtCountTarget(Number(myRow.target_loans))} loans
              </div>
              <RagBar actual={Number(myRow.actual_loans)} target={Number(myRow.target_loans)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {fmtNaira(Number(myRow.actual_kobo))} / {fmtNairaTarget(Number(myRow.target_kobo))}
              </div>
              <RagBar actual={Number(myRow.actual_kobo)} target={Number(myRow.target_kobo)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {myRow.actual_fds} / {fmtCountTarget(Number(myRow.target_fds))} FDs
              </div>
              <RagBar actual={Number(myRow.actual_fds)} target={Number(myRow.target_fds)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {fmtNaira(Number(myRow.actual_fd_kobo))} / {fmtNairaTarget(Number(myRow.target_fd_kobo))}
              </div>
              <RagBar actual={Number(myRow.actual_fd_kobo)} target={Number(myRow.target_fd_kobo)} />
            </div>
            <div>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, marginBottom: 6 }}>
                {cardsMeasurable
                  ? `${myRow.actual_cards} / ${fmtCountTarget(Number(myRow.target_cards))} cards`
                  : 'Cards — not tracked'}
              </div>
              {cardsMeasurable
                ? <RagBar actual={Number(myRow.actual_cards)} target={Number(myRow.target_cards)} />
                : <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.4 }}>{CARDS_UNMEASURABLE_NOTE}</div>}
            </div>
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Commission Earned This Month</span>
            <span style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: GREEN, ...NUM }}>{fmtNaira(Number(myRow.commission_kobo ?? 0))}</span>
          </div>
        </div>
      )}
      {!canEdit && !loading && !myRow && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 18px', marginBottom: SP[5], fontSize: TEXT.base, color: 'var(--txt2)' }}>
          No target has been set for you for {period}. Your team lead sets these.
        </div>
      )}

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14, marginBottom: SP[5] }}>
        {[
          { label: 'Target Loans',    value: totalTargetLoans,              fmt: fmtCountTarget },
          { label: 'Actual Loans',    value: totalActualLoans,              fmt: (v: number) => v.toLocaleString(),      color: metricColor(totalActualLoans, totalTargetLoans) },
          { label: 'Target Disb.',    value: totalTargetKobo,               fmt: fmtNairaTarget },
          { label: 'Actual Disb.',    value: totalActualKobo,               fmt: fmtNaira,                               color: metricColor(totalActualKobo, totalTargetKobo) },
          { label: 'Target FDs',      value: totalTargetFds,                fmt: fmtCountTarget },
          { label: 'Actual FDs',      value: totalActualFds,                fmt: (v: number) => v.toLocaleString(),      color: metricColor(totalActualFds, totalTargetFds) },
          { label: 'Target FD Amt.',  value: totalTargetFdKobo,             fmt: fmtNairaTarget },
          { label: 'Actual FD Amt.',  value: totalActualFdKobo,             fmt: fmtNaira,                               color: metricColor(totalActualFdKobo, totalTargetFdKobo) },
          { label: 'Target Cards',    value: totalTargetCards,              fmt: fmtCountTarget },
          { label: 'Actual Cards',    value: totalActualCards,              fmt: (v: number) => v.toLocaleString(),      color: metricColor(totalActualCards, totalTargetCards) },
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
        <SectionCard title="Leaderboard" subtitle={`Team commission this period: ${fmtNaira(totalCommission)}`} badge={leaderboard.length} padding={false}>
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
          />
        </SectionCard>
      )}

      {/* Set Target modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title="Set Sales Target" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving || !fUserId || formMonths.length === 0}
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
            <SelectMenu value={fUserId} onChange={setFUserId}
              options={users.map(u => ({ value: String(u.id), label: u.full_name }))}
              placeholder="Choose an officer…" ariaLabel="Officer to set a target for"
              leadingIcon="badge" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {[
              { label: 'From Month', value: fFrom, set: setFFrom },
              { label: 'To Month',   value: fTo,   set: setFTo },
            ].map(({ label, value, set }) => (
              <div key={label} style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
                <input type="month" value={value} onChange={e => set(e.target.value)}
                  style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: -8, fontSize: TEXT.xs, color: formMonths.length ? 'var(--txt3)' : RED }}>
            {formMonths.length
              ? `Writes ${formMonths.length} monthly row${formMonths.length > 1 ? 's' : ''}, ${formMonths[0]} to ${formMonths[formMonths.length - 1]}. The same figures go on every month; re-saving a range corrects it.`
              : `To must not be before From, and a range cannot exceed ${MAX_RANGE_MONTHS} months.`}
          </div>
          {/* Only disbursement value has ever actually been filled in: across 113 target
              rows and eight months, every count target is zero. So each field says what
              it is measured against — a head who cannot see where a number comes from
              reasonably leaves it blank, and four fifths of this form stayed empty. */}
          {[
            { label: 'Loan Count Target', value: fLoans, set: setFLoans, placeholder: '0',
              hint: 'Loans booked in Udara this month, credited to this officer.' },
            { label: 'Disbursement Target (₦)', value: fDisb, set: setFDisb, placeholder: '0.00',
              hint: 'Principal disbursed. The one target currently being set.' },
            { label: 'FD Count Target', value: fFds, set: setFFds, placeholder: '0',
              hint: 'Deposits commenced this month. Measured and currently unset for everyone.' },
            { label: 'FD Amount Target (₦)', value: fFdAmt, set: setFFdAmt, placeholder: '0.00',
              hint: 'Principal placed on deposit.' },
            { label: 'Card Count Target', value: fCards, set: setFCards, placeholder: '0',
              hint: cardsMeasurable
                ? 'Cards issued this month, credited to this officer.'
                : 'Cannot be scored yet — no card sale has ever been attributed to a seller. A target set here will read as “not tracked” until cards are sold through the Issuance flow.',
              warn: !cardsMeasurable },
          ].map(({ label, value, set, placeholder, hint, warn }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input type="number" value={value} onChange={e => set(e.target.value)} placeholder={placeholder}
                style={{ width: '100%', padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
              {hint && (
                <div style={{ marginTop: 4, fontSize: TEXT.xs, color: warn ? AMBER : 'var(--txt3)', lineHeight: 1.4 }}>{hint}</div>
              )}
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
