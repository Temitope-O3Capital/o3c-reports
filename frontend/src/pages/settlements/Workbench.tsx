import { useEffect, useState, useCallback } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, Button, Modal, Field, Select,
  EmptyState, StatusBadge, Badge, Spinner,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReconRun {
  id: number
  source: string
  counterparty: string
  period_from: string
  period_to: string
  status: string
  started_at: string
  finished_at: string | null
  error: string | null
  source_n: number
  matched_n: number
  ambiguous_n: number
  unmatched_n: number
  source_value_kobo: number
  matched_value_kobo: number
  unmatched_value_kobo: number
  match_rate_pct: number
  triggered_by_name: string
  signed_off_by_name: string
  signed_off_at: string | null
  signoff_note: string
}

interface TierRow { tier: string; confidence: number; n: number; value_kobo: number }
interface ReasonRow { reason: string; status: string; n: number; value_kobo: number }

interface RunDetail {
  run: ReconRun
  tiers: TierRow[]
  exceptions: ReasonRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOURCES = [
  { value: 'interswitch', label: 'Interswitch EOD', counterparty: 'sage_ledger', cpLabel: 'Sage ledger' },
]

function rateColor(pct: number) {
  return pct >= 95 ? GREEN : pct >= 80 ? AMBER : RED
}

// Confidence is shown because a match at 0.75 is a different claim to one at 0.99,
// and an operator signing off the day is entitled to know which they are accepting.
function TierBar({ tiers, total }: { tiers: TierRow[]; total: number }) {
  if (!tiers.length) return null
  return (
    <div>
      {tiers.map(t => {
        const share = total > 0 ? (Number(t.n) / total) * 100 : 0
        const conf = Number(t.confidence)
        const color = conf >= 0.95 ? GREEN : conf >= 0.85 ? BLUEISH : AMBER
        return (
          <div key={t.tier} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>
                {t.tier}
                <Badge variant="default" style={{ marginLeft: 8 }}>conf {conf.toFixed(2)}</Badge>
              </span>
              <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                {fmtNum(t.n)} · {fmtKobo(t.value_kobo)}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${share}%`, background: color, borderRadius: 3 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

const BLUEISH = '#2563EB'

const REASON_LABEL: Record<string, string> = {
  no_candidate:    'No ledger match',
  ambiguous:       'Ambiguous — several candidates',
  amount_mismatch: 'Amount differs',
}

const tdBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.base, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
}
const thBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
  textAlign: 'left', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReconWorkbench() {
  const [runs, setRuns] = useState<ReconRun[]>([])
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [runOpen, setRunOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [source, setSource] = useState('interswitch')
  const [periodFrom, setPeriodFrom] = useState('2025-01-01')
  const [periodTo, setPeriodTo] = useState('2025-12-31')

  const [signOpen, setSignOpen] = useState(false)
  const [signNote, setSignNote] = useState('')
  const [signing, setSigning] = useState(false)

  const loadRuns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<{ data: ReconRun[] }>('/api/recon/runs?limit=50')
      const list = res.data ?? []
      setRuns(list)
      if (list.length && selectedId === null) setSelectedId(list[0].id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load runs')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => { loadRuns() }, [loadRuns])

  useEffect(() => {
    if (selectedId === null) { setDetail(null); return }
    let cancelled = false
    apiFetch<RunDetail>(`/api/recon/runs/${selectedId}`)
      .then(d => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [selectedId])

  const startRun = async () => {
    setRunning(true)
    setError(null)
    try {
      const src = SOURCES.find(s => s.value === source) ?? SOURCES[0]
      const res = await apiPost<{ run_id: number }>('/api/recon/runs', {
        source: src.value,
        counterparty: src.counterparty,
        period_from: periodFrom,
        period_to: periodTo,
      })
      setRunOpen(false)
      setSelectedId(res.run_id)
      await loadRuns()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reconciliation failed')
    } finally {
      setRunning(false)
    }
  }

  const signOff = async () => {
    if (selectedId === null) return
    setSigning(true)
    try {
      await apiPost(`/api/recon/runs/${selectedId}/signoff`, { note: signNote })
      setSignOpen(false)
      setSignNote('')
      await loadRuns()
      const d = await apiFetch<RunDetail>(`/api/recon/runs/${selectedId}`)
      setDetail(d)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sign-off failed')
    } finally {
      setSigning(false)
    }
  }

  const run = detail?.run
  const rate = run ? Number(run.match_rate_pct ?? 0) : 0

  return (
    <Page
      title="Recon Workbench"
      subtitle="Reconcile a settlement source against the ledger, then work what didn't match"
      actions={<Button icon="play_arrow" onClick={() => setRunOpen(true)}>Run reconciliation</Button>}
    >
      <ErrBanner error={error} onRetry={loadRuns} />

      {run && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[6] }}>
          <KpiCard label="Source rows" value={fmtNum(run.source_n)} sub={fmtKobo(run.source_value_kobo)} icon="table_rows" accent={NAVY} />
          <KpiCard label="Matched" value={`${rate.toFixed(1)}%`} sub={`${fmtNum(run.matched_n)} · ${fmtKobo(run.matched_value_kobo)}`} icon="check_circle" accent={rateColor(rate)} />
          <KpiCard label="Exceptions" value={fmtNum(run.unmatched_n)} sub={fmtKobo(run.unmatched_value_kobo)} icon="report" accent={RED} />
          <KpiCard label="Sign-off" value={run.signed_off_at ? 'Signed' : 'Pending'} sub={run.signed_off_at ? `${run.signed_off_by_name} · ${fmtDate(run.signed_off_at)}` : 'Not yet reviewed'} icon="task_alt" accent={run.signed_off_at ? GREEN : AMBER} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: SP[4], marginBottom: SP[6] }}>
        <SectionCard
          title="How the match was made"
          subtitle="Every pairing records the rule and confidence that produced it"
        >
          {!detail ? (
            <div style={{ padding: SP[4], color: 'var(--txt2)', fontSize: TEXT.base }}>
              {loading ? <Spinner /> : 'Select a run to see its breakdown.'}
            </div>
          ) : detail.tiers.length === 0 ? (
            <EmptyState icon="rule" title="No matches" description="This run paired nothing — check the period has source data." />
          ) : (
            <TierBar tiers={detail.tiers} total={Number(run?.matched_n ?? 0)} />
          )}
        </SectionCard>

        <SectionCard
          title="What didn't match"
          subtitle="Classified so each reason gets the right investigation"
          actions={
            run && !run.signed_off_at && run.status === 'ok'
              ? <Button variant="secondary" size="sm" icon="task_alt" onClick={() => setSignOpen(true)}>Sign off</Button>
              : undefined
          }
        >
          {!detail || detail.exceptions.length === 0 ? (
            <EmptyState icon="check_circle" title="Nothing outstanding" description="No exceptions were raised for this run." />
          ) : (
            <div>
              {detail.exceptions.map(x => (
                <div key={`${x.reason}-${x.status}`} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 0', borderBottom: '1px solid var(--bdr)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                    <span style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>
                      {REASON_LABEL[x.reason] ?? x.reason}
                    </span>
                    <StatusBadge status={x.status} size="sm" />
                  </div>
                  <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold }}>
                    {fmtNum(x.n)} · {fmtKobo(x.value_kobo)}
                  </span>
                </div>
              ))}
              <div style={{ marginTop: SP[3] }}>
                <Button variant="secondary" size="sm" icon="open_in_new"
                  onClick={() => { window.location.href = `/settlements/exceptions?run_id=${run?.id}` }}>
                  Work these exceptions
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Runs" subtitle="Each run is the auditable record of one reconciliation" padding={false}>
        {loading && !runs.length ? (
          <div style={{ padding: SP[5] }}><Spinner /></div>
        ) : runs.length === 0 ? (
          <EmptyState icon="rule_folder" title="No reconciliations yet"
            description="Run one to match a settlement source against the ledger."
            action={{ label: 'Run reconciliation', icon: 'play_arrow', onClick: () => setRunOpen(true) }} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <th style={thBase}>Run</th>
                  <th style={thBase}>Source → Counterparty</th>
                  <th style={thBase}>Period</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Rows</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Matched</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Exceptions</th>
                  <th style={thBase}>Status</th>
                  <th style={thBase}>Sign-off</th>
                  <th style={thBase}>Ran</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => {
                  const pctVal = Number(r.match_rate_pct ?? 0)
                  const sel = r.id === selectedId
                  return (
                    <tr key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      style={{
                        cursor: 'pointer',
                        background: sel ? 'var(--th-bg)' : 'var(--card)',
                      }}>
                      <td style={tdBase}><span style={{ ...NUM, color: NAVY, fontWeight: FW.semibold }}>#{r.id}</span></td>
                      <td style={tdBase}>
                        <span style={{ fontSize: TEXT.sm }}>{r.source}</span>
                        <span style={{ color: 'var(--txt3)', margin: '0 6px' }}>→</span>
                        <span style={{ fontSize: TEXT.sm }}>{r.counterparty}</span>
                      </td>
                      <td style={tdBase}>
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                          {fmtDate(r.period_from)} – {fmtDate(r.period_to)}
                        </span>
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(r.source_n)}</td>
                      <td style={{ ...tdBase, textAlign: 'right' }}>
                        <span style={{ ...NUM, fontWeight: FW.semibold, color: rateColor(pctVal) }}>
                          {pctVal.toFixed(1)}%
                        </span>
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(r.unmatched_n)}</td>
                      <td style={tdBase}><StatusBadge status={r.status} size="sm" /></td>
                      <td style={tdBase}>
                        {r.signed_off_at
                          ? <Badge variant="success" dot>{r.signed_off_by_name || 'Signed'}</Badge>
                          : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>—</span>}
                      </td>
                      <td style={tdBase}>
                        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.started_at)}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Run modal */}
      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run reconciliation" width={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunOpen(false)} disabled={running}>Cancel</Button>
            <Button icon="play_arrow" onClick={startRun} loading={running}>Run</Button>
          </>
        }>
        <Field label="Source">
          <Select value={source} onChange={e => setSource(e.target.value)}>
            {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label} → {s.cpLabel}</option>)}
          </Select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <Field label="Period from">
            <input type="date" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)' }} />
          </Field>
          <Field label="Period to">
            <input type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)' }} />
          </Field>
        </div>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3] }}>
          Matching is strictly one-to-one. Where a row has several possible ledger
          entries it is raised as an exception rather than paired on a guess.
        </p>
      </Modal>

      {/* Sign-off modal */}
      <Modal open={signOpen} onClose={() => setSignOpen(false)} title="Sign off this reconciliation" width={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSignOpen(false)} disabled={signing}>Cancel</Button>
            <Button icon="task_alt" onClick={signOff} loading={signing}>Sign off</Button>
          </>
        }>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[3] }}>
          You are recording that this position has been reviewed. {run ? fmtNum(run.unmatched_n) : 0} exception(s)
          worth {run ? fmtKobo(run.unmatched_value_kobo) : '—'} remain outstanding.
        </p>
        <Field label="Note (optional)">
          <textarea value={signNote} onChange={e => setSignNote(e.target.value)} rows={3}
            style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontFamily: 'inherit' }} />
        </Field>
      </Modal>
    </Page>
  )
}
