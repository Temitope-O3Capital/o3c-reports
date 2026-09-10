import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, Modal, Spinner } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKoboExact, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, BLUE, NUM } from '../../lib/design'

// ── Tier vocabulary (mirrors the backend's 5 bands) ────────────────────────────
type Tier = 'none' | 'minimal' | 'partial' | 'substantial' | 'cleared'
const TIER_META: Record<Tier, { label: string; range: string; color: string }> = {
  none:        { label: 'None',        range: '0% paid',    color: RED },
  minimal:     { label: 'Minimal',     range: '1–24%',      color: '#E8590C' },
  partial:     { label: 'Partial',     range: '25–74%',     color: AMBER },
  substantial: { label: 'Substantial', range: '75–99%',     color: BLUE },
  cleared:     { label: 'Cleared',     range: '100%',       color: GREEN },
}
const TIER_ORDER: Tier[] = ['none', 'minimal', 'partial', 'substantial', 'cleared']

interface TierRow {
  cif: string
  customer_name: string
  product: string
  origin: string
  reference: string
  principal_kobo: number
  outstanding_kobo: number
  paid_kobo: number
  pct_paid: number
  dpd: number
  tier: Tier
  restructure_eligible: boolean
}
interface TierSummary {
  tier: Tier
  loans: number
  outstanding_kobo: number
  paid_kobo: number
  delinquent: number
}

function TierBadge({ tier }: { tier: Tier }) {
  const m = TIER_META[tier]
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS.full, background: `${m.color}18`, color: m.color, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

function PctBar({ pct, color }: { pct: number; color: string }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--bg2)', overflow: 'hidden' }}>
        <div style={{ width: `${w}%`, height: '100%', background: color }} />
      </div>
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, minWidth: 42, textAlign: 'right' }}>{pct}%</span>
    </div>
  )
}

export default function PaymentTiers() {
  const navigate = useNavigate()
  const [rows, setRows]       = useState<TierRow[]>([])
  const [summary, setSummary] = useState<TierSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [search, setSearch]   = useState('')
  const [fTier, setFTier]     = useState<Set<string>>(new Set())
  const [delinquentOnly, setDelinquentOnly] = useState(false)
  const [restructure, setRestructure] = useState<TierRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const p = new URLSearchParams()
      if (search) p.set('q', search)
      if (fTier.size) p.set('tier', [...fTier].join(','))
      if (delinquentOnly) p.set('delinquent', 'true')
      // The handler returns {data: rows, summary: [...]} but respond() wraps everything
      // in another {data: …}, so the real payload sits at res.data.
      const res = await apiFetch<{ data: { data: TierRow[]; summary: TierSummary[] } }>(`/api/collections/payment-tiers?${p.toString()}`)
      const payload = res?.data ?? { data: [], summary: [] }
      setRows(Array.isArray(payload.data) ? payload.data : [])
      setSummary(Array.isArray(payload.summary) ? payload.summary : [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    } finally { setLoading(false) }
  }, [search, fTier, delinquentOnly])

  useEffect(() => { load() }, [load])

  const byTier = useMemo(() => {
    const m: Record<string, TierSummary> = {}
    for (const s of summary) m[s.tier] = s
    return m
  }, [summary])

  const cols: TableCol<TierRow>[] = [
    {
      key: 'customer_name', label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.customer_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.cif} · {r.product || '—'}</div>
        </div>
      ),
    },
    {
      key: 'origin', label: 'Source', sortable: true,
      render: r => {
        const meta: Record<string, { color: string; title: string }> = {
          CCS:      { color: BLUE,  title: 'From the CCS card system' },
          Udara:    { color: GREEN, title: 'From the Udara core banking system' },
          Uploaded: { color: AMBER, title: 'Uploaded from a spreadsheet' },
        }
        const m = meta[r.origin] ?? { color: NAVY, title: r.origin }
        return <span title={m.title} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 7px', borderRadius: RADIUS['2xl'], background: `${m.color}18`, color: m.color, whiteSpace: 'nowrap' }}>{r.origin || '—'}</span>
      },
    },
    { key: 'principal_kobo', label: 'Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtKoboExact(r.principal_kobo)}</span> },
    { key: 'paid_kobo', label: 'Repaid', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: r.paid_kobo > 0 ? GREEN : 'var(--txt3)' }}>{fmtKoboExact(r.paid_kobo)}</span> },
    { key: 'pct_paid', label: '% Repaid', align: 'right', sortable: true, render: r => <PctBar pct={r.pct_paid} color={TIER_META[r.tier].color} /> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'dpd', label: 'DPD', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: r.dpd > 90 ? RED : r.dpd > 0 ? AMBER : 'var(--txt3)' }}>{r.dpd}</span> },
    { key: 'tier', label: 'Tier', render: r => <TierBadge tier={r.tier} /> },
    {
      key: 'restructure_eligible', label: '',
      render: r => r.restructure_eligible
        ? <button onClick={e => { e.stopPropagation(); setRestructure(r) }} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '3px 10px', borderRadius: RADIUS.sm, border: `1px solid ${BLUE}40`, background: `${BLUE}0E`, color: BLUE, cursor: 'pointer', whiteSpace: 'nowrap' }}>Offer Restructure</button>
        : null,
    },
  ]

  return (
    <Page title="Payment Tiers" subtitle="Cards and loans (CCS, Udara, uploaded) banded by how much has been repaid — so real payers aren't treated like non-payers" loading={loading && rows.length === 0} skeletonKpis={5}>
      <ErrBanner error={error} onRetry={load} />

      {/* Tier distribution strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        {TIER_ORDER.map(t => {
          const s = byTier[t]
          const m = TIER_META[t]
          return (
            <KpiCard
              key={t}
              label={`${m.label} · ${m.range}`}
              value={fmtNum(s?.loans ?? 0)}
              sub={s ? `${fmtKoboExact(s.outstanding_kobo)} · ${fmtNum(s.delinquent)} delinquent` : undefined}
              accent={m.color}
              loading={loading && !summary.length}
            />
          )
        })}
      </div>

      <SectionCard title="Loan Book by Payment Tier" padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            { key: 'tier', label: 'TIER', options: TIER_ORDER.map(t => ({ value: t, label: TIER_META[t].label, color: TIER_META[t].color })), selected: fTier, onChange: setFTier },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFTier(new Set()); setDelinquentOnly(false) }}
          onApply={load}
          resultCount={rows.length} totalCount={rows.length}
          placeholder="Search name or CIF…"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `${SP[2]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm, color: 'var(--txt2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={delinquentOnly} onChange={e => setDelinquentOnly(e.target.checked)} />
            Delinquent only (DPD &gt; 0)
          </label>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>
            Restructure is offered to delinquent Partial / Substantial payers.
          </span>
        </div>
        <DataTable
          cols={cols} rows={rows}
          keyFn={r => r.reference || r.cif}
          loading={loading} skeletonRows={12}
          onRowClick={r => navigate(`/customers/${encodeURIComponent(r.cif)}`)}
          emptyText="No loans match"
        />
      </SectionCard>

      <RestructureModal row={restructure} onClose={() => setRestructure(null)} onDone={() => { setRestructure(null); load() }} />
    </Page>
  )
}

// ── Restructure request modal → credit_accommodations (kind=restructure) ────────
function RestructureModal({ row, onClose, onDone }: { row: TierRow | null; onClose: () => void; onDone: () => void }) {
  const [tenor, setTenor]         = useState('')
  const [rate, setRate]           = useState('')
  const [installment, setInstallment] = useState('')
  const [maturity, setMaturity]   = useState('')
  const [reason, setReason]       = useState('')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  useEffect(() => {
    // Reset when a different row opens the modal.
    setTenor(''); setRate(''); setInstallment(''); setMaturity(''); setReason(''); setErr(null)
  }, [row?.reference])

  if (!row) return null

  async function submit() {
    if (!row) return
    if (!reason.trim()) { setErr('A reason is required'); return }
    setSaving(true); setErr(null)
    try {
      const body: Record<string, any> = {
        cif: row.cif,
        account_ref: row.reference,
        kind: 'restructure',
        reason: reason.trim(),
      }
      const t = parseInt(tenor, 10);       if (t > 0) body.new_tenor_months = t
      const rt = parseFloat(rate);         if (rt > 0) body.new_rate_bps = Math.round(rt * 100)
      const inst = parseFloat(installment.replace(/,/g, '')); if (inst > 0) body.new_installment_kobo = Math.round(inst * 100)
      if (maturity) body.new_maturity_date = maturity
      await apiPost('/api/credit-accommodations', body)
      toast.success('Restructure requested — pending approval')
      onDone()
    } catch (e: any) { setErr(e.message ?? 'Failed') } finally { setSaving(false) }
  }

  const lbl: CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginBottom: 4, display: 'block' }
  const fld: CSSProperties = { width: '100%', height: 36, padding: '0 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit' }

  return (
    <Modal open={!!row} onClose={onClose} title="Request Restructure" width={500}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', padding: `${SP[2]} ${SP[3]}`, background: 'var(--bg2)', borderRadius: RADIUS.md }}>
          <strong>{row.customer_name}</strong> · {row.cif}<br />
          Outstanding {fmtKoboExact(row.outstanding_kobo)} · {row.pct_paid}% repaid · DPD {row.dpd}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={lbl}>New tenor (months)</label><input value={tenor} onChange={e => setTenor(e.target.value)} inputMode="numeric" placeholder="e.g. 12" style={fld} /></div>
          <div><label style={lbl}>New rate (% p.a.)</label><input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" placeholder="e.g. 24" style={fld} /></div>
          <div><label style={lbl}>New installment (₦)</label><input value={installment} onChange={e => setInstallment(e.target.value)} inputMode="decimal" placeholder="optional" style={fld} /></div>
          <div><label style={lbl}>New maturity date</label><input type="date" value={maturity} onChange={e => setMaturity(e.target.value)} style={fld} /></div>
        </div>
        <div>
          <label style={lbl}>Reason *</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Why this borrower should be restructured rather than pushed to recovery…" style={{ ...fld, height: 'auto', padding: 10, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={saving} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}Request Restructure
          </button>
          <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}
