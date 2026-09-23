import { useCallback, useEffect, useMemo, useState } from 'react'
import { SectionCard, DataTable, ErrBanner, Badge, EmptyState } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete, unwrapList } from '../../lib/api'
import { fmtDate, fmtCount } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { hasPage } from '../../hooks/useAuth'

// Correcting the account officer on a Udara loan or deposit.
//
// The officer on the loan and FD books is whatever Udara's accountOfficerName says,
// crosswalked to a workspace user through app.cbs_officer_map. That attribution
// drives Top Performers, the FD book's by-officer split, deposit concentration, the
// maturity alerts and sales targets — so a wrong one misdirects commission.
//
// Until now it could not be corrected. Udara's API has no endpoint that can change an
// account officer (the officer is a field on the loan/FD account, the customer record
// carries no officer field at all, and there is no update endpoint for either), and
// editing the crosswalk is not a fix because it maps a NAME — repointing one moves
// every record that officer holds.
//
// So a correction is recorded here instead, against one account or one customer, and
// applied by app.v_loan_officer / app.v_fd_officer, which every officer-attribution
// query reads. Removing a correction restores Udara's own answer exactly; nothing is
// destroyed either way.

interface Override {
  id: number
  scope: 'loan' | 'fd' | 'party'
  scope_key: string
  officer_user_id: number
  officer_name: string | null
  udara_officer_name: string | null
  reason: string
  created_by_name: string | null
  created_at: string
  updated_at: string
  records_affected: number
}

interface HistoryRow {
  id: number
  scope: string
  scope_key: string
  from_officer_name: string | null
  to_officer_name: string | null
  reason: string | null
  changed_by_name: string | null
  changed_at: string
}

interface Officer { id: number; full_name: string; role: string; is_active: boolean }

const SCOPE_LABEL: Record<string, string> = {
  fd: 'Deposit', loan: 'Loan', party: 'Customer (All Loans & Deposits)',
}

export default function OfficerCorrections() {
  const [rows, setRows] = useState<Override[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Recording a correction is head-only server-side (RequirePages("sales")). Mirror
  // that here so a reader who cannot save is not offered a form that 403s on submit.
  const canEdit = hasPage('sales')

  const [scope, setScope] = useState<'fd' | 'loan' | 'party'>('fd')
  const [scopeKey, setScopeKey] = useState('')
  const [officerId, setOfficerId] = useState('')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [o, h, off] = await Promise.all([
        apiFetch('/api/officer-overrides/'),
        apiFetch('/api/officer-overrides/history'),
        apiFetch('/api/sales/officers'),
      ])
      setRows(unwrapList<Override>(o))
      setHistory(unwrapList<HistoryRow>(h))
      setOfficers(unwrapList<Officer>(off).filter(x => x.is_active))
    } catch (e: any) {
      setError(e?.message ?? 'Could not load officer corrections')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const canSubmit = scopeKey.trim() !== '' && officerId !== '' && reason.trim() !== '' && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await apiPost('/api/officer-overrides/', {
        scope, scope_key: scopeKey.trim(), officer_id: Number(officerId), reason: reason.trim(),
      })
      setNotice(`Correction saved. ${SCOPE_LABEL[scope]} ${scopeKey.trim()} now reports to the officer you chose, everywhere the book is read.`)
      setScopeKey(''); setOfficerId(''); setReason('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Could not save the correction')
    } finally { setBusy(false) }
  }

  async function remove(r: Override) {
    setBusy(true); setError(null); setNotice(null)
    try {
      await apiDelete(`/api/officer-overrides/${r.id}`)
      setNotice(`Correction removed. ${SCOPE_LABEL[r.scope]} ${r.scope_key} is back to the officer Udara names${r.udara_officer_name ? ` (${r.udara_officer_name})` : ''}.`)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Could not remove the correction')
    } finally { setBusy(false) }
  }

  const COLS: TableCol<Override>[] = useMemo(() => [
    {
      key: 'scope', label: 'Applies To', render: r => (
        <span>
          <Badge variant={r.scope === 'party' ? 'warning' : 'info'}>{SCOPE_LABEL[r.scope] ?? r.scope}</Badge>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', marginLeft: SP[2] }}>{r.scope_key}</span>
          {r.scope === 'party' && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 5 }}>
              {fmtCount(r.records_affected)} record{r.records_affected === 1 ? '' : 's'}
            </span>
          )}
        </span>
      ),
    },
    {
      // Both sides, always. A bare "now X" hides what was changed and makes the
      // correction impossible to sanity-check later.
      key: 'officer_name', label: 'Officer', render: r => (
        <span style={{ fontSize: TEXT.sm }}>
          <span style={{ color: 'var(--txt3)', textDecoration: 'line-through' }}>{r.udara_officer_name || 'per Udara'}</span>
          <span style={{ color: 'var(--txt3)', margin: '0 6px' }}>&rarr;</span>
          <span style={{ color: 'var(--txt)', fontWeight: FW.semibold }}>{r.officer_name || `user ${r.officer_user_id}`}</span>
        </span>
      ),
    },
    { key: 'reason', label: 'Reason', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.reason}</span> },
    {
      key: 'created_by_name', label: 'Set By', render: r => (
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
          {r.created_by_name || 'Unknown'}<br />
          <span style={{ color: 'var(--txt3)' }}>{fmtDate(r.updated_at)}</span>
        </span>
      ),
    },
    {
      key: 'id', label: '', align: 'right', render: r => (
        canEdit ? (
          <button onClick={() => remove(r)} disabled={busy} style={{
            padding: '4px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold,
            cursor: busy ? 'default' : 'pointer',
          }}>Revert to Udara</button>
        ) : null
      ),
    },
  ], [busy, canEdit])

  const HIST_COLS: TableCol<HistoryRow>[] = useMemo(() => [
    { key: 'changed_at', label: 'When', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDate(r.changed_at)}</span> },
    {
      key: 'scope_key', label: 'Applies To', render: r => (
        <span style={{ fontSize: TEXT.sm }}>{SCOPE_LABEL[r.scope] ?? r.scope} {r.scope_key}</span>
      ),
    },
    {
      key: 'to_officer_name', label: 'Change', render: r => (
        <span style={{ fontSize: TEXT.sm }}>
          <span style={{ color: 'var(--txt3)' }}>{r.from_officer_name || 'per Udara'}</span>
          <span style={{ color: 'var(--txt3)', margin: '0 6px' }}>&rarr;</span>
          <span style={{ color: r.to_officer_name ? 'var(--txt)' : AMBER, fontWeight: FW.semibold }}>
            {r.to_officer_name || 'reverted to Udara'}
          </span>
        </span>
      ),
    },
    { key: 'changed_by_name', label: 'By', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.changed_by_name || 'Unknown'}</span> },
    { key: 'reason', label: 'Reason', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.reason || '—'}</span> },
  ], [])

  const inputStyle = {
    height: 34, padding: '0 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)',
    background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, width: '100%',
  } as const

  return (
    <>
      <ErrBanner error={error} onRetry={load} />
      {notice && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: SP[3], marginBottom: SP[4],
          borderRadius: RADIUS.md, border: `1px solid ${GREEN}`, background: 'rgba(22,163,74,.07)',
          fontSize: TEXT.sm, color: 'var(--txt)',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17, color: GREEN }}>check_circle</span>
          <span>{notice}</span>
        </div>
      )}

      {canEdit && <SectionCard
        title="Correct an Account Officer"
        subtitle="Udara has no way to change the officer on a loan or deposit, so the correction is recorded here and applied everywhere the book is read"
        style={{ marginBottom: SP[4] }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 1fr', gap: SP[3], alignItems: 'end' }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>Applies To</span>
            <select value={scope} onChange={e => setScope(e.target.value as any)} style={inputStyle}>
              <option value="fd">One Deposit</option>
              <option value="loan">One Loan</option>
              <option value="party">A Whole Customer</option>
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>
              {scope === 'party' ? 'Customer ID (party)' : 'Account Number'}
            </span>
            <input value={scopeKey} onChange={e => setScopeKey(e.target.value)} style={inputStyle}
              placeholder={scope === 'party' ? 'e.g. 7283' : 'e.g. 301000005114'} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>Correct Officer</span>
            <select value={officerId} onChange={e => setOfficerId(e.target.value)} style={inputStyle}>
              <option value="">Choose an officer…</option>
              {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: SP[3], alignItems: 'end', marginTop: SP[3] }}>
          <label style={{ display: 'block' }}>
            {/* Required by the API, not just the form: this moves commission, and
                "who changed it and why" has to be answerable a year later. */}
            <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 4 }}>
              Reason (required — this changes who is credited with the business)
            </span>
            <input value={reason} onChange={e => setReason(e.target.value)} style={inputStyle}
              placeholder="e.g. Booked under the wrong officer at onboarding; confirmed with the branch" />
          </label>
          <button onClick={submit} disabled={!canSubmit} style={{
            height: 34, borderRadius: RADIUS.md, border: 'none',
            background: canSubmit ? NAVY : 'var(--bdr)', color: canSubmit ? '#fff' : 'var(--txt3)',
            fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: canSubmit ? 'pointer' : 'default',
          }}>{busy ? 'Saving…' : 'Save Correction'}</button>
        </div>
      </SectionCard>}

      <SectionCard title="Corrections in Force" subtitle="Removing one restores the officer Udara names" padding={false} style={{ marginBottom: SP[4] }}>
        {!loading && rows.length === 0 ? (
          <EmptyState icon="how_to_reg" title="No corrections recorded"
            description="Every loan and deposit is currently attributed to the officer Udara names on the record." />
        ) : (
          <DataTable cols={COLS} rows={rows} keyFn={r => r.id} loading={loading} emptyText="No corrections recorded" />
        )}
      </SectionCard>

      <SectionCard title="Correction History" subtitle="Every change and reversal, most recent first" padding={false}>
        <DataTable cols={HIST_COLS} rows={history} keyFn={r => r.id} loading={loading}
          emptyText="No corrections have been made yet" pageSize={10} />
      </SectionCard>
    </>
  )
}
