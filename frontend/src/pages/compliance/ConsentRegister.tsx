import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, KpiCard, Modal, ErrBanner, Spinner, Button, Input, Select, Textarea,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'
import { toast } from 'sonner'

// The Consent Register — who may be contacted, on what basis, and who has never been asked.
//
// This page exists because app.party_contact_consent was read by four subsystems and
// written by none. Marketing consent stood at zero rows on every channel for all 21,645
// customers, which is why the retention call queue resolved an audience of nobody. The
// system was not misconfigured: there was simply nowhere in the building to record a yes.
//
// The design point is the "Never Asked" column. Most consent screens show granted and
// withdrawn and let you infer the rest, which quietly turns an absence of evidence into
// a refusal. Those are different problems with different work attached: a withdrawal is
// finished business, and a person who was never asked is a conversation nobody has had.

interface CoverageRow {
  purpose: 'marketing' | 'servicing'
  channel: string
  granted: number
  expired: number
  withdrawn: number
  pending: number
  never_asked: number
  population: number
}
interface BasisRow {
  purpose: string
  basis: string
  rows_recorded: number
  first_recorded: string | null
  last_recorded: string | null
}

const CHANNELS = ['email', 'sms', 'whatsapp', 'voice']

export default function ConsentRegister() {
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [bases, setBases] = useState<BasisRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setErr(null)
      const r = await apiFetch('/api/compliance/consent/coverage')
      setCoverage(r?.coverage ?? [])
      setBases(r?.bases ?? [])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the consent register')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Page title="Consent Register"><Spinner /></Page>

  const row = (purpose: string, channel: string) =>
    coverage.find(c => c.purpose === purpose && c.channel === channel)

  const marketingGranted = CHANNELS.reduce((n, ch) => n + (row('marketing', ch)?.granted ?? 0), 0)
  const marketingNeverAsked = row('marketing', 'email')?.never_asked ?? 0
  const servicingWithdrawn = CHANNELS.reduce((n, ch) => n + (row('servicing', ch)?.withdrawn ?? 0), 0)
  const population = row('marketing', 'email')?.population ?? 0

  return (
    <Page
      title="Consent Register"
      subtitle="Who may be contacted, on what basis, and who has never been asked"
      actions={<Button onClick={() => setImportOpen(true)}>Record Consent In Bulk</Button>}
    >
      {err && <ErrBanner error={err} />}

      {/* The headline is deliberately the marketing number, because it is the one that
          decides whether any campaign can run at all. */}
      <div style={{
        border: `1px solid ${marketingGranted === 0 ? AMBER : GREEN}33`,
        background: marketingGranted === 0 ? `${AMBER}0d` : `${GREEN}0d`,
        borderRadius: RADIUS.lg, padding: SP[4], marginBottom: SP[4],
      }}>
        <div style={{ fontFamily: INTER, fontWeight: FW.semibold, fontSize: TEXT.base, color: 'var(--txt1)' }}>
          {marketingGranted === 0
            ? 'No customer has granted marketing consent on any channel'
            : `${fmtNum(marketingGranted)} marketing permissions are on record`}
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[1], maxWidth: 760 }}>
          {marketingGranted === 0
            ? `Marketing is opt-in, so an empty register means no campaign, retention call or
               promotional message can lawfully go to any of these ${fmtNum(population)} people.
               That is not a filter that can be loosened. Consent has to be captured first,
               and then recorded here with the evidence behind it.`
            : `Servicing messages, including arrears reminders, do not depend on this: servicing
               is opt-out, so only an explicit withdrawal stops one.`}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Customers On File" icon="group" accent={NAVY} value={fmtNum(population)}
          sub="every party, across all channels" />
        <KpiCard label="Marketing Permissions" icon="campaign"
          accent={marketingGranted === 0 ? AMBER : GREEN} value={fmtNum(marketingGranted)}
          sub="granted and unexpired, all channels" />
        <KpiCard label="Never Asked" icon="help" accent={AMBER} value={fmtNum(marketingNeverAsked)}
          sub="no marketing answer either way" />
        <KpiCard label="Withdrawn" icon="block" accent={servicingWithdrawn > 0 ? RED : 'var(--txt3)'}
          value={fmtNum(servicingWithdrawn)} sub="people who asked us to stop" />
      </div>

      <SectionCard title="Coverage By Purpose And Channel"
        subtitle="Marketing needs a yes. Servicing only needs the absence of a no."
        style={{ marginBottom: SP[4] }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                <th style={th}>Purpose</th><th style={th}>Channel</th>
                <th style={thNum}>Granted</th><th style={thNum}>Withdrawn</th>
                <th style={thNum}>Expired</th><th style={thNum}>Never Asked</th>
                <th style={th}>May We Contact Them?</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map(c => {
                const optIn = c.purpose === 'marketing'
                const reachable = optIn ? c.granted : c.population - c.withdrawn
                return (
                  <tr key={`${c.purpose}-${c.channel}`} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={td}>{c.purpose === 'marketing' ? 'Marketing' : 'Servicing'}</td>
                    <td style={td}>{c.channel}</td>
                    <td style={tdNum}>{fmtNum(c.granted)}</td>
                    <td style={{ ...tdNum, color: c.withdrawn > 0 ? RED : 'var(--txt3)' }}>{fmtNum(c.withdrawn)}</td>
                    <td style={tdNum}>{fmtNum(c.expired)}</td>
                    <td style={{ ...tdNum, color: c.never_asked > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(c.never_asked)}</td>
                    <td style={{ ...td, color: reachable > 0 ? GREEN : AMBER, fontWeight: FW.medium }}>
                      {fmtNum(reachable)} {reachable === 1 ? 'person' : 'people'}
                      <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}>
                        {optIn ? ' (opt-in: only a recorded yes counts)' : ' (opt-out: everyone but the withdrawals)'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="What The Register Is Built On"
        subtitle="Every basis in use, so nobody has to assume that granted means somebody asked">
        {bases.length === 0
          ? <div style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>Nothing has been recorded yet.</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                    <th style={th}>Purpose</th><th style={th}>Basis</th>
                    <th style={thNum}>Records</th><th style={th}>First</th><th style={th}>Most Recent</th>
                  </tr>
                </thead>
                <tbody>
                  {bases.map((b, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={td}>{b.purpose}</td>
                      <td style={td}>
                        {b.basis}
                        {b.basis.startsWith('inferred') && (
                          <span style={{ color: AMBER, fontSize: TEXT.xs, marginLeft: SP[2] }}>
                            inferred, not asked
                          </span>
                        )}
                      </td>
                      <td style={tdNum}>{fmtNum(b.rows_recorded)}</td>
                      <td style={td}>{b.first_recorded ? fmtDatetime(b.first_recorded) : '—'}</td>
                      <td style={td}>{b.last_recorded ? fmtDatetime(b.last_recorded) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </SectionCard>

      <BulkImport open={importOpen} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void load() }} />
    </Page>
  )
}

// ── Bulk import ───────────────────────────────────────────────────────────────

function BulkImport({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [purpose, setPurpose] = useState('marketing')
  const [channel, setChannel] = useState('email')
  const [state, setState] = useState('granted')
  const [basis, setBasis] = useState('')
  const [evidence, setEvidence] = useState('')
  const [ids, setIds] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const partyIds = ids.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0)
  const needsConfirm = purpose === 'marketing' && state === 'granted'
  const ready = partyIds.length > 0 && (!needsConfirm || confirm === 'I HAVE THE EVIDENCE')

  const submit = async () => {
    setBusy(true)
    try {
      const r = await apiPost('/api/compliance/consent/import', {
        party_ids: partyIds, purpose, channel, state, basis, evidence, confirm,
      })
      toast.success(`${fmtNum(r?.recorded ?? 0)} recorded${r?.not_a_customer ? `, ${fmtNum(r.not_a_customer)} were not customers` : ''}`)
      onDone()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not record this batch')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record Consent In Bulk" width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!ready || busy}>
            {busy ? 'Recording…' : `Record ${fmtNum(partyIds.length)}`}
          </Button>
        </>
      }>
      <div style={{ display: 'grid', gap: SP[3] }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          One basis and one piece of evidence covers the whole batch. If these people did not
          all agree in the same way, they belong in separate batches.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[2] }}>
          <Select label="Purpose" value={purpose} onChange={e => setPurpose(e.target.value)}>
            <option value="marketing">Marketing</option>
            <option value="servicing">Servicing</option>
          </Select>
          <Select label="Channel" value={channel} onChange={e => setChannel(e.target.value)}>
            {CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select label="Answer" value={state} onChange={e => setState(e.target.value)}>
            <option value="granted">Granted</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="pending">Pending</option>
          </Select>
        </div>
        <Input label="Basis" placeholder="signup_form, call_confirmation, contract_clause_8"
          value={basis} onChange={e => setBasis(e.target.value)}
          hint={needsConfirm ? 'Required for a marketing yes: how did they give it?' : undefined} />
        <Input label="Evidence" placeholder="Onboarding form batch 2026-09, scanned to DMS/consent/2026-09"
          value={evidence} onChange={e => setEvidence(e.target.value)}
          hint={needsConfirm ? 'Required. Name the form, call or document, not the answer.' : undefined} />
        <Textarea label="Customer IDs" rows={6} value={ids} onChange={e => setIds(e.target.value)}
          placeholder="Paste party IDs, separated by spaces, commas or new lines"
          hint={`${fmtNum(partyIds.length)} recognised`} />
        {needsConfirm && (
          <div style={{ border: `1px solid ${AMBER}55`, background: `${AMBER}0d`, borderRadius: RADIUS.md, padding: SP[3] }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt1)', marginBottom: SP[2] }}>
              You are recording that {fmtNum(partyIds.length)} people agreed to marketing contact.
              This is the document that makes those messages lawful. Type <strong>I HAVE THE EVIDENCE</strong> to continue.
            </div>
            <Input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="I HAVE THE EVIDENCE" />
          </div>
        )}
      </div>
    </Modal>
  )
}

const th: React.CSSProperties = { padding: `${SP[2]} ${SP[2]}`, fontWeight: FW.medium, whiteSpace: 'nowrap' }
const thNum: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: `${SP[2]} ${SP[2]}`, color: 'var(--txt1)' }
const tdNum: React.CSSProperties = { ...td, textAlign: 'right' }
