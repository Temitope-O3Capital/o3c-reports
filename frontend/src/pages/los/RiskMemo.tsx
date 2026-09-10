// The risk desk's credit memo, built from Phoenix's own decision.
//
// The risk page used to show the workspace's copies of four numbers — score, rating,
// DTI, a bureau note — and none of what actually decided the application. For a
// credit-card request it showed "₦0 requested", because the limit never landed in the
// amount column, and a hard-gate zero was presented as though it were a score.
// Everything an officer needs was already in the Eye payload, on another tab, in
// Phoenix's own layout. This reads that same payload and lays it out the way a credit
// officer reads a file: the verdict and why, what could stop it, whether the customer
// can afford it, what the bureau and the statement say, and what moved the score.
//
// It never invents a figure. Where Phoenix does not record a number, the memo derives
// it only from numbers Phoenix did record, and says so. Where two sources disagree,
// it shows both rather than silently choosing one.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDatetime } from '../../lib/fmt'
import type { BehavioralRisk, EyeDecisionDetail, EyeDecisionStatement, FeatureContribution } from './eye/eyeTypes'

// ── Small readers ────────────────────────────────────────────────────────────
// The payload is loosely typed in places (metadata, bureau JSON), so every read goes
// through these rather than trusting a shape.

type Obj = Record<string, unknown>
const rec = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
const pos = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n > 0 ? n : null
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const humanise = (s: string) => s.replace(/_/g, ' ')
const sentence = (s: string) => {
  const t = s.trim()
  if (!t) return t
  const c = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(c) ? c : c + '.'
}

/** A fraction as a percentage — one decimal below 10%, whole numbers above. */
export const pct = (x: number, digits?: number) => {
  const p = x * 100
  return `${p.toFixed(digits ?? (Math.abs(p) < 10 ? 1 : 0))}%`
}

// ── Fetching ─────────────────────────────────────────────────────────────────

export type EyeState = {
  detail: EyeDecisionDetail | null
  reason: string | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function useEyeDecision(appId: number): EyeState {
  const [detail, setDetail] = useState<EyeDecisionDetail | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<{ data: { decision?: EyeDecisionDetail | null; reason?: string } }>(`/api/los/${appId}/eye-decision`)
      setDetail(res.data?.decision ?? null)
      setReason(res.data?.decision ? null : (res.data?.reason ?? 'not_scored'))
    } catch (e) {
      // Not the same as "no decision". An unreachable Phoenix must not read as
      // "nothing to see", or the officer assesses without the engine's view and
      // never knows it was missing.
      setDetail(null)
      setError(e instanceof Error ? e.message : 'Could not reach Phoenix')
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => { void load() }, [load])
  return { detail, reason, error, loading, reload: () => { void load() } }
}

// ── Facts ────────────────────────────────────────────────────────────────────

export type Flag = { tone: 'stop' | 'warn' | 'info'; text: string }

export type BureauLine = {
  key: string
  label: string
  status: string
  hasReport: boolean
  score: number | null
  facilities: number | null
  active: number | null
  delinquent: number | null
  maxOverdueDays: number | null
}

export type MemoFacts = {
  outcome: string | null
  band: string | null
  score: number | null
  pd: number | null
  method: string | null
  model: string | null
  policy: string | null
  decidedAt: string | null
  reasons: string[]
  hardGate: { reason: string; label: string } | null
  requestedKobo: number | null
  requestedKind: 'limit' | 'amount' | null
  recommendedKobo: number | null
  maxLendKobo: number | null
  incomeKobo: number | null
  incomeSource: string
  incomeFromPhoenix: boolean
  declaredIncomeKobo: number | null
  obligationsKobo: number | null
  declaredObligationsKobo: number | null
  repaymentCount: number | null
  monthsOfData: number | null
  dtiPct: number | null
  dtiSource: string
  dtiExplained: boolean
  bureau: BureauLine[]
  paymentHistoryRate: number | null
  outstandingMonths: number | null
  creditAgeMonths: number | null
  identityStatus: string | null
  behavioural: BehavioralRisk | null
  statement: EyeDecisionStatement | null
  drivers: FeatureContribution[]
  featureCount: number
  flags: Flag[]
}

/** The subset of the workspace application the memo reads. */
export type AppLike = {
  amount_requested_kobo?: number | null
  monthly_income_kobo?: number | null
  monthly_obligation_kobo?: number | null
  dti_pct?: number | string | null
  eye_score?: number | null
  eye_rating?: string | null
}

const TONE_ORDER: Record<Flag['tone'], number> = { stop: 0, warn: 1, info: 2 }

export function deriveMemo(app: AppLike, eye: EyeDecisionDetail | null): MemoFacts {
  const sr = eye?.scoring_record
  const md = rec(sr?.metadata)
  const st = eye?.statement ?? null
  const S = rec(st)
  const fc = sr?.feature_contributions
  const contribs: FeatureContribution[] = Array.isArray(fc) ? fc : []
  const feat = (k: string) => contribs.find(f => f.feature === k)
  const featRaw = (k: string) => num(feat(k)?.raw_value)
  const featPts = (k: string) => feat(k)?.points ?? 0
  const ptsNote = (k: string) => {
    const p = featPts(k)
    return p ? ` (${p > 0 ? '+' : '−'}${Math.abs(p)} points)` : ''
  }

  const gateOn = sr?.hard_gate_triggered === true || md.hard_gate_triggered === true
  const gateReason = str(sr?.hard_gate_reason) || str(md.hard_gate_reason)
  const hardGate = gateOn
    ? { reason: gateReason, label: str(sr?.hard_gate_label) || str(md.hard_gate_label) || humanise(gateReason || 'hard gate') }
    : null

  // DTI — Phoenix's own figure first. The workspace row holds a copy that can lag.
  const dtiRaw = featRaw('dti')
  const appDti = num(app.dti_pct)
  const dtiPct = dtiRaw !== null ? dtiRaw * 100 : appDti
  const dtiSource = dtiRaw !== null ? 'Phoenix' : appDti !== null ? 'workspace record' : ''

  // Income — what Phoenix actually used, which for a salaried applicant is the salary
  // it predicted from the statement, not what the applicant declared.
  const phxIncome = pos(md.monthly_income_minor)
  const stSalary = pos(S.predicted_average_salary_minor)
  const declaredIncomeKobo = pos(app.monthly_income_kobo)
  const incomeKobo = phxIncome ?? stSalary ?? declaredIncomeKobo
  const incomeFromPhoenix = phxIncome !== null
  const incomeSource = phxIncome !== null
    ? (stSalary !== null && Math.abs(stSalary - phxIncome) < 100 ? 'used by Phoenix — the salary it predicted from the statement' : 'used by Phoenix')
    : stSalary !== null ? 'predicted from the statement' : declaredIncomeKobo !== null ? 'declared by the applicant' : ''

  // Existing obligations — Phoenix's DTI numerator is the loan repayments it found in
  // the statement. Phoenix does not store that figure against the decision, but the
  // statement does, so the memo can show the working and check it against Phoenix's.
  const obligationsKobo = num(S.avg_monthly_loan_repayment_minor)
  const dtiCheck = incomeKobo && obligationsKobo !== null ? obligationsKobo / incomeKobo : null
  const dtiExplained = dtiRaw !== null && dtiCheck !== null && Math.abs(dtiCheck - dtiRaw) < 0.005

  // Exposure — the workspace row, else what Phoenix recorded. A credit card asks for
  // a limit, not an amount, which is why the row alone used to read ₦0.
  const cr = rec(eye?.credit_request)
  const crAmount = pos(cr.requested_amount_minor)
  const crLimit = pos(cr.requested_limit_minor)
  const appAmount = pos(app.amount_requested_kobo)
  const requestedKobo = appAmount ?? crAmount ?? crLimit ?? pos(md.requested_amount_minor)
  const requestedKind: MemoFacts['requestedKind'] =
    crLimit !== null && crAmount === null ? 'limit' : crAmount !== null || appAmount !== null ? 'amount' : null

  const recommendedKobo = num(eye?.recommended_amount_minor) ?? num(eye?.recommended_limit_minor)
  const maxLendKobo = num(sr?.max_loan_amount_minor) ?? num(md.eligible_ceiling_minor)

  // Bureau — one column per provider Phoenix asked. Only counts, scores and rates are
  // shown: bureau money is reported in different units by different providers, and a
  // figure that might be off by a hundredfold is worse than none.
  const diags = rec(rec(md.account_summary).provider_diagnostics)
  const bj = rec(eye?.bureau_query?.bureau_json)
  const bureau: BureauLine[] = Object.keys(diags)
    .filter(k => k !== 'identity')
    .map(k => {
      const d = rec(diags[k])
      const sum = rec(rec(bj[k]).summary)
      return {
        key: k,
        label: str(d.label) || k.toUpperCase(),
        status: str(d.status) || (d.has_report === true ? 'available' : 'no report'),
        hasReport: d.has_report === true,
        score: num(d.bureau_score ?? sum.bureau_score),
        facilities: num(d.total_facilities ?? sum.total_facilities),
        active: num(d.active_facilities ?? sum.active_facilities),
        delinquent: num(d.delinquent_accounts ?? sum.delinquent_accounts),
        maxOverdueDays: num(sum.max_overdue_days),
      }
    })

  const identityStatus = str(rec(md.identity).provider_status) || str(rec(diags.identity).status) || null

  const br = rec(md.behavioral_risk)
  const behavioural: BehavioralRisk | null = typeof br.risk_level === 'string'
    ? {
      risk_score: num(br.risk_score) ?? 0,
      risk_level: br.risk_level as BehavioralRisk['risk_level'],
      triggered_rules: Array.isArray(br.triggered_rules) ? (br.triggered_rules as BehavioralRisk['triggered_rules']) : [],
      pass_through: br.pass_through === true,
    }
    : null

  const warnings = Array.from(new Set(
    [...(Array.isArray(md.warnings) ? md.warnings : []), ...(Array.isArray(S.warnings) ? S.warnings : [])]
      .filter((w): w is string => typeof w === 'string' && w.trim() !== ''),
  ))

  const paymentHistoryRate = featRaw('bureau_payment_history')
  const outstandingMonths = featRaw('bureau_total_outstanding')
  const creditAgeMonths = featRaw('bureau_credit_age')

  // ── What could stop it ──
  const flags: Flag[] = []
  if (hardGate) {
    flags.push({ tone: 'stop', text: `Hard gate: ${hardGate.label.replace(/\.$/, '')}. The application was stopped before the scorecard ran.` })
  }
  for (const b of bureau) {
    if ((b.delinquent ?? 0) > 0) flags.push({ tone: 'stop', text: `${b.label}: ${b.delinquent} delinquent account${b.delinquent === 1 ? '' : 's'}.` })
  }
  if (behavioural && (behavioural.risk_level === 'high' || behavioural.risk_level === 'critical')) {
    flags.push({ tone: 'stop', text: `Behavioural risk is ${behavioural.risk_level} (${pct(behavioural.risk_score)}).` })
  }
  const auth = num(S.auth_risk_score)
  if (auth !== null && auth >= 0.5) {
    flags.push({ tone: 'stop', text: `Statement tamper risk ${pct(auth)} — confirm the document is genuine before relying on it.` })
  }
  if (str(S.parser_method) === 'failed') {
    flags.push({
      tone: 'warn',
      text: Object.keys(rec(S.periculum)).length > 0
        ? 'Phoenix’s own parser could not read the statement; the statement figures come from Periculum.'
        : 'The statement could not be read, so there are no statement figures behind this decision.',
    })
  }
  for (const w of warnings) {
    if (!/pdf parsing failed/i.test(w)) flags.push({ tone: 'warn', text: sentence(w) })
  }
  const identityUnverified = !!identityStatus && !['verified', 'available', 'passed'].includes(identityStatus.toLowerCase())
  for (const r of behavioural?.triggered_rules ?? []) {
    // Phoenix's NO_IDENTITY rule restates the identity flag below; one line is enough.
    if (r?.code === 'NO_IDENTITY' && identityUnverified) continue
    if (r && typeof r.label === 'string') flags.push({ tone: 'warn', text: sentence(`Behavioural rule: ${r.label}`) })
  }
  if (identityStatus && identityUnverified) {
    flags.push({
      tone: 'warn',
      text: identityStatus === 'not_enabled'
        ? 'Identity not verified — no identity provider is enabled in Phoenix.'
        : sentence(`Identity check: ${humanise(identityStatus)}`),
    })
  }
  if (paymentHistoryRate !== null && paymentHistoryRate < 0.5) {
    flags.push({ tone: 'warn', text: `Bureau payment-history rate ${pct(paymentHistoryRate)}${ptsNote('bureau_payment_history')}.` })
  }
  const od = num(S.overdraft_frequency)
  if (od !== null && od >= 0.5) flags.push({ tone: 'warn', text: `Overdrawn in ${pct(od)} of the months in the statement.` })
  const disb = num(S.loan_disbursement_count)
  if (disb !== null && disb >= 10) flags.push({ tone: 'warn', text: `${disb} loan disbursements in the statement period${ptsNote('ob_loan_cycling_count')}.` })
  for (const b of bureau) {
    if (!b.hasReport && /no_hit/i.test(b.status)) flags.push({ tone: 'info', text: `${b.label}: no record found for this applicant.` })
  }
  const sav = num(S.savings_rate)
  if (sav !== null && sav < 0) flags.push({ tone: 'info', text: `Spending exceeded income over the period (savings rate ${pct(sav)}).` })
  flags.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])

  const drivers = contribs
    .filter(f => typeof f.points === 'number' && f.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))

  return {
    outcome: str(eye?.outcome) || null,
    band: str(eye?.risk_band) || str(sr?.band) || (app.eye_rating ?? null),
    score: num(sr?.score) ?? num(app.eye_score),
    pd: num(sr?.probability_of_default),
    method: str(sr?.scoring_method) || null,
    model: str(sr?.model_version) || null,
    policy: str(eye?.policy_version) || null,
    decidedAt: str(eye?.created_at) || null,
    reasons: Array.isArray(eye?.reasons) ? eye.reasons.filter(r => typeof r === 'string') : [],
    hardGate,
    requestedKobo,
    requestedKind,
    recommendedKobo,
    maxLendKobo,
    incomeKobo,
    incomeSource,
    incomeFromPhoenix,
    declaredIncomeKobo,
    obligationsKobo,
    declaredObligationsKobo: pos(app.monthly_obligation_kobo),
    repaymentCount: num(S.loan_repayment_count),
    monthsOfData: num(S.months_of_data),
    dtiPct,
    dtiSource,
    dtiExplained,
    bureau,
    paymentHistoryRate,
    outstandingMonths,
    creditAgeMonths,
    identityStatus,
    behavioural,
    statement: st,
    drivers,
    featureCount: contribs.length,
    flags,
  }
}

// ── Shared markup ────────────────────────────────────────────────────────────
// Same classes as the rest of the page, so the memo reads as part of it.

function Panel({ title, hint, flush = false, children }: {
  title: string; hint?: ReactNode; flush?: boolean; children: ReactNode
}) {
  return (
    <div className="sd-panel">
      <div className="sd-panel-head">
        <h2>{title}</h2>
        {hint ? <span className="sd-panel-hint">{hint}</span> : null}
      </div>
      {flush ? children : <div className="sd-panel-body">{children}</div>}
    </div>
  )
}

function Field({ label, value, mono = false, wide = false }: {
  label: string; value: ReactNode; mono?: boolean; wide?: boolean
}) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className={`sd-field${wide ? ' is-wide' : ''}`}>
      <label>{label}</label>
      <div className={`sd-val${mono ? ' is-mono' : ''}${empty ? ' is-empty' : ''}`}>{empty ? 'Not recorded' : value}</div>
    </div>
  )
}

// ── Verdict ──────────────────────────────────────────────────────────────────

const OUTCOME: Record<string, { label: string; tone: 'red' | 'green' | 'amber' }> = {
  APPROVE: { label: 'approve', tone: 'green' },
  DECLINE: { label: 'decline', tone: 'red' },
  REFER: { label: 'refer to a person', tone: 'amber' },
  REQUEST_MORE_INFORMATION: { label: 'ask for more information', tone: 'amber' },
  ERROR: { label: 'no decision — the engine errored', tone: 'amber' },
}
const TONE_VAR = { red: 'var(--sd-red)', green: 'var(--sd-green)', amber: 'var(--sd-amber)' }

export function DecisionSummary({ facts }: { facts: MemoFacts }) {
  const o = OUTCOME[(facts.outcome ?? '').toUpperCase()]
    ?? { label: humanise((facts.outcome ?? 'no decision').toLowerCase()), tone: 'amber' as const }
  const body = facts.hardGate
    ? <>Stopped by a hard gate before scoring: <b>{facts.hardGate.label.replace(/\.$/, '')}</b>. The score of {facts.score ?? 0} is the gate’s result, not the scorecard’s.</>
    : facts.reasons.length ? facts.reasons.join(' · ') : 'Phoenix gave no reason with this decision.'
  return (
    <div className="sd-panel">
      <div className="sd-verdict">
        <div className="sd-verdict-mark" style={{ background: TONE_VAR[o.tone] }} aria-hidden="true">{facts.band ?? '—'}</div>
        <div style={{ minWidth: 0 }}>
          <div className="sd-verdict-title">Phoenix recommends: {o.label}</div>
          <div className="sd-verdict-body">{body}</div>
          <div className="sd-chips">
            {facts.band && <span className="sd-chip">band {facts.band}</span>}
            {facts.score !== null && <span className="sd-chip">score {facts.score}</span>}
            {facts.pd !== null && <span className="sd-chip">default probability {pct(facts.pd)}</span>}
            {facts.method && <span className="sd-chip">{humanise(facts.method)}</span>}
            {facts.model && <span className="sd-chip">{facts.model}</span>}
          </div>
        </div>
        <div className="sd-verdict-meta">
          {facts.decidedAt && <span className="sd-tagline">decided {fmtDatetime(facts.decidedAt)}</span>}
          {facts.policy && <span className="sd-tagline">{facts.policy}</span>}
          {facts.requestedKobo !== null && (
            <span className="sd-tagline">
              {facts.recommendedKobo !== null ? <>recommends {fmtKobo(facts.recommendedKobo)} of </> : 'requested '}
              {fmtKobo(facts.requestedKobo)}{facts.requestedKind === 'limit' ? ' limit' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── What could stop it ───────────────────────────────────────────────────────

const FLAG_ICON: Record<Flag['tone'], string> = { stop: 'block', warn: 'warning', info: 'info' }

export function FlagList({ flags }: { flags: Flag[] }) {
  const stops = flags.filter(f => f.tone === 'stop').length
  return (
    <Panel title="What could stop it" hint={stops ? `${stops} blocking · ${flags.length - stops} to note` : `${flags.length} to note`} flush>
      <ul className="sd-flags">
        {flags.map((f, i) => (
          <li key={i} className={`sd-flag is-${f.tone}`}>
            <span className="material-symbols-rounded" aria-hidden="true">{FLAG_ICON[f.tone]}</span>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ── Affordability ────────────────────────────────────────────────────────────

export function AffordabilityPanel({ facts }: { facts: MemoFacts }) {
  const rows: { k: string; v: ReactNode; note?: ReactNode; total?: boolean; color?: string }[] = []
  rows.push({
    k: 'Monthly income',
    v: facts.incomeKobo !== null ? fmtKobo(facts.incomeKobo) : '—',
    note: facts.incomeSource || 'not recorded',
  })
  if (facts.declaredIncomeKobo !== null && facts.incomeKobo !== null && Math.abs(facts.declaredIncomeKobo - facts.incomeKobo) >= 100) {
    rows.push({ k: 'Declared income', v: fmtKobo(facts.declaredIncomeKobo), note: 'what the applicant told us — not the figure Phoenix used' })
  }
  if (facts.obligationsKobo !== null) {
    rows.push({
      k: 'Existing loan repayments',
      v: `${fmtKobo(facts.obligationsKobo)} / mo`,
      note: facts.repaymentCount !== null && facts.monthsOfData
        ? `average of ${facts.repaymentCount} repayments over ${facts.monthsOfData} months of statement`
        : 'average per month, found in the statement',
    })
  }
  if (facts.declaredObligationsKobo !== null) {
    rows.push({ k: 'Declared obligations', v: `${fmtKobo(facts.declaredObligationsKobo)} / mo`, note: 'from the application form' })
  }
  const dti = facts.dtiPct
  rows.push({
    k: 'Debt-to-income',
    v: dti !== null ? `${dti.toFixed(1)}%` : '—',
    total: true,
    color: dti === null ? undefined : dti > 50 ? 'var(--sd-red)' : dti > 33 ? 'var(--sd-amber)' : undefined,
    note: facts.dtiExplained
      ? 'existing repayments ÷ income — this matches Phoenix’s figure'
      : facts.dtiSource ? `from the ${facts.dtiSource}` : 'not assessed',
  })
  rows.push({
    k: 'Exposure requested',
    v: facts.requestedKobo !== null ? fmtKobo(facts.requestedKobo) : '—',
    note: facts.requestedKind === 'limit' ? 'a credit limit' : facts.requestedKind === 'amount' ? 'a loan amount' : undefined,
  })
  if (facts.maxLendKobo !== null) {
    rows.push({
      k: 'Phoenix would lend up to',
      v: fmtKobo(facts.maxLendKobo),
      note: facts.maxLendKobo === 0 && facts.hardGate ? 'nothing — the hard gate applies' : 'the affordability ceiling from the scorecard',
    })
  }
  return (
    <Panel title="Affordability" hint={facts.dtiExplained ? 'working shown' : undefined} flush>
      <table className="sd-kv">
        <tbody>
          {rows.map(r => (
            <tr key={r.k} className={r.total ? 'is-total' : undefined}>
              <th scope="row">{r.k}{r.note ? <small>{r.note}</small> : null}</th>
              <td style={r.color ? { color: r.color } : undefined}>{r.v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Bureau ───────────────────────────────────────────────────────────────────

export function BureauPanel({ facts }: { facts: MemoFacts }) {
  const cols = facts.bureau
  const n = (v: number | null) => (v === null ? '—' : v)
  const reported = cols.filter(b => b.hasReport).map(b => b.label)
  return (
    <Panel title="Bureau" hint={reported.length ? `${reported.join(' · ')} reported` : 'no report'} flush>
      {cols.length === 0 ? (
        <div className="sd-panel-body"><div className="sd-note">No bureau result was attached to this decision.</div></div>
      ) : (
        <div className="sd-kv-wrap">
          <table className="sd-kv sd-kv-cols">
            <thead>
              <tr>
                <th scope="col" aria-label="Measure" />
                {cols.map(b => <th key={b.key} scope="col">{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {([
                ['Status', (b: BureauLine) => humanise(b.status)],
                ['Bureau score', (b: BureauLine) => n(b.score)],
                ['Facilities', (b: BureauLine) => n(b.facilities)],
                ['Active', (b: BureauLine) => n(b.active)],
                ['Delinquent', (b: BureauLine) => (b.delinquent ? <span style={{ color: 'var(--sd-red)' }}>{b.delinquent}</span> : n(b.delinquent))],
                ['Worst overdue', (b: BureauLine) => (b.maxOverdueDays === null ? '—' : `${b.maxOverdueDays} days`)],
              ] as const).map(([label, get]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {cols.map(b => <td key={b.key}>{get(b)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sd-panel-body">
        <div className="sd-fields">
          <Field label="Payment-history rate" value={facts.paymentHistoryRate === null ? null : pct(facts.paymentHistoryRate)} mono />
          <Field label="Outstanding debt" value={facts.outstandingMonths === null ? null : `${facts.outstandingMonths.toFixed(1)}× monthly income`} mono />
          <Field label="Credit history" value={facts.creditAgeMonths === null ? null : `${facts.creditAgeMonths} months`} mono />
          <Field label="Identity check" value={facts.identityStatus ? humanise(facts.identityStatus) : null} />
        </div>
      </div>
    </Panel>
  )
}

// ── Statement ────────────────────────────────────────────────────────────────

export function StatementPanel({ facts }: { facts: MemoFacts }) {
  const st = facts.statement
  if (!st) {
    return <Panel title="Statement"><div className="sd-note">No bank statement was attached to this decision.</div></Panel>
  }
  const S = rec(st)
  const failed = str(S.parser_method) === 'failed'
  const viaPericulum = Object.keys(rec(S.periculum)).length > 0
  const money = (k: string) => { const v = num(S[k]); return v === null ? null : fmtKobo(v) }
  const ratio = (k: string) => { const v = num(S[k]); return v === null ? null : pct(v) }
  const conf = num(S.confidence)
  const readBy = failed
    ? (viaPericulum ? 'Periculum — Phoenix’s parser failed' : 'nothing — the parser failed')
    : `Phoenix parser${str(S.parser_method) ? ` (${humanise(str(S.parser_method))}` : ' ('}${conf !== null ? `, ${pct(conf)} confidence)` : ')'}`
  const salaryCount = num(S.salary_payment_count)
  const period = str(S.period_start) && str(S.period_end) ? `${str(S.period_start)} to ${str(S.period_end)}` : undefined
  return (
    <Panel title="Statement" hint={period}>
      <div className="sd-fields">
        <Field label="Read by" value={readBy} wide />
        <Field label="Months of data" value={num(S.months_of_data)} mono />
        <Field label="Predicted salary" value={money('predicted_average_salary_minor')} mono />
        <Field label="Avg monthly credits" value={money('avg_monthly_credits_minor')} mono />
        <Field label="Avg monthly debits" value={money('avg_monthly_debits_minor')} mono />
        <Field label="Closing balance" value={money('closing_balance_minor')} mono />
        <Field label="Payroll" value={S.payroll_detected === true ? `detected${salaryCount ? ` · ${salaryCount} payments` : ''}` : S.payroll_detected === false ? 'not detected' : null} />
        <Field label="Overdrawn months" value={ratio('overdraft_frequency')} mono />
        <Field label="Savings rate" value={ratio('savings_rate')} mono />
        <Field label="Loan disbursements" value={num(S.loan_disbursement_count)} mono />
        <Field label="Bounces per month" value={num(S.bounce_count_per_month)} mono />
        <Field label="Gambling" value={ratio('gambling_ratio')} mono />
      </div>
    </Panel>
  )
}

// ── What moved the score ─────────────────────────────────────────────────────

export function DriversPanel({ facts }: { facts: MemoFacts }) {
  const top = facts.drivers.slice(0, 10)
  if (!top.length) {
    return <Panel title="What moved the score"><div className="sd-note">Phoenix recorded no feature contributions for this score.</div></Panel>
  }
  const max = Math.max(...top.map(d => Math.abs(d.points)), 1)
  return (
    <Panel title="What moved the score" hint={`${facts.drivers.length} of ${facts.featureCount} features counted`} flush>
      {facts.hardGate && (
        <div className="sd-note is-warn" style={{ margin: '12px 18px 0' }}>
          <span className="material-symbols-rounded" aria-hidden="true">info</span>
          <span>Shown for context. A hard gate stops the application whatever these add up to.</span>
        </div>
      )}
      <div className="sd-drivers" role="list">
        {top.map(d => {
          const neg = d.points < 0
          return (
            <div key={d.feature ?? d.label} className="sd-driver" role="listitem">
              <span className="sd-driver-lbl">{d.label}{d.value && d.value !== '—' ? <small>{d.value}</small> : null}</span>
              <span className="sd-driver-track" aria-hidden="true">
                <span className={`sd-driver-bar ${neg ? 'is-neg' : 'is-pos'}`} style={{ width: `${(Math.abs(d.points) / max) * 50}%` }} />
              </span>
              <span className={`sd-driver-pts ${neg ? 'is-neg' : 'is-pos'}`}>{neg ? '−' : '+'}{Math.abs(d.points)}</span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ── When there is no engine decision ─────────────────────────────────────────

export function EyeUnavailable({ state }: { state: EyeState }) {
  if (state.detail) return null
  const [icon, title, body] = state.loading
    ? ['hourglass_top', 'Reading Phoenix’s decision…', 'The engine’s view loads alongside the file.']
    : state.error
      ? ['cloud_off', 'Could not reach Phoenix', `${state.error}. The figures below are the workspace’s own record, not the engine’s.`]
      : state.reason === 'not_submitted'
        ? ['do_not_disturb_on', 'Not submitted to Phoenix', 'There is no engine decision for this application. Assess it from the documents and the bureau pull.']
        : ['hourglass_empty', 'Not scored yet', 'Phoenix has the application but has not scored it. The memo fills in once it does.']
  return (
    <div className="sd-band sd-band-wait">
      <div className="sd-band-icn"><span className="material-symbols-rounded">{icon}</span></div>
      <div style={{ minWidth: 0 }}>
        <b>{title}</b>
        <span>{body}</span>
      </div>
      {state.error && (
        <button className="sd-btn" style={{ marginLeft: 'auto' }} onClick={state.reload}>
          <span className="material-symbols-rounded">refresh</span>Try again
        </button>
      )}
    </div>
  )
}
