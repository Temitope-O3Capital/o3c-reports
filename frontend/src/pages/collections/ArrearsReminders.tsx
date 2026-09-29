import { useState, useEffect, useCallback } from 'react'
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
interface Status {
  mode: 'live' | 'staff_preview'
  inbox: string
  policy: Policy
  worker?: Worker
  eligible_book?: BookCount
  below_floor?: BookCount
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
  const p = status.policy

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
        <KpiCard label="Previewed" icon="visibility" accent={NAVY} value={fmtNum(previewed)}
          sub="rendered to the staff inbox" />
        <KpiCard label="Sent To Customers" icon="campaign" accent={tally('sent') > 0 ? GREEN : 'var(--txt3)'}
          value={fmtNum(tally('sent'))} sub={tally('suppressed') > 0 ? `${fmtNum(tally('suppressed'))} suppressed` : 'none yet'} />
      </div>

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
          <Input label='Type "SEND TO CUSTOMERS" to confirm' value={confirm}
            onChange={e => setConfirm(e.target.value)} placeholder="SEND TO CUSTOMERS" autoFocus />
        </div>
      </Modal>
    </Page>
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
