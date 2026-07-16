import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Tabs } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, SORA, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactProfileData {
  cif: string
  name: string
  phone: string
  email: string
  bvn?: string
  nin?: string
  address?: string
  state?: string
  employer?: string
  monthly_income_kobo?: number
  date_of_birth?: string
  gender?: string

  is_prospect: boolean
  is_applicant: boolean
  is_active_customer: boolean
  is_card_holder: boolean
  is_delinquent: boolean
  is_in_recovery: boolean
  is_written_off: boolean

  crm?: {
    contact_id: number
    status: string
    assigned_to: string
    created_at: string
    deals: { id: number; title: string; value_kobo: number; stage: string }[]
    activities: { id: number; type: string; note: string; created_at: string; user: string }[]
  }

  applications: {
    id: number
    ref: string
    product_type: string
    amount_requested_kobo: number
    stage: string
    created_at: string
  }[]

  active_loans: {
    id: number
    ref: string
    product_type: string
    outstanding_kobo: number
    disbursed_kobo: number
    dpd: number
    status: string
    next_payment_date: string | null
  }[]

  cards: {
    id: number
    card_number_masked: string
    scheme: string
    status: string
    balance_kobo: number
    issued_at: string
  }[]

  collections?: {
    dpd: number
    dpd_bucket: string
    outstanding_kobo: number
    last_contact_at: string | null
    agent_name: string | null
    ptp_date: string | null
    current_stage: string | null
  }

  recovery_case?: {
    id: number
    case_ref: string
    status: string
    outstanding_kobo: number
    recovered_kobo: number
    write_off_amount_kobo: number
    legal_stage: string | null
    agent_name: string | null
    opened_at: string
  }

  helpdesk_tickets: {
    id: number
    ticket_ref: string
    subject: string
    status: string
    priority: string
    created_at: string
  }[]

  activity_log: {
    id: number
    type: string
    description: string
    created_by: string
    created_at: string
    module: string
  }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODULE_COLOUR: Record<string, string> = {
  crm: BLUE, los: NAVY, cards: PURPLE, collections: AMBER,
  recovery: RED, helpdesk: '#0891B2', system: '#6B7280',
}

function statusColour(status: string): string {
  const s = status.toLowerCase()
  if (['active', 'approved', 'disbursed', 'open', 'customer'].includes(s)) return GREEN
  if (['delinquent', 'blocked', 'written_off', 'closed_bad'].includes(s)) return RED
  if (['pending', 'in_progress', 'recovery', 'prospect'].includes(s)) return AMBER
  return '#6B7280'
}

function Badge({ label, colour, outline }: { label: string; colour: string; outline?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 9px', borderRadius: RADIUS.xl,
      fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: SORA,
      background: outline ? 'transparent' : `${colour}18`,
      color: colour,
      border: `1.5px solid ${colour}40`,
    }}>
      {label}
    </span>
  )
}

function InfoPair({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (!value && value !== 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: TEXT.base, marginBottom: 6 }}>
      <span style={{ color: 'var(--txt2)', minWidth: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--txt)', fontFamily: mono ? 'var(--font-mono)' : undefined, fontWeight: mono ? FW.semibold : FW.normal }}>
        {value}
      </span>
    </div>
  )
}

function StagePill({ stage }: { stage: string }) {
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const colour = statusColour(stage)
  return <Badge label={label} colour={colour} />
}

// ── Lifecycle bar ─────────────────────────────────────────────────────────────

const LIFECYCLE_STEPS = [
  { key: 'is_prospect',       label: 'Prospect',   icon: 'person_search' },
  { key: 'is_applicant',      label: 'Applicant',  icon: 'description' },
  { key: 'is_active_customer',label: 'Customer',   icon: 'how_to_reg' },
  { key: 'is_card_holder',    label: 'Card Holder',icon: 'credit_card' },
  { key: 'is_delinquent',     label: 'Delinquent', icon: 'warning' },
  { key: 'is_in_recovery',    label: 'Recovery',   icon: 'gavel' },
  { key: 'is_written_off',    label: 'Written Off',icon: 'do_not_disturb_on' },
] as const

function LifecycleBar({ profile }: { profile: ContactProfileData }) {
  const STEP_COLOUR: Record<string, string> = {
    is_prospect: BLUE, is_applicant: '#8B5CF6', is_active_customer: GREEN,
    is_card_holder: PURPLE, is_delinquent: AMBER, is_in_recovery: RED, is_written_off: '#6B7280',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', padding: '14px 20px', background: 'var(--card)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)' }}>
      {LIFECYCLE_STEPS.map((step, i) => {
        const active = profile[step.key as keyof ContactProfileData] as boolean
        const colour = active ? STEP_COLOUR[step.key] : 'var(--txt3)'
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <div style={{ width: 20, height: 1.5, background: active ? colour : 'var(--bdr)', flexShrink: 0 }} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '0 6px' }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                background: active ? colour : 'var(--th-bg)',
                border: `2px solid ${active ? colour : 'var(--bdr)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15, color: active ? '#fff' : 'var(--txt3)' }}>
                  {step.icon}
                </span>
              </div>
              <span style={{ fontSize: TEXT['2xs'], fontWeight: active ? FW.bold : FW.normal, color: active ? colour : 'var(--txt3)', whiteSpace: 'nowrap' }}>
                {step.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Tab content panels ────────────────────────────────────────────────────────

function OverviewTab({ profile }: { profile: ContactProfileData }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <SectionCard title="Identity">
        <InfoPair label="Full Name"      value={profile.name} />
        <InfoPair label="Phone"          value={profile.phone} />
        <InfoPair label="Email"          value={profile.email} />
        <InfoPair label="Gender"         value={profile.gender} />
        <InfoPair label="Date of Birth"  value={profile.date_of_birth ? fmtDate(profile.date_of_birth) : undefined} />
        <InfoPair label="CIF"            value={profile.cif} mono />
        <InfoPair label="BVN"            value={profile.bvn} mono />
        <InfoPair label="NIN"            value={profile.nin} mono />
      </SectionCard>

      <SectionCard title="Employment &amp; Address">
        <InfoPair label="Employer"        value={profile.employer} />
        <InfoPair label="Monthly Income"  value={profile.monthly_income_kobo != null ? fmtKobo(profile.monthly_income_kobo) : undefined} />
        <InfoPair label="State"           value={profile.state} />
        <InfoPair label="Address"         value={profile.address} />
      </SectionCard>

      {profile.crm && (
        <SectionCard title="CRM Record">
          <InfoPair label="Status"       value={profile.crm.status.replace(/_/g,' ')} />
          <InfoPair label="Assigned To"  value={profile.crm.assigned_to} />
          <InfoPair label="Since"        value={fmtDate(profile.crm.created_at)} />
          {profile.crm.deals.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Deals</div>
              {profile.crm.deals.map(d => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--bdr)', fontSize: TEXT.sm }}>
                  <span style={{ color: 'var(--txt)' }}>{d.title}</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={NUM}>{fmtKobo(d.value_kobo)}</span>
                    <StagePill stage={d.stage} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {(profile.collections || profile.recovery_case) && (
        <SectionCard title="Risk Snapshot">
          {profile.collections && (
            <>
              <InfoPair label="DPD" value={`${profile.collections.dpd}d (${profile.collections.dpd_bucket})`} />
              <InfoPair label="Outstanding" value={fmtKobo(profile.collections.outstanding_kobo)} />
              <InfoPair label="Collections Agent" value={profile.collections.agent_name ?? 'Unassigned'} />
              {profile.collections.ptp_date && <InfoPair label="PTP Date" value={fmtDate(profile.collections.ptp_date)} />}
            </>
          )}
          {profile.recovery_case && (
            <>
              <InfoPair label="Case Ref"   value={profile.recovery_case.case_ref} mono />
              <InfoPair label="Status"     value={profile.recovery_case.status} />
              <InfoPair label="Recovered"  value={fmtKobo(profile.recovery_case.recovered_kobo)} />
              {profile.recovery_case.legal_stage && <InfoPair label="Legal Stage" value={profile.recovery_case.legal_stage} />}
            </>
          )}
        </SectionCard>
      )}
    </div>
  )
}

function LoansTab({ profile }: { profile: ContactProfileData }) {
  const hasContent = profile.applications.length > 0 || profile.active_loans.length > 0
  if (!hasContent) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No loan applications or active loans found.</div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {profile.active_loans.length > 0 && (
        <SectionCard title="Active Loans">
          {profile.active_loans.map(l => (
            <div key={l.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{l.ref}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{l.product_type}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: l.dpd > 0 ? RED : 'var(--txt)' }}>
                  {fmtKobo(l.outstanding_kobo)}
                </div>
                {l.dpd > 0 && (
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED, marginBottom: 2 }}>{l.dpd}d DPD</div>
                )}
                <StagePill stage={l.status} />
              </div>
            </div>
          ))}
        </SectionCard>
      )}
      {profile.applications.length > 0 && (
        <SectionCard title="Applications">
          {profile.applications.map(a => (
            <div key={a.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{a.ref}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.product_type} · {fmtDate(a.created_at)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>
                  {fmtKobo(a.amount_requested_kobo)}
                </div>
                <StagePill stage={a.stage} />
              </div>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  )
}

function CardsTab({ profile }: { profile: ContactProfileData }) {
  if (profile.cards.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No cards found for this customer.</div>
  )
  const schemeIcon: Record<string, string> = { Visa: '💳', Mastercard: '💳', Verve: '💳' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {profile.cards.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'var(--card)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: TEXT['3xl'] }}>{schemeIcon[c.scheme] ?? '💳'}</span>
            <div>
              <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{c.card_number_masked}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{c.scheme} · Issued {fmtDate(c.issued_at)}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 4 }}>{fmtKobo(c.balance_kobo)}</div>
            <Badge label={c.status} colour={statusColour(c.status)} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CollectionsTab({ profile }: { profile: ContactProfileData }) {
  const c = profile.collections
  if (!c) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No collections record for this customer.</div>
  )
  const dpdColour = c.dpd >= 90 ? '#7F1D1D' : c.dpd >= 60 ? RED : c.dpd >= 30 ? '#EA580C' : c.dpd > 0 ? AMBER : GREEN
  return (
    <SectionCard title="Collections Status">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'DPD', value: `${c.dpd}d`, colour: dpdColour },
          { label: 'Bucket', value: c.dpd_bucket, colour: dpdColour },
          { label: 'Outstanding', value: fmtKobo(c.outstanding_kobo), colour: 'var(--txt)' },
          { label: 'Stage', value: c.current_stage ?? '—', colour: 'var(--txt)' },
        ].map(({ label, value, colour }) => (
          <div key={label} style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: colour }}>{value}</div>
          </div>
        ))}
      </div>
      <InfoPair label="Assigned Agent"  value={c.agent_name ?? 'Unassigned'} />
      <InfoPair label="Last Contact"    value={c.last_contact_at ? fmtDate(c.last_contact_at) : 'Never'} />
      <InfoPair label="PTP Date"        value={c.ptp_date ? fmtDate(c.ptp_date) : undefined} />
    </SectionCard>
  )
}

function RecoveryTab({ profile }: { profile: ContactProfileData }) {
  const r = profile.recovery_case
  if (!r) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No recovery case found.</div>
  )
  const net = r.outstanding_kobo - r.recovered_kobo
  return (
    <SectionCard title="Recovery Case">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Outstanding', value: fmtKobo(r.outstanding_kobo), colour: RED },
          { label: 'Recovered',   value: fmtKobo(r.recovered_kobo),   colour: GREEN },
          { label: 'Net',         value: fmtKobo(net),                  colour: net > 0 ? RED : GREEN },
        ].map(({ label, value, colour }) => (
          <div key={label} style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: colour }}>{value}</div>
          </div>
        ))}
      </div>
      <InfoPair label="Case Ref"     value={r.case_ref} mono />
      <InfoPair label="Status"       value={r.status} />
      <InfoPair label="Assigned To"  value={r.agent_name ?? 'Unassigned'} />
      {r.legal_stage && <InfoPair label="Legal Stage" value={r.legal_stage} />}
      {r.write_off_amount_kobo > 0 && <InfoPair label="Written Off" value={fmtKobo(r.write_off_amount_kobo)} />}
      <InfoPair label="Opened"       value={fmtDate(r.opened_at)} />
    </SectionCard>
  )
}

function HelpdeskTab({ profile }: { profile: ContactProfileData }) {
  const navigate = useNavigate()
  if (profile.helpdesk_tickets.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No helpdesk tickets found.</div>
  )
  const priorityColour: Record<string, string> = { high: RED, medium: AMBER, low: GREEN, critical: '#7F1D1D' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {profile.helpdesk_tickets.map(t => (
        <div
          key={t.id}
          onClick={() => navigate(`/helpdesk/tickets/${t.id}`)}
          style={{ padding: '12px 16px', background: 'var(--card)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--card)' }}
        >
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{t.subject}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{t.ticket_ref} · {fmtDate(t.created_at)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Badge label={t.priority} colour={priorityColour[t.priority] ?? AMBER} />
            <Badge label={t.status} colour={statusColour(t.status)} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ActivityTab({ profile }: { profile: ContactProfileData }) {
  if (profile.activity_log.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No activity recorded yet.</div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {profile.activity_log.map((a, i) => (
        <div key={a.id} style={{ display: 'flex', gap: 14, paddingBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{
              width: 28, height: 28, borderRadius: RADIUS.full, flexShrink: 0,
              background: `${MODULE_COLOUR[a.module] ?? '#6B7280'}18`,
              border: `2px solid ${MODULE_COLOUR[a.module] ?? '#6B7280'}40`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.base, color: MODULE_COLOUR[a.module] ?? '#6B7280' }}>
                {a.module === 'crm' ? 'handshake' : a.module === 'los' ? 'description' : a.module === 'helpdesk' ? 'support_agent' : a.module === 'collections' ? 'phone_in_talk' : a.module === 'recovery' ? 'gavel' : 'history'}
              </span>
            </div>
            {i < profile.activity_log.length - 1 && (
              <div style={{ width: 2, flex: 1, marginTop: 4, background: 'var(--bdr)', minHeight: 16 }} />
            )}
          </div>
          <div style={{ flex: 1, paddingTop: 2 }}>
            <div style={{ fontSize: TEXT.base, color: 'var(--txt)', marginBottom: 2 }}>{a.description}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              {a.created_by} · {fmtDate(a.created_at)}
              <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: RADIUS.md, background: `${MODULE_COLOUR[a.module] ?? '#6B7280'}14`, color: MODULE_COLOUR[a.module] ?? '#6B7280', fontSize: TEXT['2xs'], fontWeight: FW.semibold }}>
                {a.module}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Status badges for header ──────────────────────────────────────────────────

function LifecycleBadges({ profile }: { profile: ContactProfileData }) {
  const badges: { label: string; colour: string }[] = []
  if (profile.is_written_off)    badges.push({ label: 'Written Off', colour: '#6B7280' })
  else if (profile.is_in_recovery) badges.push({ label: 'Recovery',  colour: RED })
  else if (profile.is_delinquent)  badges.push({ label: 'Delinquent', colour: AMBER })
  if (profile.is_active_customer) badges.push({ label: 'Active Customer', colour: GREEN })
  if (profile.is_card_holder)    badges.push({ label: 'Card Holder', colour: PURPLE })
  if (profile.is_applicant)      badges.push({ label: 'Applicant', colour: '#8B5CF6' })
  if (profile.is_prospect && badges.length === 0) badges.push({ label: 'Prospect', colour: BLUE })

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {badges.map(b => <Badge key={b.label} label={b.label} colour={b.colour} />)}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'overview',    label: 'Overview' },
  { key: 'loans',       label: 'Loans & Applications' },
  { key: 'cards',       label: 'Cards' },
  { key: 'collections', label: 'Collections' },
  { key: 'recovery',    label: 'Recovery' },
  { key: 'helpdesk',    label: 'Helpdesk' },
  { key: 'activity',    label: 'Activity' },
]

export default function ContactProfile() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [profile, setProfile] = useState<ContactProfileData | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [tab, setTab]           = useState('overview')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setError(null)
    try {
      const data = await apiFetch<ContactProfileData>(`/api/contacts/${id}`)
      setProfile(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <Page title="Contact Profile">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spinner size={32} />
      </div>
    </Page>
  )

  if (error || !profile) return (
    <Page title="Contact Profile">
      <ErrBanner error={error ?? 'Profile not found'} onRetry={load} />
    </Page>
  )

  return (
    <Page
      title={profile.name}
      subtitle={profile.cif}
      actions={
        <button
          onClick={() => navigate(-1)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer', fontFamily: SORA }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
          Back
        </button>
      }
    >
      {/* Header card */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: `${SP[5]} ${SP[6]}`, marginBottom: SP[4], display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Avatar */}
        <div style={{
          width: 56, height: 56, borderRadius: RADIUS.full, flexShrink: 0,
          background: `${NAVY}18`, border: `2px solid ${NAVY}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: NAVY }}>person</span>
        </div>

        {/* Name + meta */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: SORA }}>{profile.name}</h1>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.semibold }}>{profile.cif}</span>
          </div>
          <LifecycleBadges profile={profile} />
          <div style={{ marginTop: 10, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {profile.phone && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.base, color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>
                {profile.phone}
              </span>
            )}
            {profile.email && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.base, color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>mail</span>
                {profile.email}
              </span>
            )}
            {profile.state && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.base, color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>location_on</span>
                {profile.state}
              </span>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <a
            href={`tel:${profile.phone}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: GREEN, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', textDecoration: 'none', fontFamily: SORA }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>
            Call
          </a>
          <button
            onClick={() => navigate(`/helpdesk/tickets/new?cif=${profile.cif}&name=${encodeURIComponent(profile.name)}`)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: NAVY, border: `1.5px solid ${NAVY}30`, borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add_comment</span>
            Open Ticket
          </button>
        </div>
      </div>

      {/* Lifecycle bar */}
      <div style={{ marginBottom: 20 }}>
        <LifecycleBar profile={profile} />
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: 16 }}>
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
      </div>

      {tab === 'overview'    && <OverviewTab    profile={profile} />}
      {tab === 'loans'       && <LoansTab       profile={profile} />}
      {tab === 'cards'       && <CardsTab       profile={profile} />}
      {tab === 'collections' && <CollectionsTab profile={profile} />}
      {tab === 'recovery'    && <RecoveryTab    profile={profile} />}
      {tab === 'helpdesk'    && <HelpdeskTab    profile={profile} />}
      {tab === 'activity'    && <ActivityTab    profile={profile} />}
    </Page>
  )
}
