import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page, SectionCard, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { NAVY, GREEN, AMBER, BLUE, PURPLE, RED, FW, RADIUS, SP, TEXT, SORA, NUM } from '../../lib/design'
import { fmtKobo } from '../../lib/fmt'
import NewTicketForm, { InitialCustomer } from './NewTicket'

interface CustomerCtx {
  cif: string
  name: string
  phone?: string
  email?: string
  state?: string
  employer?: string
  cards: unknown[]
  active_loans: unknown[]
  fixed_deposits: unknown[]
  helpdesk_tickets: unknown[]
  is_delinquent?: boolean
  is_in_recovery?: boolean
  summary?: { net_position_kobo: number; loan_outstanding_kobo: number; fd_principal_kobo: number }
}

function cleanName(n?: string) {
  return (n ?? '').replace(/^[.\s]+/, '').trim()
}

function initials(name: string) {
  return (name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Right-rail customer context (shown when launched from a profile) ──────────
function CustomerRail({ ctx }: { ctx: CustomerCtx }) {
  const navigate = useNavigate()
  const name = cleanName(ctx.name) || 'Unknown customer'
  const facts: { label: string; value: string; colour: string }[] = [
    { label: 'Cards',          value: String(ctx.cards?.length ?? 0),         colour: PURPLE },
    { label: 'Active Loans',   value: String(ctx.active_loans?.length ?? 0),  colour: BLUE },
    { label: 'Fixed Deposits', value: String(ctx.fixed_deposits?.length ?? 0),colour: GREEN },
    { label: 'Open Tickets',   value: String(ctx.helpdesk_tickets?.length ?? 0), colour: AMBER },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionCard title="Customer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{
            width: 46, height: 46, borderRadius: RADIUS.full, flexShrink: 0,
            background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: TEXT.md, fontWeight: FW.extrabold, fontFamily: SORA,
          }}>{initials(name)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>CIF {ctx.cif}</div>
          </div>
        </div>

        {(ctx.is_delinquent || ctx.is_in_recovery) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '7px 10px', background: `${RED}12`, borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>warning</span>
            {ctx.is_in_recovery ? 'In recovery' : 'Delinquent'}, handle with care
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {ctx.phone    && <RailRow icon="call"        value={ctx.phone} />}
          {ctx.email    && <RailRow icon="mail"        value={ctx.email} />}
          {ctx.state    && <RailRow icon="location_on" value={ctx.state} />}
          {ctx.employer && <RailRow icon="work"        value={ctx.employer} />}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {facts.map(f => (
            <div key={f.label} style={{ padding: '9px 11px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: f.colour }}>{f.value}</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{f.label}</div>
            </div>
          ))}
        </div>

        {ctx.summary && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm }}>
            <span style={{ color: 'var(--txt2)' }}>Net position</span>
            <span style={{ ...NUM, fontWeight: FW.bold, color: ctx.summary.net_position_kobo >= 0 ? GREEN : RED }}>{fmtKobo(ctx.summary.net_position_kobo)}</span>
          </div>
        )}

        <button
          onClick={() => navigate(`/customers/${ctx.cif}`)}
          style={{ marginTop: 14, width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '8px 12px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer', fontFamily: SORA }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>open_in_new</span>
          Open full profile
        </button>
      </SectionCard>

      <TipsCard />
    </div>
  )
}

function RailRow({ icon, value }: { icon: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  )
}

function TipsCard() {
  const tips = [
    'Pick the ticket type first: the form reveals only the fields that matter for it.',
    'Mark it Urgent for anything fraud, card-block or unable-to-transact related.',
    'CBN-reportable complaints are flagged automatically for the regulatory queue.',
  ]
  return (
    <SectionCard title="Tips">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tips.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.45 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: NAVY, flexShrink: 0 }}>lightbulb</span>
            {t}
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function NewTicketPage() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const cif = params.get('cif') ?? undefined
  const qpName = params.get('name') ?? undefined
  const qpPhone = params.get('phone') ?? undefined

  const [ctx, setCtx] = useState<CustomerCtx | null>(null)
  const [ctxLoading, setCtxLoading] = useState(Boolean(cif))

  useEffect(() => {
    if (!cif) return
    let alive = true
    setCtxLoading(true)
    apiFetch<any>(`/api/contacts/${cif}`)
      .then(d => {
        if (!alive) return
        const raw = (d?.data ?? d) as CustomerCtx
        setCtx({
          ...raw,
          cards: raw.cards ?? [], active_loans: raw.active_loans ?? [],
          fixed_deposits: raw.fixed_deposits ?? [], helpdesk_tickets: raw.helpdesk_tickets ?? [],
        })
      })
      .catch(() => { if (alive) setCtx(null) })
      .finally(() => { if (alive) setCtxLoading(false) })
    return () => { alive = false }
  }, [cif])

  // Prefer the richer fetched record; fall back to whatever the URL carried.
  const initial: InitialCustomer | undefined = cif || qpName
    ? { cif, name: ctx?.name ?? qpName, phone: ctx?.phone ?? qpPhone }
    : undefined

  const hasRail = Boolean(cif)

  return (
    <Page
      title="New Support Ticket"
      subtitle="Log and route a customer issue"
      actions={
        <button
          onClick={() => nav('/helpdesk')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer', fontFamily: SORA }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
          Back to Helpdesk
        </button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: hasRail ? 'minmax(0, 1fr) 320px' : 'minmax(0, 1fr)', gap: SP[4], alignItems: 'start' }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: SP[5] }}>
          <NewTicketForm
            initial={initial}
            onClose={() => nav('/helpdesk')}
            onCreated={(id) => nav(`/helpdesk/${id}`)}
          />
        </div>

        {hasRail && (
          ctxLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>
            : ctx
              ? <CustomerRail ctx={ctx} />
              : <TipsCard />
        )}
      </div>
    </Page>
  )
}
