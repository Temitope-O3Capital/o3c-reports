import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, KpiCard, EmptyState, Pagination } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, MONO, TEXT, FW, SP, RADIUS } from '../../lib/design'

// Retention & Win-Back — the per-customer half of churn.
//
// /growth already reports churn in aggregate. This is the working list: who is
// slipping, what they are worth, and whether they can actually be worked. It reads
// app.customer_lifecycle (migration 289), recomputed nightly at 03:30.
//
// The page deliberately leads with the WORKABLE count rather than the churned count.
// 6,539 customers have not transacted in over a year, but a list that includes people
// we cannot reach, or who are already in a recovery case, is a list an agent has to
// clean by hand every morning — so the default cut excludes both.

interface LifecycleRow {
  party_id: number
  cif: string | null
  full_name: string | null
  primary_phone: string | null
  primary_email: string | null
  bucket: string
  value_tier: string
  value_kobo: number
  lifetime_value_kobo: number
  last_txn_at: string | null
  days_since_txn: number | null
  open_products: number
  has_open_recovery: boolean
  contactable: boolean
}

interface BucketStat { bucket: string; parties: number; contactable: number; in_recovery: number; value_kobo: number }
interface TierStat { value_tier: string; parties: number; value_kobo: number }
interface Workable { workable: number; workable_kobo: number; workable_with_open_product: number; computed_at: string | null }

const PAGE_SIZE = 50

// The dormancy clock, in the order a customer travels it. 'unknown' is listed last
// and apart: it is not a stage, it is an absence of evidence.
const BUCKETS: { key: string; label: string; colour: string; hint: string }[] = [
  { key: 'active',  label: 'Active',   colour: GREEN,     hint: 'Transacted within 30 days' },
  { key: 'cooling', label: 'Cooling',  colour: '#D9A54E', hint: '31–60 days since last transaction' },
  { key: 'at_risk', label: 'At Risk',  colour: AMBER,     hint: '61–90 days — the last chance to keep them' },
  { key: 'dormant', label: 'Dormant',  colour: '#D9683C', hint: '91–180 days' },
  { key: 'lapsed',  label: 'Lapsed',   colour: '#C4472F', hint: '181–365 days' },
  { key: 'churned', label: 'Churned',  colour: RED,       hint: 'Over a year — the win-back pool' },
]
const TIERS: { key: string; label: string; colour: string }[] = [
  { key: 'vip',    label: 'VIP',    colour: '#B08D2E' },
  { key: 'gold',   label: 'Gold',   colour: '#B08D2E' },
  { key: 'silver', label: 'Silver', colour: '#8C97A3' },
  { key: 'mass',   label: 'Mass',   colour: 'var(--txt3)' },
]

// Naira from kobo, ASCII "NGN" rather than the sign — this app's money strings reach
// SMS, where the naira glyph forces UCS-2 and triples the cost of a message.
function ngn(kobo: number): string {
  const n = (kobo || 0) / 100
  if (n >= 1e9) return `NGN ${(n / 1e9).toFixed(2)}bn`
  if (n >= 1e6) return `NGN ${(n / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `NGN ${Math.round(n / 1e3)}k`
  return `NGN ${Math.round(n)}`
}

function Pill({ label, colour }: { label: string; colour: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: RADIUS.xl,
      background: `${colour}18`, color: colour, border: `1px solid ${colour}40`,
      fontSize: TEXT['2xs'], fontWeight: FW.bold, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

export default function Retention() {
  const navigate = useNavigate()
  const [buckets, setBuckets] = useState<BucketStat[]>([])
  const [tiers, setTiers] = useState<TierStat[]>([])
  const [workable, setWorkable] = useState<Workable | null>(null)
  const [rows, setRows] = useState<LifecycleRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)
  const [seeded, setSeeded] = useState<string | null>(null)

  // Defaults ARE the recommendation: the win-back pool, reachable, not already a
  // collections conversation. Everything else is an opt-in widening.
  const [bucket, setBucket] = useState('')          // '' = lapsed + churned
  const [tier, setTier] = useState('')
  const [includeRecovery, setIncludeRecovery] = useState(false)
  const [includeUnreachable, setIncludeUnreachable] = useState(false)
  const [openProductOnly, setOpenProductOnly] = useState(false)

  const loadSummary = useCallback(() => {
    apiFetch<{ buckets: BucketStat[]; tiers: TierStat[]; workable: Workable }>('/api/retention/summary')
      .then(r => { setBuckets(r.buckets ?? []); setTiers(r.tiers ?? []); setWorkable(r.workable ?? null) })
      .catch(e => setErr(e.message))
  }, [])

  const loadList = useCallback(() => {
    setLoading(true); setErr(null)
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (bucket) p.set('bucket', bucket)
    if (tier) p.set('tier', tier)
    if (includeRecovery) p.set('include_recovery', '1')
    if (includeUnreachable) p.set('include_unreachable', '1')
    if (openProductOnly) p.set('open_product', '1')
    apiFetch<{ customers: LifecycleRow[]; total: number }>(`/api/retention/customers?${p}`)
      .then(r => { setRows(r.customers ?? []); setTotal(r.total ?? 0) })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [page, bucket, tier, includeRecovery, includeUnreachable, openProductOnly])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { setPage(1) }, [bucket, tier, includeRecovery, includeUnreachable, openProductOnly])

  const byBucket = (k: string) => buckets.find(b => b.bucket === k)
  const unknown = byBucket('unknown')

  const seedQueue = useCallback(() => {
    if (!confirm(
      'Send the win-back list to the outbound dialler?\n\n' +
      'Highest-value customers first. Anyone already in a recovery case, on the ' +
      'do-not-call list, or without a usable phone is excluded.'
    )) return
    setSeeding(true); setErr(null)
    apiFetch<{ inserted: number }>('/api/retention/sync-queue', { method: 'POST' })
      .then(r => setSeeded(`${r.inserted} customer${r.inserted === 1 ? '' : 's'} added to the outbound queue`))
      .catch(e => setErr(e.message))
      .finally(() => setSeeding(false))
  }, [])

  return (
    <Page title="Retention & Win-Back" subtitle="Who is slipping away, what they are worth, and who can actually be worked"
      actions={
        <button onClick={seedQueue} disabled={seeding}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs,
            fontWeight: FW.semibold, color: '#fff', background: NAVY, border: 'none',
            borderRadius: RADIUS.md, padding: '8px 14px', cursor: seeding ? 'wait' : 'pointer',
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>call_made</span>
          {seeding ? 'Sending…' : 'Send to Dialler'}
        </button>
      }>
      {err && <ErrBanner error={err} />}
      {seeded && (
        <div style={{
          padding: '10px 14px', marginBottom: SP[4], borderRadius: RADIUS.md,
          background: `${GREEN}12`, border: `1px solid ${GREEN}40`, color: 'var(--txt2)', fontSize: TEXT.sm,
        }}>{seeded} — work it under Call Center → Queue, filtered to the Retention purpose.</div>
      )}

      {/* The headline is the WORKABLE number, not the churned one. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: SP[4], marginBottom: SP[6] }}>
        <KpiCard label="Workable for Win-Back" value={fmtNum(workable?.workable ?? 0)} accent={NAVY}
          sub="Lapsed or churned, reachable, not in recovery" />
        <KpiCard label="Value at Stake" value={ngn(workable?.workable_kobo ?? 0)} accent={RED}
          sub="Spend in their last active year" />
        <KpiCard label="Still Hold a Product" value={fmtNum(workable?.workable_with_open_product ?? 0)} accent={AMBER}
          sub="An open account to build the call on" />
        <KpiCard label="At Risk Now" value={fmtNum(byBucket('at_risk')?.parties ?? 0)} accent={AMBER}
          sub="61–90 days — still savable" />
      </div>

      {/* Coverage honesty, stated once and prominently. Without this the buckets read
          as a complete picture of the customer base, and they are not. */}
      {unknown && unknown.parties > 0 && (
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px',
          background: `${AMBER}12`, border: `1px solid ${AMBER}40`, borderLeft: `3px solid ${AMBER}`,
          borderRadius: RADIUS.md, marginBottom: SP[6], fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER, flexShrink: 0 }}>info</span>
          <span>
            <strong>{fmtNum(unknown.parties)} customers are not scored</strong> and are excluded from every
            figure on this page. We hold no transaction history for them — the ledger covers cards only,
            with no savings or current-account feed — so they are unmeasured, <em>not</em> dormant.
            Treating them as churn would be guessing.
          </span>
        </div>
      )}

      {/* The clock. Clicking a stage filters the list under it. */}
      <SectionCard title="The Dormancy Clock" subtitle="Every scored customer, by time since their last transaction">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: SP[3] }}>
          {BUCKETS.map(b => {
            const s = byBucket(b.key)
            const on = bucket === b.key
            return (
              <button key={b.key} title={b.hint}
                onClick={() => setBucket(on ? '' : b.key)}
                style={{
                  textAlign: 'left', cursor: 'pointer', padding: '12px 14px',
                  background: on ? `${b.colour}14` : 'var(--card)',
                  border: `1px solid ${on ? b.colour : 'var(--bdr)'}`,
                  borderTop: `3px solid ${b.colour}`, borderRadius: RADIUS.md,
                }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '.05em', textTransform: 'uppercase', color: b.colour }}>{b.label}</div>
                <div style={{ fontFamily: MONO, fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', marginTop: 4 }}>{fmtNum(s?.parties ?? 0)}</div>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>{ngn(s?.value_kobo ?? 0)}</div>
              </button>
            )
          })}
        </div>
      </SectionCard>

      {/* Filters. Each one widens the default rather than narrowing it, and says what
          it costs, because the defaults are the recommendation. */}
      <SectionCard title="Working List" subtitle={`${fmtNum(total)} customer${total === 1 ? '' : 's'} match`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'center', marginBottom: SP[4] }}>
          <select value={tier} onChange={e => setTier(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm }}>
            <option value="">All value tiers</option>
            {TIERS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {[
            { on: openProductOnly, set: setOpenProductOnly, label: 'Still holds an open product', hint: 'A live account gives the call something to be about' },
            { on: includeRecovery, set: setIncludeRecovery, label: 'Include customers in recovery', hint: 'These are collections conversations — working them for win-back cuts across a colleague chasing the same debt' },
            { on: includeUnreachable, set: setIncludeUnreachable, label: 'Include unreachable', hint: 'No usable phone or email, or suppressed — nothing can be done with these today' },
          ].map(c => (
            <label key={c.label} title={c.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm, color: 'var(--txt2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={c.on} onChange={e => c.set(e.target.checked)} />
              {c.label}
            </label>
          ))}
        </div>

        {loading ? <Spinner /> : rows.length === 0 ? (
          <EmptyState icon="group_off" title="Nobody matches" description="Widen the filters, or pick another stage of the clock." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr>
                  {['Customer', 'Stage', 'Tier', 'Last Active Year', 'Last Seen', 'Products', 'Reach'].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i >= 3 && i <= 5 ? 'right' : 'left', padding: '8px 12px',
                      borderBottom: '1px solid var(--bdr)', fontSize: TEXT['2xs'], fontWeight: FW.bold,
                      letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--txt3)', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const b = BUCKETS.find(x => x.key === r.bucket)
                  const t = TIERS.find(x => x.key === r.value_tier)
                  return (
                    <tr key={r.party_id}
                      onClick={() => r.cif && navigate(`/customers/${r.cif}`)}
                      style={{ cursor: r.cif ? 'pointer' : 'default', borderBottom: '1px solid var(--bdr-soft, var(--bdr))' }}>
                      <td style={{ padding: '9px 12px' }}>
                        <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.full_name || '—'}</div>
                        <div style={{ fontFamily: MONO, fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.cif || `party ${r.party_id}`}</div>
                      </td>
                      <td style={{ padding: '9px 12px' }}>{b && <Pill label={b.label} colour={b.colour} />}</td>
                      <td style={{ padding: '9px 12px' }}>{t && <Pill label={t.label} colour={t.colour} />}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>{ngn(r.value_kobo)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: 'var(--txt2)' }}>
                        {r.days_since_txn == null ? '—' : `${fmtNum(r.days_since_txn)}d`}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)' }}>{r.open_products}</td>
                      <td style={{ padding: '9px 12px' }}>
                        {r.has_open_recovery
                          ? <Pill label="In Recovery" colour={RED} />
                          : r.contactable
                            ? <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.primary_phone ? 'Phone' : 'Email'}</span>
                            : <Pill label="No Contact" colour="var(--txt3)" />}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE && (
          <Pagination page={page} pages={Math.ceil(total / PAGE_SIZE)} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        )}
      </SectionCard>

      {workable?.computed_at && (
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: SP[4], fontFamily: MONO }}>
          Scored {new Date(workable.computed_at).toLocaleString('en-NG')} · recomputed nightly at 03:30
        </div>
      )}
    </Page>
  )
}
