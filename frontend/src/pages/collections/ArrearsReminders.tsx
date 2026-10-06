import { useState, useEffect, useCallback } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Page, SectionCard, KpiCard, DataTable, Modal, ErrBanner, Spinner, Button, Input,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, TEXT, FW, SP, RADIUS, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// Arrears Reminders — what the nightly run would send, and the switch that makes it real.
//
// The pipeline behind this resolves a real recipient, renders real copy, checks consent
// and suppression, and logs every attempt to app.dunning_sends. Until this page existed,
// none of that was visible: dunning_sends was referenced in exactly two places in the
// entire backend — the insert and the throttle check. Reviewing the first customer
// messaging this company has ever produced meant reading a shared mailbox, and turning
// it on meant editing a row in a credentials table by hand, leaving no record of who
// decided.
//
// So this page is built around one question — "would I be happy for this to arrive?" —
// and puts the evidence and the switch side by side. The body of each message is shown
// in full, because a reminder you have to click twice to read is a reminder nobody reads
// before approving it.

// ── Types ─────────────────────────────────────────────────────────────────────

interface Policy {
  max_per_run: number
  min_kobo: number
  fresh_days: number
  max_dpd: number
  throttle_days: number
}
interface Worker {
  status: string
  detail: string | null
  last_error: string | null
  runs_total: number
  last_ok_at: string | null
  updated_at: string
}
interface BookCount { facilities: number; people?: number; outstanding_kobo: number }
// One DPD band, the wording written for it, and who that wording would actually reach.
// eligible_if_off is deliberately independent of the current setting: the page has to be
// able to state what turning the recovery filter off would do before anyone turns it off.
interface CoverageBucket {
  bucket: string
  people: number
  held_recovery: number
  held_kobo: number
  eligible: number
  eligible_if_off: number
  unreachable: number
  can_email: number
  can_sms: number
  rendered: number
  template_id: number
  template_name: string
  // What the run actually sends when no template names this band.
  substitute_id?: number
  substitute_name?: string
  template_matches: boolean
}
interface Coverage {
  buckets: CoverageBucket[]
  templates_unreachable: { id: number; name: string }[]
}
interface Status {
  mode: 'live' | 'staff_preview'
  inbox: string
  policy: Policy
  worker?: Worker
  eligible_book?: BookCount
  below_floor?: BookCount
  unreachable?: { people: number; outstanding_kobo: number }
  with_recovery?: { status: string; facilities: number; outstanding_kobo: number }[]
  skip_recovery?: boolean
  channels?: { channel: string; ready: boolean; sender: string; reason: string }[]
  coverage?: Coverage
}
interface Send {
  id: number
  party_id: number | null
  account_cif: string
  facility: string | null
  channel: string
  dpd: number
  dpd_bucket: string | null
  outstanding_kobo: number
  recipient: string
  subject: string | null
  body: string | null
  outcome: string
  outcome_detail: string | null
  sent_at: string
}
interface Totals { outcome: string; n: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

const OUTCOME_COLOR: Record<string, string> = {
  sent: GREEN, staff_preview: NAVY, suppressed: AMBER, failed: RED, no_contact: 'var(--txt3)',
}
const OUTCOME_LABEL: Record<string, string> = {
  sent: 'Sent to customer', staff_preview: 'Previewed to staff', suppressed: 'Suppressed',
  failed: 'Failed', no_contact: 'No contact details',
}
const CHANNEL_ICON: Record<string, string> = {
  email: 'mail', sms: 'sms', whatsapp: 'chat',
}

export default function ArrearsReminders() {
  const [status, setStatus] = useState<Status | null>(null)
  const [sends, setSends]   = useState<Send[]>([])
  const [totals, setTotals] = useState<Totals[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)
  const [reading, setReading] = useState<Send | null>(null)
  const [goLive, setGoLive] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const [s, l] = await Promise.all([
        apiFetch<Status>('/api/collections/dunning/status'),
        apiFetch<{ sends: Send[]; totals: Totals[] }>('/api/collections/dunning/sends?limit=200'),
      ])
      setStatus(s)
      setSends(l?.sends ?? [])
      setTotals(l?.totals ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function setMode(mode: 'live' | 'staff_preview') {
    setSaving(true)
    try {
      await apiPost('/api/collections/dunning/mode',
        mode === 'live' ? { mode, confirm } : { mode })
      toast.success(mode === 'live'
        ? 'Live. Reminders now go to borrowers.'
        : 'Back to preview. Nothing reaches borrowers.')
      setGoLive(false); setConfirm('')
      load(true)
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  if (loading && !status) return (
    <Page title="Arrears Reminders"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>
  )
  if (error && !status) return <Page title="Arrears Reminders"><ErrBanner error={error} onRetry={load} /></Page>
  if (!status) return null

  const live = status.mode === 'live'
  const tally = (o: string) => Number(totals.find(t => t.outcome === o)?.n ?? 0)
  const previewed = tally('staff_preview')
  const legalHeld = status.with_recovery?.find(r => r.status === 'legal')?.facilities ?? 0
  const recoveryHeld = (status.with_recovery ?? [])
    .filter(r => r.status === 'legal' || (status.skip_recovery !== false && r.status === 'active'))
    .reduce((n, r) => n + r.facilities, 0)
  const p = status.policy

  const cov = status.coverage
  const covBuckets = cov?.buckets ?? []
  // What turning the recovery filter off would open up — and how much of that lands in
  // bands whose wording nobody has ever seen, which is the part that makes it a
  // consequence rather than a setting.
  const wouldAdd = covBuckets.reduce((n, b) => n + Math.max(0, b.eligible_if_off - b.eligible), 0)
  const dormant = covBuckets.filter(b => b.eligible === 0 && b.eligible_if_off > 0)
  const dormantPeople = dormant.reduce((n, b) => n + b.eligible_if_off, 0)
  const neverRendered = covBuckets.filter(b => b.rendered === 0)
  // Bands the run has no wording for. It refuses them rather than sending the gentlest
  // letter, so these people are simply never written to — a silent gap, not an error.
  const noTemplate = covBuckets.filter(b => !b.template_matches)
  const strandedByNoTemplate = noTemplate.reduce((n, b) => n + b.eligible, 0)
  const eligibleTotal = covBuckets.reduce((n, b) => n + b.eligible, 0)
  // The cap is not a detail at go-live: it decides whether "live" means a week or a
  // season. At 5 a night the queue below takes months, which is a choice someone should
  // make knowingly rather than discover.
  const nightsToClear = p.max_per_run > 0 ? Math.ceil(eligibleTotal / p.max_per_run) : 0
  // Which channel would actually carry the first live run. "Reachable" does not answer
  // it: someone with a phone and no email is reachable and still invisible to an
  // email-only run.
  const canEmail = covBuckets.reduce((n, b) => n + b.can_email, 0)
  const canSms = covBuckets.reduce((n, b) => n + b.can_sms, 0)
  const shortTpl = (n: string) => { const i = n.indexOf('·'); return i >= 0 ? n.slice(i + 1).trim() : n }

  const covCols: TableCol<CoverageBucket>[] = [
    { key: 'bucket', label: 'Band', render: r => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: r.bucket === '360+' || r.bucket === '181-360' ? RED : 'var(--txt)' }}>
        {r.bucket}
      </span>
    )},
    { key: 'template_name', label: 'Wording', render: r => r.template_matches ? (
      <div style={{ fontSize: TEXT.sm }}>{shortTpl(r.template_name)}</div>
    ) : r.substitute_name ? (
      // No template names this band, so the run SUBSTITUTES the firmest wording at or
      // below it. This cell used to read "skipped — nobody here is written to", which
      // described a design that never shipped: skipping would have stopped contacting
      // delinquent borrowers to fix a routing fault. These people ARE written to, in
      // wording written for a younger debt, which is the thing worth showing.
      <div>
        <div style={{ fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold }}>
          {shortTpl(r.substitute_name)}
        </div>
        <div style={{ fontSize: TEXT['2xs'], color: AMBER }}>
          borrowed — no wording for this band
        </div>
      </div>
    ) : (
      // Nothing at or below this band either, so there is genuinely nothing to send.
      <div>
        <div style={{ fontSize: TEXT.sm, color: RED, fontWeight: FW.semibold }}>none</div>
        <div style={{ fontSize: TEXT['2xs'], color: RED }}>no wording available</div>
      </div>
    )},
    { key: 'people', label: 'In Arrears', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtNum(r.people)}</span> },
    { key: 'held_recovery', label: 'With Recovery', align: 'right', render: r => (
      <div>
        <div style={{ ...NUM, color: r.held_recovery > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(r.held_recovery)}</div>
        {r.held_kobo > 0 && (
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtKobo(r.held_kobo)}</div>
        )}
      </div>
    )},
    { key: 'eligible', label: 'Would Be Written To', align: 'right', render: r => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: r.eligible > 0 ? GREEN : 'var(--txt3)' }}>
        {fmtNum(r.eligible)}
      </span>
    )},
    { key: 'unreachable', label: 'No Contact', align: 'right',
      render: r => <span style={{ ...NUM, color: r.unreachable > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(r.unreachable)}</span> },
    { key: 'rendered', label: 'Ever Rendered', align: 'right', render: r => r.rendered > 0
      ? <span style={{ ...NUM }}>{fmtNum(r.rendered)}</span>
      : <span style={{ fontSize: TEXT['2xs'], color: AMBER, fontWeight: FW.bold }}>never</span> },
  ]

  const cols: TableCol<Send>[] = [
    { key: 'sent_at', label: 'When', render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {new Date(r.sent_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </span>
    )},
    { key: 'channel', label: 'Channel', render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.sm }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)' }}>
          {CHANNEL_ICON[r.channel] ?? 'send'}
        </span>
        {r.channel}
      </span>
    )},
    { key: 'recipient', label: 'Would Go To', render: r => (
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, wordBreak: 'break-all' }}>{r.recipient || '—'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
          {r.account_cif}{r.facility ? ` · ${r.facility}` : ''}
        </div>
      </div>
    )},
    { key: 'dpd', label: 'DPD', align: 'right', render: r => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: r.dpd > 90 ? RED : r.dpd > 30 ? AMBER : 'var(--txt)' }}>
        {fmtNum(r.dpd)}
      </span>
    )},
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKobo(r.outstanding_kobo)}</span> },
    { key: 'outcome', label: 'Outcome', render: r => {
      const c = OUTCOME_COLOR[r.outcome] ?? 'var(--txt2)'
      return (
        <span title={r.outcome_detail ?? undefined}
          style={{ display: 'inline-block', padding: '2px 9px', borderRadius: RADIUS.full,
                   background: `${c}18`, color: c, fontSize: TEXT['2xs'], fontWeight: FW.bold,
                   cursor: r.outcome_detail ? 'help' : 'default' }}>
          {OUTCOME_LABEL[r.outcome] ?? r.outcome}
        </span>
      )
    }},
    { key: 'id', label: '', render: r => r.body || r.subject ? (
      <Button size="sm" variant="secondary" onClick={() => setReading(r)}>Read</Button>
    ) : <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>nothing rendered</span> },
  ]

  return (
    <Page title="Arrears Reminders" subtitle="What the nightly run would send, and who it would reach">
      <ErrBanner error={error} onRetry={load} />

      {/* Mode. The single most consequential fact on the page, so it is the first thing
          on it and it says what it means rather than showing a toggle labelled "live". */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: SP[3], padding: `${SP[3]} ${SP[4]}`,
        borderRadius: RADIUS.lg, marginBottom: SP[4],
        background: live ? `${RED}0C` : `${NAVY}0A`,
        border: `1px solid ${live ? `${RED}40` : `${NAVY}25`}`,
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: live ? RED : NAVY }}>
          {live ? 'campaign' : 'visibility'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: live ? RED : NAVY }}>
            {live ? 'Live — borrowers receive these messages' : 'Preview only — nothing reaches a borrower'}
          </div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.5 }}>
            {live
              ? 'Every reminder below was delivered to the customer named on it.'
              : <>Each reminder is resolved and rendered for real, then delivered to{' '}
                 <strong>{status.inbox || 'a staff inbox that is not configured'}</strong> instead of the customer.</>}
          </div>
        </div>
        {live ? (
          <Button variant="secondary" loading={saving} onClick={() => setMode('staff_preview')}>
            Back to Preview
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setGoLive(true)}
            disabled={previewed === 0}
            title={previewed === 0 ? 'Nothing has been previewed yet — let the nightly run produce a batch first' : undefined}>
            Go Live
          </Button>
        )}
      </div>

      {/* What the run last did, in its own words. */}
      {status.worker && (
        <SectionCard title="Last Run" style={{ marginBottom: SP[4] }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[4], alignItems: 'baseline' }}>
            <span style={{
              padding: '2px 10px', borderRadius: RADIUS.full, fontSize: TEXT.xs, fontWeight: FW.bold,
              background: status.worker.status === 'ok' ? `${GREEN}18` : status.worker.status === 'error' ? `${RED}18` : 'var(--bg)',
              color: status.worker.status === 'ok' ? GREEN : status.worker.status === 'error' ? RED : 'var(--txt2)',
            }}>{status.worker.status}</span>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
              {status.worker.detail || status.worker.last_error || 'no detail recorded'}
            </span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>
              {fmtNum(status.worker.runs_total)} runs · last {fmtDate(status.worker.updated_at)}
              {!status.worker.last_ok_at && ' · has never completed a send'}
            </span>
          </div>
        </SectionCard>
      )}

      {/* The book, and the policy applied to it. The floor's effect is stated rather
          than silently applied: 242 facilities holding N14,942 between them are excluded
          by design, and anyone judging this should see that number. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Chaseable Arrears" icon="account_balance" accent={NAVY}
          value={status.eligible_book ? fmtKobo(status.eligible_book.outstanding_kobo) : '—'}
          sub={status.eligible_book ? `${fmtNum(status.eligible_book.facilities)} facilities · ${fmtNum(status.eligible_book.people ?? 0)} people` : undefined} />
        <KpiCard label="Below The Floor" icon="filter_alt" accent={AMBER}
          value={status.below_floor ? fmtNum(status.below_floor.facilities) : '—'}
          sub={status.below_floor ? `holding ${fmtKobo(status.below_floor.outstanding_kobo)} in total — not chased` : undefined} />
        {/* Not a statistic — a work item. These borrowers cannot be written to at all,
            and the run no longer spends its nightly cap discovering that again. */}
        <KpiCard label="No Way To Reach Them" icon="person_off"
          accent={(status.unreachable?.people ?? 0) > 0 ? AMBER : 'var(--txt3)'}
          value={status.unreachable ? fmtNum(status.unreachable.people) : '—'}
          sub={status.unreachable
            ? `holding ${fmtKobo(status.unreachable.outstanding_kobo)} — no email, no phone`
            : undefined} />
        {/* Held back because somebody is already on the case. 'legal' is excluded no
            matter what the setting says: an automated "call us to arrange repayment"
            to a borrower whose case is with solicitors contradicts what the company is
            saying through its lawyers. */}
        <KpiCard label="Already With Recovery" icon="gavel"
          accent={recoveryHeld > 0 ? AMBER : 'var(--txt3)'} value={fmtNum(recoveryHeld)}
          sub={legalHeld > 0
            ? `${fmtNum(legalHeld)} with solicitors, never written to`
            : 'not chased automatically'} />
        <KpiCard label="Previewed" icon="visibility" accent={NAVY} value={fmtNum(previewed)}
          sub="rendered to the staff inbox" />
        <KpiCard label="Sent To Customers" icon="campaign" accent={tally('sent') > 0 ? GREEN : 'var(--txt3)'}
          value={fmtNum(tally('sent'))} sub={tally('suppressed') > 0 ? `${fmtNum(tally('suppressed'))} suppressed` : 'none yet'} />
      </div>

      {/* Whether a channel could actually deliver tonight. This was not knowable from
          the app: the credentials table showed both SendGrid and Termii blank, which
          looked like nothing worked, while the environment held both and email had been
          delivering for months. WhatsApp genuinely had nothing. Three different states,
          all presenting as an empty row. */}
      {status.channels && status.channels.length > 0 && (
        <SectionCard title="Channels Ready To Send"
          subtitle="Whether a live run could actually deliver, and what is missing where it could not"
          style={{ marginBottom: SP[4] }}>
          <div style={{ display: 'grid', gap: SP[2] }}>
            {status.channels.map(c => (
              <div key={c.channel} style={{
                display: 'flex', alignItems: 'flex-start', gap: SP[3],
                padding: SP[2], borderRadius: RADIUS.md,
                background: c.ready ? `${GREEN}0a` : `${AMBER}0a`,
                border: `1px solid ${c.ready ? GREEN : AMBER}22`,
              }}>
                <span className="material-symbols-rounded"
                  style={{ fontSize: 20, color: c.ready ? GREEN : AMBER, lineHeight: 1.2 }}>
                  {c.ready ? 'check_circle' : 'error'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: INTER, fontWeight: FW.semibold, fontSize: TEXT.sm, color: 'var(--txt1)' }}>
                    {c.channel === 'sms' ? 'SMS' : c.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                    {c.sender && (
                      <span style={{ fontWeight: FW.normal, color: 'var(--txt2)' }}>
                        {' '}· shows as {c.sender}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{c.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Which wording can actually be reached.
          Three of the six templates — the firmest language in the system, carrying
          recovery referral and, at 360+, the solicitors — have never rendered once, not
          even to the staff inbox. Every borrower old enough to receive them is already
          with recovery, so the band is populated and its eligible count is nil.
          Unreviewed copy is the smaller half of that. The larger half is that
          SKIP_RECOVERY is the only thing holding it back: it reads like a filter and
          behaves like a floodgate, and nothing on this page said so until now. */}
      {covBuckets.length > 0 && (
        <SectionCard title="Wording Coverage"
          subtitle="Which band each template is written for, and how many people it would actually reach"
          style={{ marginBottom: SP[4] }}>
          <DataTable cols={covCols} rows={covBuckets} keyFn={r => r.bucket} />

          {/* Which channel could carry a first live run. Separate from the reachability
              column above, which counts anyone with either detail: a borrower holding a
              phone and no email is reachable and still invisible to an email-only run. */}
          {eligibleTotal > 0 && (
            <Caution icon="alternate_email" tone={NAVY} style={{ marginTop: SP[3] }}>
              Of the <strong>{fmtNum(eligibleTotal)}</strong> who would be written to,{' '}
              <strong>{fmtNum(canEmail)}</strong> have an email address and{' '}
              <strong>{fmtNum(canSms)}</strong> have a phone number — so either channel
              alone reaches most of them, and whichever goes live first leaves{' '}
              {fmtNum(Math.max(eligibleTotal - Math.max(canEmail, canSms), 0))} to the other.
              WhatsApp uses the same number as SMS.
            </Caution>
          )}

          {noTemplate.length > 0 && (
            <Caution icon="report" tone={RED} style={{ marginTop: SP[2] }}>
              <strong>No wording exists for {noTemplate.map(b => b.bucket).join(', ')}</strong>, so
              the run skips {noTemplate.length === 1 ? 'that band' : 'those bands'} rather than
              send a letter written for a different age
              {strandedByNoTemplate > 0
                ? <>. {fmtNum(strandedByNoTemplate)} {strandedByNoTemplate === 1 ? 'borrower is' : 'borrowers are'} eligible
                   and hearing nothing as a result.</>
                : <>. Nobody is eligible in {noTemplate.length === 1 ? 'it' : 'them'} today, so
                   nothing is being missed yet.</>}
              {' '}A band is matched by the template's NAME, so this is what a rename looks like.
            </Caution>
          )}

          {neverRendered.length > 0 && (
            <Caution icon="drafts" tone={AMBER} style={{ marginTop: SP[3] }}>
              <strong>{neverRendered.length} of {covBuckets.length} templates have never
              been rendered</strong> — {neverRendered.map(b => b.bucket).join(', ')}. Nobody has
              read this wording as a borrower would receive it, on any channel, because nobody
              has ever been eligible for it. Review it from the template itself rather than
              waiting for a preview that cannot arrive.
            </Caution>
          )}

          {status.skip_recovery !== false && wouldAdd > 0 && (
            <Caution icon="warning" tone={RED} style={{ marginTop: SP[2] }}>
              <strong>Turning off the recovery filter would open these reminders to{' '}
              {fmtNum(wouldAdd)} more {wouldAdd === 1 ? 'person' : 'people'}</strong>
              {dormantPeople > 0 && <>, {fmtNum(dormantPeople)} of them in the{' '}
              {dormant.map(b => b.bucket).join(', ')} {dormant.length === 1 ? 'band' : 'bands'} whose
              wording has never been seen</>}. Everyone it would release is already being worked
              by a recovery officer, so each would be hearing from an officer and from this
              system at once. Borrowers whose cases are with solicitors stay excluded either
              way — no setting reaches them.
            </Caution>
          )}

          {(cov?.templates_unreachable ?? []).length > 0 && (
            <Caution icon="block" tone={AMBER} style={{ marginTop: SP[2] }}>
              <strong>Written for a band that does not exist on this book:</strong>{' '}
              {(cov?.templates_unreachable ?? []).map(t => t.name).join(', ')}. No arrears of any
              age map to this wording, so it can never be selected.
            </Caution>
          )}
        </SectionCard>
      )}

      <SectionCard title="Policy In Force" subtitle="Set in configuration, applied every run"
        style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[4], fontSize: TEXT.sm }}>
          <Fact label="Facilities per run" value={fmtNum(p.max_per_run)} />
          <Fact label="Materiality floor" value={fmtKobo(p.min_kobo)} />
          <Fact label="Contacted first, within" value={`${fmtNum(p.fresh_days)} days past due`} />
          <Fact label="Upper age bound" value={p.max_dpd > 0 ? `${fmtNum(p.max_dpd)} days` : 'none set'} />
          <Fact label="One round per facility every" value={`${fmtNum(p.throttle_days)} days`} />
        </div>
      </SectionCard>

      <SectionCard title="Every Attempt" subtitle="Including what was suppressed, and why"
        actions={<Button size="sm" variant="secondary" icon="refresh" onClick={() => load(true)}>Refresh</Button>}>
        {sends.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, lineHeight: 1.6 }}>
            Nothing yet. The nightly batch runs at 00:05 and writes a row here for every
            attempt — rendered, suppressed or failed.
          </div>
        ) : (
          <DataTable cols={cols} rows={sends} keyFn={r => String(r.id)} />
        )}
      </SectionCard>

      {/* Read the message itself. */}
      <Modal open={!!reading} onClose={() => setReading(null)} width={640}
        title={reading ? `${reading.channel} to ${reading.recipient || 'no recipient'}` : ''}>
        {reading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              <span>{reading.account_cif}</span>
              {reading.facility && <span>· {reading.facility}</span>}
              <span>· {fmtNum(reading.dpd)} days past due</span>
              <span>· {fmtKobo(reading.outstanding_kobo)}</span>
            </div>
            {reading.subject && (
              <div>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', marginBottom: 4 }}>Subject</div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>{reading.subject}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', marginBottom: 4 }}>Message</div>
              <div style={{
                whiteSpace: 'pre-wrap', fontSize: TEXT.base, lineHeight: 1.6, padding: SP[3],
                background: 'var(--bg)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
                fontFamily: INTER,
              }}>{reading.body || 'Nothing was rendered for this attempt.'}</div>
            </div>
            {reading.outcome_detail && (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{reading.outcome_detail}</div>
            )}
          </div>
        )}
      </Modal>

      {/* Going live. Typing the words is the point — nobody starts writing to people
          about their debts by mis-clicking a toggle. */}
      <Modal open={goLive} onClose={() => { setGoLive(false); setConfirm('') }} width={520}
        title="Send reminders to customers?"
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => { setGoLive(false); setConfirm('') }}>Cancel</Button>
            <Button variant="danger" loading={saving}
              disabled={confirm.trim().toUpperCase() !== 'SEND TO CUSTOMERS'}
              onClick={() => setMode('live')}>
              Go Live
            </Button>
          </div>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], fontSize: TEXT.base, lineHeight: 1.6 }}>
          <p style={{ margin: 0 }}>
            From the next run, these reminders go to the borrowers named on them — by
            email, SMS and WhatsApp — instead of to {status.inbox || 'the staff inbox'}.
          </p>
          <p style={{ margin: 0, color: 'var(--txt2)' }}>
            {previewed > 0
              ? <>You have {fmtNum(previewed)} previewed {previewed === 1 ? 'message' : 'messages'} to read first. Suppression and consent still apply, and no facility is contacted more than once every {p.throttle_days} days.</>
              : 'Nothing has been previewed yet.'}
          </p>
          {eligibleTotal > 0 && (
            <p style={{ margin: 0, color: 'var(--txt2)' }}>
              {fmtNum(eligibleTotal)} {eligibleTotal === 1 ? 'borrower is' : 'borrowers are'} eligible
              right now. At {fmtNum(p.max_per_run)} a run and one run a night, that is about{' '}
              {fmtNum(nightsToClear)} {nightsToClear === 1 ? 'night' : 'nights'} to work through
              once — raise the cap if that is not the pace you want.
            </p>
          )}
          <Input label='Type "SEND TO CUSTOMERS" to confirm' value={confirm}
            onChange={e => setConfirm(e.target.value)} placeholder="SEND TO CUSTOMERS" autoFocus />
        </div>
      </Modal>
    </Page>
  )
}

// A consequence stated in prose next to the figures it follows from. Deliberately not a
// toast or a tooltip: this is the kind of thing somebody needs to have read before they
// change a setting, not after.
function Caution({ icon, tone, style, children }: {
  icon: string; tone: string; style?: CSSProperties; children: ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: SP[2], padding: SP[3],
      borderRadius: RADIUS.md, background: `${tone}0C`, border: `1px solid ${tone}35`,
      fontSize: TEXT.sm, lineHeight: 1.6, color: 'var(--txt1)', ...style,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 19, color: tone, lineHeight: 1.3 }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, marginTop: 2 }}>{value}</div>
    </div>
  )
}
