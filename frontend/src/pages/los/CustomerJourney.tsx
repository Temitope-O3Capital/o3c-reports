// The customer's side of an application: consent, the amount they accepted, and
// the direct-debit mandate.
//
// Phoenix owns all three and stays the system of record. Until now they could only
// be done in Phoenix's own UI, so an officer working a file in the workspace had to
// switch systems to move it forward — and the workspace could not even show how far
// the customer had got. That is why an application could sit looking "approved,
// nothing happening" when what it was actually waiting for was a signature.
//
// Every action calls Phoenix and shows Phoenix's own answer. Nothing is assumed to
// have worked: a mandate that exists in one system and not the other is worse than
// an error message.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiFetch, apiPost } from '../../lib/api'

type Mandate = {
  id: string
  status?: string | null
  account_number?: string | null
  account_name?: string | null
  institution_code?: string | null
  maximum_amount_minor?: number | null
  created_at?: string | null
}

type Props = {
  appId: number
  /** Phoenix's own customer-journey stage, mirrored onto our row by the webhook. */
  phoenixStage?: string | null
  /** Approved ceiling, so the amount step can show what the customer may take. */
  approvedKobo?: number | null
  requestedKobo?: number | null
  onRefresh?: () => void
}

const naira = (kobo?: number | null) =>
  kobo == null ? '—' : '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })

const fmtDay = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Phoenix's workflow stages in order, so a later stage can be read as evidence that
// an earlier step happened.
//
// This is the only signal available for amount confirmation: the confirmed amount is
// not surfaced on any payload the machine key can read, so that step reports what the
// LAST STAGE PHOENIX REPORTED implies, and says so, rather than asserting a state
// nobody checked. Consent used to work the same way. Phoenix now exposes its consent
// ledger to the machine key, so that step reads the ledger directly and falls back to
// the stage only when the ledger cannot be reached.
//
// The earlier version simply hardcoded both, which meant the panel said "Awaiting
// the customer" after the customer had already confirmed — a confident wrong answer
// on the one screen whose job is telling an officer what a file is waiting on.
const STAGE_ORDER = [
  'SUBMITTED', 'DATA_ANALYSIS', 'CRC_CHECK', 'PREQUALIFIED',
  'AUTO_APPROVED', 'MANUAL_REVIEW', 'OFFER_SENT', 'OFFER_ACCEPTED',
  'CONSENT_COMPLETED', 'MANDATE_COMPLETED', 'CARD_CREATED',
]
const TERMINAL = new Set(['REJECTED', 'EXPIRED', 'EXCEPTION'])

function stageRank(stage?: string | null): number {
  const i = STAGE_ORDER.indexOf((stage ?? '').toUpperCase())
  return i // -1 when unknown or terminal
}

// reached() answers "has Phoenix reported a stage at or beyond this one".
// Unknown stage returns null — not false — because "we cannot tell" and "it has not
// happened" are different answers and the UI must not merge them.
function reached(stage: string | null | undefined, mark: string): boolean | null {
  const s = (stage ?? '').toUpperCase()
  if (!s || TERMINAL.has(s)) return null
  const r = stageRank(s)
  const m = STAGE_ORDER.indexOf(mark)
  if (r < 0 || m < 0) return null
  return r >= m
}

// Mandate states worth distinguishing. Anything Phoenix returns that is not in this
// map is shown verbatim rather than forced into a bucket — inventing a status is how
// a real provider state gets hidden.
const MANDATE_TONE: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'idle' }> = {
  ACTIVE: { label: 'Active', tone: 'good' },
  APPROVED: { label: 'Active', tone: 'good' },
  PENDING: { label: 'Awaiting the customer', tone: 'warn' },
  PENDING_APPROVAL: { label: 'Awaiting the customer', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', tone: 'bad' },
  EXPIRED: { label: 'Expired', tone: 'bad' },
}

function Pill({ text, tone }: { text: string; tone: 'good' | 'warn' | 'bad' | 'idle' }) {
  const c = {
    good: { bg: 'color-mix(in srgb, var(--sd-green) 12%, transparent)', fg: 'var(--sd-green)' },
    warn: { bg: 'color-mix(in srgb, var(--sd-amber) 14%, transparent)', fg: 'var(--sd-amber)' },
    bad: { bg: 'color-mix(in srgb, var(--sd-red) 10%, transparent)', fg: 'var(--sd-red)' },
    idle: { bg: 'var(--th-bg)', fg: 'var(--txt2)' },
  }[tone]
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: '.03em', padding: '3px 9px',
      borderRadius: 20, background: c.bg, color: c.fg, whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

function Step({ icon, title, sub, status, children }: {
  icon: string; title: string; sub?: React.ReactNode
  status: React.ReactNode; children?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '14px 4px', borderBottom: '1px solid var(--bdr)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 19, color: 'var(--txt2)', marginTop: 1 }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{title}</span>
          {status}
        </div>
        {sub && <div style={{ fontSize: 12.3, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {children && <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  )
}

export default function CustomerJourney({ appId, phoenixStage, approvedKobo, requestedKobo, onRefresh }: Props) {
  const [mandates, setMandates] = useState<Mandate[] | null>(null)
  const [reason, setReason] = useState<string | undefined>()
  const [busy, setBusy] = useState<string | null>(null)
  // Whether Phoenix has a direct-debit provider to register a mandate with. null is
  // "not told" — an older backend, or no Phoenix link yet — and must not be read as
  // "unavailable", or the button would disappear for the wrong reason.
  const [ddAvailable, setDdAvailable] = useState<boolean | null>(null)
  const [ddNote, setDdNote] = useState('')
  // NDPA consent as Phoenix's own ledger reports it. readable=false when Phoenix could
  // not be asked, in which case the step falls back to what the stage implies.
  const [consent, setConsent] = useState<{ readable: boolean; granted: boolean; at: string | null; note?: string } | null>(null)

  const [showMandate, setShowMandate] = useState(false)
  const [acct, setAcct] = useState('')
  const [acctName, setAcctName] = useState('')
  const [bank, setBank] = useState('')

  const [showAmount, setShowAmount] = useState(false)
  const [amount, setAmount] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: {
        mandates: Mandate[] | { items?: Mandate[] } | null
        reason?: string
        provider_available?: boolean
        provider_note?: string
      } }>(`/api/los/${appId}/mandate`)
      const raw = res.data?.mandates as any
      // Phoenix returns either a bare array or a paged envelope depending on the
      // endpoint's age. Accept both rather than guessing one and rendering nothing.
      const list: Mandate[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : []
      setMandates(list)
      setReason(res.data?.reason)
      setDdAvailable(typeof res.data?.provider_available === 'boolean' ? res.data.provider_available : null)
      setDdNote(res.data?.provider_note ?? '')
    } catch (e) {
      setReason(e instanceof Error ? e.message : 'Could not read mandates')
      setMandates([])
    }
    // Consent comes from Phoenix's ledger, in its own try: a mandate read failing must
    // not blank the consent step, nor the other way round.
    try {
      const c = await apiFetch<{ data: {
        granted?: boolean
        phoenix_records?: { consent_type?: string; granted_at?: string; revoked_at?: string | null }[] | null
        phoenix_note?: string
      } }>(`/api/los/${appId}/consent`)
      const pr = c.data?.phoenix_records
      const recs = Array.isArray(pr) ? pr : []
      // Newest first, so the first NDPA row is the one that decides.
      const ndpa = recs.find(r => (r.consent_type ?? '').toUpperCase() === 'NDPA')
      setConsent({
        readable: !c.data?.phoenix_note,
        granted: !!c.data?.granted,
        at: ndpa?.granted_at ?? null,
        note: c.data?.phoenix_note || undefined,
      })
    } catch (e) {
      setConsent({ readable: false, granted: false, at: null, note: e instanceof Error ? e.message : undefined })
    }
  }, [appId])

  useEffect(() => { void load() }, [load])

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key)
    try {
      await fn()
      toast.success(ok)
      await load()
      onRefresh?.()
    } catch (e) {
      // Phoenix's validation messages are specific and actionable; show them rather
      // than a generic failure.
      toast.error(e instanceof Error ? e.message : 'Phoenix rejected that')
    } finally {
      setBusy(null)
    }
  }

  // Derived from the stage Phoenix last reported — see STAGE_ORDER. null means the
  // stage tells us nothing either way, which is shown as "not verifiable" rather
  // than being rendered as a negative.
  // Phoenix's consent ledger decides whenever it can be read; the stage is only the
  // fallback for when it cannot.
  const consentDone = consent?.readable ? consent.granted : reached(phoenixStage, 'CONSENT_COMPLETED')
  const amountConfirmed = reached(phoenixStage, 'OFFER_ACCEPTED')

  const active = mandates?.find(m => ['ACTIVE', 'APPROVED'].includes((m.status ?? '').toUpperCase()))
  const latest = active ?? mandates?.[0]
  const mStatus = (latest?.status ?? '').toUpperCase()
  const mMeta = MANDATE_TONE[mStatus]

  const input: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid var(--bdr)',
    background: 'var(--card)', color: 'var(--txt)', fontSize: 13, marginTop: 4,
  }
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--txt2)' }

  return (
    <div className="sd-panel">
      <div className="sd-panel-head">
        <h2>Customer journey</h2>
        <span className="sd-panel-hint">
          {phoenixStage
            ? <>Phoenix stage: <b style={{ color: "var(--txt)" }}>{phoenixStage.replace(/_/g, " ").toLowerCase()}</b></>
            : "Phoenix owns these steps — taken here, recorded there"}
        </span>
      </div>
      <div className="sd-panel-body">

        {/* Consent */}
        <Step
          icon="verified_user"
          title="Consent (NDPA)"
          sub={consentDone === true
            ? <>Phoenix has NDPA consent on file{consent?.readable && consent.at ? <> since <b>{fmtDay(consent.at)}</b></> : null}.
                {!consent?.readable ? ' This is inferred from its stage — the consent ledger could not be read.' : null}</>
            : consentDone === false
              ? 'Phoenix has no NDPA consent for this applicant. It will not run a bureau check against them without it — capture it when the customer gives it.'
              : `Consent could not be confirmed${consent?.note ? ` — ${consent.note}` : ''}.`}
          status={
            consentDone === true ? <Pill text="On file" tone="good" />
              : consentDone === false ? <Pill text="Not on file" tone="warn" />
                : <Pill text="Not verifiable" tone="idle" />
          }>
          {/* Withheld once the ledger shows consent. Every press writes another row into
              a legal record of consent, so a second one is not harmless once the first
              can be seen. */}
          {!(consent?.readable && consent.granted) && (
            <button className="sd-btn" disabled={busy !== null}
              onClick={() => run('consent', () => apiPost(`/api/los/${appId}/consent`, { channel: 'phone' }), 'Consent recorded')}>
              <span className="material-symbols-rounded">how_to_reg</span>
              {busy === 'consent' ? 'Recording…' : 'Record consent'}
            </button>
          )}
        </Step>

        {/* Amount the customer accepted */}
        <Step
          icon="price_check"
          title="Amount confirmed"
          sub={amountConfirmed === true
            ? 'The customer has accepted an amount. Phoenix holds the figure.'
            : approvedKobo
              ? <>Phoenix approved a ceiling of <b>{naira(approvedKobo)}</b>. Record what the customer actually accepted.</>
              : 'Phoenix approves a ceiling; the customer then chooses what to take. Record their choice here.'}
          status={
            amountConfirmed === true ? <Pill text="Confirmed" tone="good" />
              : amountConfirmed === false ? <Pill text="Awaiting the customer" tone="warn" />
                : <Pill text="Not reported yet" tone="idle" />
          }>
          <button className="sd-btn" disabled={busy !== null} onClick={() => { setAmount(''); setShowAmount(v => !v) }}>
            <span className="material-symbols-rounded">edit</span>Confirm amount
          </button>
        </Step>

        {showAmount && (
          <div style={{ padding: '12px 4px 16px', borderBottom: '1px solid var(--bdr)' }}>
            <label style={label}>Amount the customer accepted (₦)
              <input style={input} type="number" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder={approvedKobo ? String(approvedKobo / 100) : requestedKobo ? String(requestedKobo / 100) : ''} />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="sd-btn is-primary" disabled={busy !== null || !amount}
                onClick={() => run('amount', () => apiPost(`/api/los/${appId}/confirm-amount`, {
                  chosen_amount_kobo: Math.round(Number(amount) * 100),
                }), 'Amount confirmed').then(() => setShowAmount(false))}>
                {busy === 'amount' ? 'Saving…' : 'Confirm'}
              </button>
              <button className="sd-btn" onClick={() => setShowAmount(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Direct debit mandate */}
        <Step
          icon="account_balance"
          title="Direct debit mandate"
          sub={
            reason ? <span style={{ color: 'var(--sd-amber)' }}>{reason}</span>
              : latest
                ? <>Account {latest.account_number ?? '—'}{latest.account_name ? ` · ${latest.account_name}` : ''}</>
                : ddAvailable === false
                  // Said before the form opens rather than after it fails. Phoenix
                  // would otherwise "register" a mandate no bank has seen and then
                  // text the customer to authorise it every four hours.
                  ? <span style={{ color: 'var(--sd-amber)' }}>{ddNote}</span>
                  : 'No mandate registered. Repayments cannot be collected automatically until one is active.'
          }
          status={
            latest
              ? <Pill text={mMeta?.label ?? (latest.status ?? 'Unknown')} tone={mMeta?.tone ?? 'idle'} />
              : ddAvailable === false
                ? <Pill text="No provider" tone="warn" />
                : <Pill text="Not set up" tone="idle" />
          }>
          {!active && (
            <button className="sd-btn" disabled={busy !== null || ddAvailable === false}
              title={ddAvailable === false ? ddNote : undefined}
              onClick={() => setShowMandate(v => !v)}>
              <span className="material-symbols-rounded">add</span>Set up
            </button>
          )}
          {latest && !active && (
            <>
              <button className="sd-btn" disabled={busy !== null}
                onClick={() => run('remind', () => apiPost(`/api/los/${appId}/mandate/${latest.id}/remind`, {}), 'Reminder sent')}>
                {busy === 'remind' ? 'Sending…' : 'Remind'}
              </button>
              <button className="sd-btn" disabled={busy !== null}
                onClick={() => run('check', () => apiPost(`/api/los/${appId}/mandate/${latest.id}/check-status`, {}), 'Status re-checked')}>
                {busy === 'check' ? 'Checking…' : 'Re-check'}
              </button>
            </>
          )}
        </Step>

        {showMandate && ddAvailable !== false && (
          <div style={{ padding: '12px 4px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
              <label style={label}>Account number
                <input style={input} value={acct} onChange={e => setAcct(e.target.value)} inputMode="numeric" />
              </label>
              <label style={label}>Account name
                <input style={input} value={acctName} onChange={e => setAcctName(e.target.value)} placeholder="defaults to the applicant" />
              </label>
              <label style={label}>Bank code
                <input style={input} value={bank} onChange={e => setBank(e.target.value)} placeholder="optional" />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="sd-btn is-primary" disabled={busy !== null || !acct}
                onClick={() => run('mandate', () => apiPost(`/api/los/${appId}/mandate`, {
                  account_number: acct.trim(),
                  account_name: acctName.trim(),
                  institution_code: bank.trim(),
                }), 'Mandate registered').then(() => setShowMandate(false))}>
                {busy === 'mandate' ? 'Registering…' : 'Register mandate'}
              </button>
              <button className="sd-btn" onClick={() => setShowMandate(false)}>Cancel</button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
