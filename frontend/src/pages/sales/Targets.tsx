import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, ErrBanner, Spinner, Modal, DataTable,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, INTER, NUM } from '../../lib/design'
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
  notes:            string
}

interface Actual {
  user_id:      number
  full_name:    string
  target_loans: number
  target_kobo:  number
  actual_loans: number
  actual_kobo:  number
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
      <div style={{ flex: 1, height: 7, background: 'var(--th-bg)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .4s' }} />
      </div>
      <span style={{ fontSize: 11.5, fontWeight: 700, color, minWidth: 32, ...NUM }}>{pct}%</span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SalesTargets() {
  const [actuals,  setActuals]  = useState<Actual[]>([])
  const [targets,  setTargets]  = useState<SalesTarget[]>([])
  const [users,    setUsers]    = useState<User[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [period,   setPeriod]   = useState(currentPeriod)
  const [showForm, setShowForm] = useState(false)
  const [saving,   setSaving]   = useState(false)

  // form state
  const [fUserId,  setFUserId]  = useState('')
  const [fLoans,   setFLoans]   = useState('')
  const [fDisb,    setFDisb]    = useState('')
  const [fNotes,   setFNotes]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [act, tgt, usr] = await Promise.all([
        apiFetch<Actual[]>(`/api/sales/targets/actuals?period=${period}`),
        apiFetch<SalesTarget[]>(`/api/sales/targets?period=${period}`),
        apiFetch<User[]>('/api/admin/users'),
      ])
      setActuals(act)
      setTargets(tgt)
      setUsers((usr as User[]).filter(u =>
        ['sales_officer','sales_head','bd_officer','bd_head'].includes(u.role)
      ))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [period])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    try {
      await apiPost('/api/sales/targets', {
        user_id:           parseInt(fUserId),
        period,
        loan_count:        parseInt(fLoans) || 0,
        disbursement_kobo: Math.round(parseFloat(fDisb) * 100) || 0,
        notes:             fNotes,
      })
      toast.success('Target saved')
      setShowForm(false); setFUserId(''); setFLoans(''); setFDisb(''); setFNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  // Merge actuals with any targets not yet in actuals
  const leaderboard: Actual[] = actuals.map(a => {
    const t = targets.find(t => t.user_id === a.user_id)
    return { ...a, target_loans: t?.loan_count ?? a.target_loans, target_kobo: t?.disbursement_kobo ?? a.target_kobo }
  })

  const totalTargetLoans = leaderboard.reduce((s, r) => s + Number(r.target_loans), 0)
  const totalActualLoans = leaderboard.reduce((s, r) => s + Number(r.actual_loans), 0)
  const totalTargetKobo  = leaderboard.reduce((s, r) => s + Number(r.target_kobo), 0)
  const totalActualKobo  = leaderboard.reduce((s, r) => s + Number(r.actual_kobo), 0)

  const COLS: TableCol<Actual>[] = [
    {
      key: 'full_name', label: 'Officer',
      render: r => <span style={{ fontWeight: 600 }}>{r.full_name}</span>,
    },
    {
      key: 'actual_loans', label: 'Loans',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: ragColor(r.target_loans > 0 ? (r.actual_loans / r.target_loans) * 100 : 100) }}>
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
          <div style={{ fontSize: 13, fontWeight: 700, color: ragColor(r.target_kobo > 0 ? (r.actual_kobo / r.target_kobo) * 100 : 100) }}>
            {fmtNaira(r.actual_kobo)} / {fmtNaira(r.target_kobo)}
          </div>
          <RagBar actual={r.actual_kobo} target={r.target_kobo} />
        </div>
      ),
    },
    {
      key: 'user_id', label: 'Rank',
      render: (_, i) => (
        <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#F59E0B' : i === 1 ? 'var(--chart-lbl)' : i === 2 ? '#C2820E' : 'var(--txt3)' }}>
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
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: INTER }} />
          <button onClick={() => setShowForm(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            Set Target
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Target Loans',    value: totalTargetLoans,              fmt: (v: number) => v.toLocaleString() },
          { label: 'Actual Loans',    value: totalActualLoans,              fmt: (v: number) => v.toLocaleString(),      color: ragColor(totalTargetLoans > 0 ? (totalActualLoans / totalTargetLoans) * 100 : 100) },
          { label: 'Target Disb.',    value: totalTargetKobo,               fmt: fmtNaira },
          { label: 'Actual Disb.',    value: totalActualKobo,               fmt: fmtNaira,                               color: ragColor(totalTargetKobo > 0 ? (totalActualKobo / totalTargetKobo) * 100 : 100) },
        ].map(({ label, value, fmt, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: color ?? 'var(--txt)', ...NUM }}>{fmt(value)}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Leaderboard" badge={leaderboard.length}>
          <DataTable
            cols={COLS}
            rows={leaderboard}
            keyFn={r => r.user_id}
            emptyText="No targets set for this period"
          />
        </SectionCard>
      )}

      {/* Set Target modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title="Set Sales Target" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}Save
            </button>
            <button onClick={() => setShowForm(false)}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Officer</label>
            <select value={fUserId} onChange={e => setFUserId(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              <option value="">— Select officer —</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </div>
          {[
            { label: 'Loan Count Target', value: fLoans, set: setFLoans, type: 'number', placeholder: '0' },
            { label: 'Disbursement Target (₦)', value: fDisb, set: setFDisb, type: 'number', placeholder: '0.00' },
          ].map(({ label, value, set, type, placeholder }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)} placeholder={placeholder}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={fNotes} onChange={e => setFNotes(e.target.value)} rows={2} placeholder="Optional notes…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
