// The offer letter, as Phoenix holds it.
//
// The workspace already had an offer panel, but it recorded only what a workspace
// user typed — a private note about an offer, unconnected to the document the
// customer actually received. Phoenix generates the Offer when a request is
// approved, freezes the terms at that moment, versions it, sends it, and expires it
// after the tenant's window. This shows that record.
//
// Accept and decline are absent on purpose. Phoenix exposes them only on
// /v1/portal/offers/{id}/accept|decline behind a staff JWT, with no machine
// equivalent, so an API-key integration cannot record the customer's answer. Rather
// than show a button that would fail, the panel says where the action lives.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE } from '../../lib/design'
import { toast } from 'sonner'
import { Spinner } from '../../components/UI'

export interface PhoenixOffer {
  id: string
  reference: string
  version: number
  status: string
  currency: string
  offered_amount_minor: number | null
  offered_limit_minor: number | null
  tenor_months: number | null
  interest_rate_bps: number | null
  generated_at: string | null
  expires_at: string | null
  sent_at: string | null
  viewed_at: string | null
  accepted_at: string | null
  declined_at: string | null
  decline_reason: string | null
  expired_at: string | null
}

// Phoenix's OfferStatus, with the two it declares but never writes marked as such.
// SUPERSEDED is declared in models.go and documented as set by GenerateOffer, but no
// code path assigns it; VIEWED is only reachable by a direct database write because
// ViewOffer has no HTTP caller. Both are handled anyway — the day Phoenix starts
// writing them, this should render them rather than fall through to a grey pill.
const OFFER_STATUS: Record<string, { label: string; tone: string; hint: string }> = {
  DRAFT:      { label: 'Draft',      tone: '#6B7280', hint: 'Generated but not yet sent to the customer.' },
  SENT:       { label: 'Sent',       tone: BLUE,      hint: 'With the customer, awaiting their answer.' },
  VIEWED:     { label: 'Viewed',     tone: BLUE,      hint: 'The customer has opened it.' },
  ACCEPTED:   { label: 'Accepted',   tone: GREEN,     hint: 'The customer accepted these terms and the credit account was activated.' },
  DECLINED:   { label: 'Declined',   tone: RED,       hint: 'The customer declined. The credit request was declined with it.' },
  EXPIRED:    { label: 'Expired',    tone: AMBER,     hint: 'The window closed before the customer answered.' },
  SUPERSEDED: { label: 'Superseded', tone: '#6B7280', hint: 'Replaced by a later version.' },
}

// An offer is live while it is still awaiting an answer. Phoenix will only accept
// or decline from SENT or VIEWED, and only before expires_at.
const LIVE = new Set(['DRAFT', 'SENT', 'VIEWED'])

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  return Math.ceil(ms / 86_400_000)
}

function Pill({ status }: { status: string }) {
  const m = OFFER_STATUS[status] ?? { label: status, tone: '#6B7280', hint: '' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20,
      fontSize: 11.5, fontWeight: 700, letterSpacing: '.02em',
      color: m.tone, background: `color-mix(in srgb, ${m.tone} 12%, transparent)`,
    }}>{m.label}</span>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className="sd-field">
      <label>{label}</label>
      <div className={`sd-val${empty ? ' is-empty' : ''}`}>{empty ? 'Not set' : value}</div>
    </div>
  )
}

export default function PhoenixOfferPanel({ appId, canAct, onRefresh }: {
  appId: number
  canAct: boolean
  onRefresh?: () => void
}) {
  const [offers, setOffers]   = useState<PhoenixOffer[] | null>(null)
  const [reason, setReason]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ data: { offers: PhoenixOffer[] | null; reason?: string } }>(`/api/los/${appId}/offers`)
      setOffers(Array.isArray(res.data?.offers) ? res.data.offers : [])
      setReason(res.data?.reason ?? null)
    } catch {
      setOffers(null)
      setReason('Phoenix could not be reached.')
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => { load() }, [load])

  async function resend(offer: PhoenixOffer) {
    setBusy(true)
    try {
      await apiPost(`/api/los/${appId}/offers/${offer.id}/resend`, {})
      toast.success(`Offer ${offer.reference} resent to the customer`)
      await load()
      onRefresh?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Phoenix rejected the resend')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="sd-panel">
        <div className="sd-panel-head"><h2>Offer letter</h2></div>
        <div className="sd-panel-body" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--txt2)', fontSize: 13 }}>
          <Spinner size={14} />Reading the offer from Phoenix…
        </div>
      </div>
    )
  }

  // No offer is a normal state for most of an application's life — Phoenix only
  // generates one at approval — so this reads as a status, not a failure.
  if (!offers || offers.length === 0) {
    return (
      <div className="sd-panel">
        <div className="sd-panel-head">
          <h2>Offer letter</h2>
          <span className="sd-panel-hint">Phoenix</span>
        </div>
        <div className="sd-panel-body" style={{ fontSize: 13, color: 'var(--txt2)', lineHeight: 1.6 }}>
          {reason
            ? reason
            : 'No offer has been generated yet. Phoenix creates one when the credit request is approved, and sends it to the customer.'}
        </div>
      </div>
    )
  }

  // Newest version first, which is the order Phoenix returns them in.
  const current = offers.find(o => LIVE.has(o.status)) ?? offers[0]
  const older = offers.filter(o => o.id !== current.id)
  const meta = OFFER_STATUS[current.status] ?? { label: current.status, tone: '#6B7280', hint: '' }
  const left = daysUntil(current.expires_at)
  const expiringSoon = LIVE.has(current.status) && left !== null && left <= 3

  return (
    <div className="sd-panel">
      <div className="sd-panel-head">
        <h2>Offer letter</h2>
        <span className="sd-panel-hint">
          {current.reference}
          {offers.length > 1 ? ` · version ${current.version} of ${offers.length}` : ''}
        </span>
      </div>

      <div className="sd-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Pill status={current.status} />
          <span style={{ fontSize: 13, color: 'var(--txt2)' }}>{meta.hint}</span>
        </div>

        {/* The window. An offer that has days left is the thing an officer is
            chasing, and one about to lapse is the thing they have to chase today. */}
        {LIVE.has(current.status) && current.expires_at && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8,
            fontSize: 13, fontWeight: 600,
            color: expiringSoon ? RED : 'var(--txt)',
            background: expiringSoon ? 'color-mix(in srgb, var(--sd-red, #C00000) 7%, transparent)' : 'var(--th-bg)',
            border: `1px solid ${expiringSoon ? 'color-mix(in srgb, #C00000 24%, transparent)' : 'var(--bdr)'}`,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>
              {expiringSoon ? 'alarm' : 'schedule'}
            </span>
            {left !== null && left > 0
              ? `Expires in ${left} day${left === 1 ? '' : 's'} — ${fmtDatetime(current.expires_at)}`
              : `Expired ${fmtDatetime(current.expires_at)}`}
          </div>
        )}

        {current.status === 'DECLINED' && current.decline_reason && (
          <div style={{ fontSize: 13, color: 'var(--txt)' }}>
            <b style={{ color: RED }}>Reason given: </b>{current.decline_reason}
          </div>
        )}

        {/* The frozen terms. Phoenix fixes these when the offer is generated, so
            they are what the customer was actually promised — not today's figures. */}
        <div className="sd-fields">
          <Field label="Amount offered" value={current.offered_amount_minor ? fmtKobo(current.offered_amount_minor) : null} />
          <Field label="Limit offered" value={current.offered_limit_minor ? fmtKobo(current.offered_limit_minor) : null} />
          <Field label="Tenor" value={current.tenor_months ? `${current.tenor_months} months` : null} />
          <Field label="Interest rate" value={current.interest_rate_bps ? `${(current.interest_rate_bps / 100).toFixed(2)}% p.a.` : null} />
          <Field label="Generated" value={current.generated_at ? fmtDatetime(current.generated_at) : null} />
          <Field label="Sent" value={current.sent_at ? fmtDatetime(current.sent_at) : null} />
          {current.accepted_at && <Field label="Accepted" value={fmtDatetime(current.accepted_at)} />}
          {current.declined_at && <Field label="Declined" value={fmtDatetime(current.declined_at)} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {canAct && LIVE.has(current.status) && current.status !== 'DRAFT' && (
            <button className="sd-btn" disabled={busy} onClick={() => resend(current)}>
              {busy ? <Spinner size={13} /> : <span className="material-symbols-rounded">forward_to_inbox</span>}
              Resend to customer
            </button>
          )}
          {older.length > 0 && (
            <button className="sd-btn" onClick={() => setShowAll(s => !s)}>
              <span className="material-symbols-rounded">{showAll ? 'expand_less' : 'history'}</span>
              {showAll ? 'Hide' : `Earlier versions (${older.length})`}
            </button>
          )}
        </div>

        {/* Say plainly where the missing action lives, rather than leaving an
            officer hunting for a button that is not here. */}
        {LIVE.has(current.status) && (
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.6, borderTop: '1px solid var(--bdr)', paddingTop: 10 }}>
            The customer's acceptance or decline is recorded in Phoenix. Phoenix does not
            expose those two actions to an integration, so they cannot be taken from here yet.
          </div>
        )}

        {showAll && older.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--bdr)', paddingTop: 12 }}>
            {older.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--txt2)' }}>
                <span style={{ fontWeight: 700, color: 'var(--txt)' }}>v{o.version}</span>
                <Pill status={o.status} />
                <span>{o.offered_amount_minor ? fmtKobo(o.offered_amount_minor) : '—'}</span>
                <span>{o.tenor_months ? `${o.tenor_months} months` : ''}</span>
                <span style={{ marginLeft: 'auto' }}>{o.generated_at ? fmtDatetime(o.generated_at) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
