import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { fmtExact, fmtDate, fmtCount } from '../lib/fmt'
import { GREEN, AMBER, NUM, TEXT, FW } from '../lib/design'

// Monthly repayment cadence for one CIF — the same money-in view Customer 360 shows,
// rendered compact for the collections/recovery detail panels. Fetches its own data
// from `${endpointBase}/repayment-pattern` (mounted under both ops route groups), so a
// panel just drops it in with the account's CIF. Transaction-feed amounts are NAIRA.
//
// IDENTITY. An 8-digit key is not self-describing: the same string can be a cards CIF
// (CCS/Sage) and a Udara core-banking customer id belonging to two DIFFERENT people —
// it is true of all 44 Udara loan customer ids. Sending a bare `?cif=` and letting the
// backend guess put a stranger's transactions in front of collections officers: of 44
// Udara loan keys, 5 landed on the borrower, 10 were refused and 29 resolved to the
// cards person. The backend now resolves identity properly but needs the namespace, so
// this component passes whatever the caller knows:
//
//   partyId — the workspace Customer ID, unambiguous, always wins;
//   origin  — 'udara' for a core-banking-sourced record (Payment Tiers rows carry
//             origin='Udara'), 'cards' for a CCS-sourced one.
//
// With neither, the backend still falls back to the collections assignment / recovery
// case the key belongs to, which is what both of this component's current callers are
// open on; it refuses to guess when the key is live in both namespaces and nothing
// breaks the tie. The resolved party comes back in `identity` and is shown, so an
// officer can see whose money is on screen before acting on it.
interface PatMonth { month: string; amount: number; count: number }
interface PayItem  { date: string; amount: number; description?: string; merchant?: string }
interface Identity {
  cif?: string
  origin?: string
  resolved?: boolean
  resolved_via?: string
  party_id?: number
  party_name?: string | null
  ambiguous_key?: boolean
  cbs_candidate_party_id?: number
  cards_candidate_party_id?: number
}
interface PatternResponse {
  repayment_pattern?: PatMonth[]
  payment_history?: PayItem[]
  identity?: Identity
  has_history?: boolean
  empty_reason?: string
  empty_message?: string
}

/** Which identifier namespace the caller's key is drawn from. */
export type PatternOrigin = 'udara' | 'cards'

export function RepaymentPatternMini({ cif, endpointBase, origin, partyId }: {
  cif: string
  endpointBase: string
  /** Set when the record is core-banking-sourced ('udara') or card-sourced ('cards'). */
  origin?: PatternOrigin
  /** The workspace Customer ID, when the caller holds it — the unambiguous key. */
  partyId?: string | number | null
}) {
  const [pattern, setPattern] = useState<PatMonth[]>([])
  const [history, setHistory] = useState<PayItem[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    const qs = new URLSearchParams({ cif })
    if (origin) qs.set('origin', origin)
    if (partyId != null && String(partyId).trim() !== '') qs.set('party_id', String(partyId))
    apiFetch<{ data: PatternResponse }>(`${endpointBase}/repayment-pattern?${qs.toString()}`)
      .then(res => {
        if (!live) return
        const d = res.data
        setPattern(d?.repayment_pattern ?? [])
        setHistory(d?.payment_history ?? [])
        setIdentity(d?.identity ?? null)
        setEmptyMessage(d?.empty_message ?? null)
      })
      .catch(() => { if (live) { setPattern([]); setHistory([]); setIdentity(null); setEmptyMessage(null) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cif, endpointBase, origin, partyId])

  if (loading) {
    return <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', padding: '4px 0' }}>Loading cadence…</div>
  }

  const whose = identity?.party_name ? String(identity.party_name).trim() : ''
  // Say whose money this is whenever the backend could name them. The panel used to show
  // an unlabelled feed that was, for 29 of 44 Udara borrowers, somebody else's.
  const attribution = whose ? (
    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', paddingBottom: 6 }}>
      Showing Repayments For <span style={{ color: 'var(--txt2)', fontWeight: FW.medium }}>{whose}</span>
      {identity?.party_id ? ` · Customer ID ${identity.party_id}` : ''}
    </div>
  ) : null

  // The key is live in both namespaces. Even when it did resolve, this panel is not the
  // whole picture for the id — an officer reading it needs to know that.
  const ambiguityNote = identity?.ambiguous_key ? (
    <div style={{ display: 'flex', gap: 5, alignItems: 'flex-start', fontSize: TEXT['2xs'], color: AMBER, paddingBottom: 6, lineHeight: 1.45 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>info</span>
      <span>This ID exists in both the cards and core-banking books, for different customers.</span>
    </div>
  ) : null

  if (pattern.length === 0 && history.length === 0) {
    // "No repayments on record" and "this feed cannot see their repayments" are
    // different statements, and only the backend knows which one is true: none of the
    // 44 Udara borrowers hold a card, so the card transaction feed is silent on all of
    // them — which the old hardcoded line reported as "this borrower never paid".
    return (
      <div style={{ padding: '4px 0' }}>
        {ambiguityNote}
        {attribution}
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.45 }}>
          {emptyMessage || 'No repayment history on file.'}
        </div>
      </div>
    )
  }

  const max = Math.max(...pattern.map(x => Number(x.amount) || 0), 1)

  return (
    <div>
      {ambiguityNote}
      {attribution}
      {pattern.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 58, marginBottom: 12, paddingTop: 4 }}>
          {pattern.map((m, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
              <div
                title={`${m.month}: ${fmtExact(m.amount)} · ${fmtCount(m.count)} payment${Number(m.count) === 1 ? '' : 's'}`}
                style={{ width: '100%', height: `${Math.max(3, ((Number(m.amount) || 0) / max) * 42)}px`, background: GREEN, borderRadius: 3 }}
              />
              <span style={{ fontSize: 8, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{m.month}</span>
            </div>
          ))}
        </div>
      )}
      {history.slice(0, 6).map((p, i, arr) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px', borderBottom: i < arr.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.description || 'Repayment'}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDate(p.date)}{p.merchant ? ` · ${p.merchant}` : ''}</div>
          </div>
          <div style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: GREEN, flexShrink: 0 }}>+{fmtExact(p.amount)}</div>
        </div>
      ))}
    </div>
  )
}
