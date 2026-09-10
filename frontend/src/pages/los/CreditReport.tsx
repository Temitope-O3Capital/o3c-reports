import { type ReactNode, type CSSProperties } from 'react'
import { SectionCard } from '../../components/UI'
import { fmtKobo, fmtDate, fmtDatetime, fmtNum } from '../../lib/fmt'
import { TEXT, FW, RADIUS, NAVY, GREEN, AMBER, RED, NUM } from '../../lib/design'

// Renders Phoenix's PrequalificationReport verbatim — the same field set Phoenix's report
// endpoint serves. Kept faithful to Phoenix's units: *_minor / *_kobo are kobo,
// income_variance_pct is a raw ratio, probability_of_default / *_rate /
// credit_utilization are 0–1 fractions. Loading and the collapsed headline live in
// PrequalSection; this is the expanded body.

type AnyObj = Record<string, any>
export interface ReportResp {
  source?: string
  updated_at?: string
  // true when read from Phoenix just now; false for the stored copy.
  live?: boolean
  // Why the stored copy is showing instead of the live report, when it is.
  stale_reason?: string
  report: AnyObj | null
}

const money   = (k: any) => (k === null || k === undefined || k === '') ? '—' : fmtKobo(Number(k))
const pct01   = (v: any) => (v === null || v === undefined || v === '') ? '—' : `${(Number(v) * 100).toFixed(1)}%`
const num     = (v: any) => (v === null || v === undefined || v === '') ? '—' : fmtNum(Number(v))
const dt      = (v: any) => v ? fmtDate(v) : '—'
const yn      = (v: any) => v === true ? 'Yes' : v === false ? 'No' : '—'
const txt     = (v: any) => (v === null || v === undefined || v === '') ? '—' : String(v)
const pretty  = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const anyVal  = (v: any) => typeof v === 'boolean' ? yn(v) : typeof v === 'number' ? num(v)
  : v !== null && typeof v === 'object' ? JSON.stringify(v) : txt(v)

// A labelled key/value grid.
function KV({ rows, cols = 3 }: { rows: [string, ReactNode][]; cols?: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: 14 }}>
      {rows.map(([label, value], i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
          <span style={{ ...NUM, fontSize: 13.5, fontWeight: 600, color: 'var(--txt)', wordBreak: 'break-word' }}>{value}</span>
        </div>
      ))}
    </div>
  )
}

// A scrollable table for a nested array of objects (bureau facilities, inquiries, etc.).
function ArrTable({ rows }: { rows: AnyObj[] }) {
  if (!rows?.length) return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>None</span>
  const set = new Set<string>()
  rows.forEach(r => Object.keys(r ?? {}).forEach(k => set.add(k)))
  const cols = Array.from(set)
  const cell = (v: any) => (v === null || v === undefined) ? '—' : (typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? yn(v) : String(v))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>{cols.map(c => <th key={c} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--bdr)', color: 'var(--txt2)', fontWeight: 600, whiteSpace: 'nowrap' }}>{pretty(c)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map(c => <td key={c} style={{ padding: '6px 10px', borderBottom: '1px solid var(--bdr)', color: 'var(--txt)', whiteSpace: 'nowrap', ...NUM }}>{cell(r?.[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ROUTE_COLOR: Record<string, string> = { APPROVE: GREEN, DECLINE: RED, REFER: AMBER, REQUEST_MORE_INFORMATION: AMBER, ERROR: RED }
const KYC_COLOR: Record<string, string> = { PASSED: GREEN, FAILED: RED, REVIEW: AMBER, PENDING: AMBER, NOT_STARTED: '#6B7280' }

function Pill({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS.full, background: `${color}1A`, color }}>{text}</span>
}

// Bureau summary map (CRC) — known nested arrays rendered as tables, the rest as a
// scalar grid, so nothing Phoenix sent is hidden.
const BUREAU_ARRAYS = ['facilities', 'inquiry_history', 'contact_history', 'performance_summary', 'litigation_details', 'dishonored_cheque_details', 'address_history', 'reason_codes']
const BUREAU_PCT01 = new Set(['credit_utilization', 'payment_history_rate'])

function BureauSummary({ b }: { b: AnyObj }) {
  if (!b || b.has_report === false) return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No bureau report on file.</span>
  const scalarKeys = Object.keys(b).filter(k => !BUREAU_ARRAYS.includes(k) && typeof b[k] !== 'object')
  const fmtScalar = (k: string, v: any) => BUREAU_PCT01.has(k) ? pct01(v) : typeof v === 'boolean' ? yn(v) : typeof v === 'number' ? num(v) : txt(v)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <KV cols={4} rows={scalarKeys.map(k => [pretty(k), fmtScalar(k, b[k])])} />
      {Array.isArray(b.reason_codes) && b.reason_codes.length > 0 && (
        <div><div style={sub}>Reason codes</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{b.reason_codes.map((c: string, i: number) => <span key={i} style={chip}>{c}</span>)}</div></div>
      )}
      {Array.isArray(b.address_history) && b.address_history.length > 0 && (
        <div><div style={sub}>Address history</div>{b.address_history.map((a: string, i: number) => <div key={i} style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{a}</div>)}</div>
      )}
      {['facilities', 'inquiry_history', 'contact_history', 'performance_summary', 'litigation_details', 'dishonored_cheque_details'].map(key =>
        Array.isArray(b[key]) && b[key].length > 0 ? (
          <div key={key}><div style={sub}>{pretty(key)} ({b[key].length})</div><ArrTable rows={b[key]} /></div>
        ) : null,
      )}
    </div>
  )
}

const sub: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 8 }
const chip: CSSProperties = { fontSize: 11.5, fontWeight: 500, padding: '3px 9px', borderRadius: 6, background: 'var(--chip-bg)', color: 'var(--txt2)' }

// Every field the sections below place. Anything else Phoenix sends lands in "Other
// fields" rather than being dropped — a field Phoenix adds reaches the page the day it
// ships, instead of the day someone notices it is missing.
const PLACED = new Set([
  'application_reference', 'recommended_route', 'currency', 'generated_at', 'recommended_amount_minor',
  'recommended_limit_minor', 'policy_version', 'decision_trace', 'credit_score', 'risk_band',
  'probability_of_default', 'max_loan_amount_minor', 'hard_gate_triggered', 'hard_gate_reason', 'scored_at',
  'risk_flags', 'customer_name', 'kyc_status', 'customer_id', 'credit_request_id', 'employer_name',
  'stated_monthly_income_minor', 'pay_frequency', 'income_variance_pct', 'income_mismatch_flag',
  'statement_on_file', 'verified_monthly_income_minor', 'avg_monthly_inflow_minor', 'avg_monthly_outflow_minor',
  'disposable_income_minor', 'closing_balance_minor', 'aggregate_source', 'gsi_debit_detected',
  'gsi_debit_total_minor', 'bureau_checked', 'bureau_fetched_at', 'bureau_summary',
])

export function CreditReportBody({ data }: { data: ReportResp }) {
  const r: AnyObj = data.report ?? {}
  const route = String(r.recommended_route ?? '')
  const kyc = String(r.kyc_status ?? 'NOT_STARTED')
  const extra = Object.keys(r).filter(k => !PLACED.has(k) && !k.startsWith('$'))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', background: `${NAVY}0A`, borderRadius: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>Phoenix Credit Report</span>
        {r.application_reference && <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{r.application_reference}</span>}
        {route && <Pill text={pretty(route)} color={ROUTE_COLOR[route] ?? '#6B7280'} />}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--txt3)' }}>
          {r.currency ?? 'NGN'} · generated {r.generated_at ? fmtDatetime(r.generated_at) : '—'}
          {data.live ? ' · live from Phoenix' : data.updated_at ? ` · stored copy of ${fmtDatetime(data.updated_at)}` : ''}
        </span>
      </div>
      {!data.live && data.stale_reason && (
        <div style={{ fontSize: 12.5, color: AMBER, lineHeight: 1.5 }}>{data.stale_reason}</div>
      )}

      {/* Recommendation / decision trace */}
      <SectionCard title="Recommendation & Decision">
        <KV cols={4} rows={[
          ['Recommended route', route ? <Pill text={pretty(route)} color={ROUTE_COLOR[route] ?? '#6B7280'} /> : '—'],
          ['Recommended amount', money(r.recommended_amount_minor)],
          ['Recommended limit', money(r.recommended_limit_minor)],
          ['Policy version', txt(r.policy_version)],
        ]} />
        {Array.isArray(r.decision_trace) && r.decision_trace.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={sub}>Decision trace</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--txt2)', lineHeight: 1.7 }}>
              {r.decision_trace.map((t: string, i: number) => <li key={i}>{t}</li>)}
            </ul>
          </div>
        )}
      </SectionCard>

      {/* Eye score */}
      <SectionCard title="Eye Score & Affordability Model">
        <KV cols={4} rows={[
          ['Credit score', <span style={{ ...NUM, fontWeight: 800, fontSize: 18, color: NAVY }}>{r.credit_score ?? '—'}</span>],
          ['Risk band', txt(r.risk_band)],
          ['Probability of default', pct01(r.probability_of_default)],
          ['Max loan amount', money(r.max_loan_amount_minor)],
          ['Hard gate', r.hard_gate_triggered ? <span style={{ color: RED, fontWeight: 700 }}>Triggered</span> : yn(r.hard_gate_triggered)],
          ['Hard gate reason', txt(r.hard_gate_reason)],
          ['Scored at', dt(r.scored_at)],
        ]} />
      </SectionCard>

      {/* Risk flags */}
      {Array.isArray(r.risk_flags) && r.risk_flags.length > 0 && (
        <SectionCard title="Risk Flags">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {r.risk_flags.map((f: string, i: number) => (
              <span key={i} style={{ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(192,0,0,.08)', color: RED }}>{f}</span>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Applicant / KYC */}
      <SectionCard title="Applicant & KYC">
        <KV rows={[
          ['Customer name', txt(r.customer_name)],
          ['KYC status', <Pill text={pretty(kyc)} color={KYC_COLOR[kyc] ?? '#6B7280'} />],
          ['Customer id', <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{txt(r.customer_id)}</span>],
          ['Credit request', <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{txt(r.credit_request_id)}</span>],
        ]} />
      </SectionCard>

      {/* Employment / stated income */}
      <SectionCard title="Employment & Stated Income">
        <KV cols={4} rows={[
          ['Employer', txt(r.employer_name)],
          ['Stated monthly income', money(r.stated_monthly_income_minor)],
          ['Pay frequency', txt(r.pay_frequency)],
          ['Income variance', r.income_variance_pct === null || r.income_variance_pct === undefined ? '—' : `${(Number(r.income_variance_pct) * 100).toFixed(1)}%`],
          ['Income mismatch', r.income_mismatch_flag ? <span style={{ color: AMBER, fontWeight: 700 }}>Yes (&gt;30%)</span> : yn(r.income_mismatch_flag)],
        ]} />
      </SectionCard>

      {/* Verified cash-flow / affordability */}
      <SectionCard title="Verified Cash-flow & Affordability">
        <KV cols={4} rows={[
          ['Statement on file', yn(r.statement_on_file)],
          ['Verified monthly income', money(r.verified_monthly_income_minor)],
          ['Avg monthly inflow', money(r.avg_monthly_inflow_minor)],
          ['Avg monthly outflow', money(r.avg_monthly_outflow_minor)],
          ['Disposable income', <span style={{ color: Number(r.disposable_income_minor) < 0 ? RED : 'var(--txt)', fontWeight: 700 }}>{money(r.disposable_income_minor)}</span>],
          ['Closing balance', money(r.closing_balance_minor)],
          ['Aggregate source', txt(r.aggregate_source)],
        ]} />
      </SectionCard>

      {/* Existing debt */}
      <SectionCard title="Existing Debt">
        <KV rows={[
          ['GSI / loan-recovery debit', r.gsi_debit_detected ? <span style={{ color: RED, fontWeight: 700 }}>Detected</span> : yn(r.gsi_debit_detected)],
          ['GSI debit total', money(r.gsi_debit_total_minor)],
        ]} />
      </SectionCard>

      {/* Bureau (CRC) */}
      <SectionCard title="Bureau (CRC)">
        <div style={{ marginBottom: 14 }}>
          <KV cols={4} rows={[
            ['Bureau checked', yn(r.bureau_checked)],
            ['Fetched at', r.bureau_fetched_at ? fmtDatetime(r.bureau_fetched_at) : '—'],
          ]} />
        </div>
        {r.bureau_summary && typeof r.bureau_summary === 'object'
          ? <BureauSummary b={r.bureau_summary} />
          : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No bureau summary.</span>}
      </SectionCard>

      {extra.length > 0 && (
        <SectionCard title="Other fields">
          <KV rows={extra.map(k => [pretty(k), anyVal(r[k])])} />
        </SectionCard>
      )}
    </div>
  )
}
