import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { Drawer } from '../../components/Drawer'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, fmtKobo } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, RED, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BDKPIs {
  employers_managed:  number
  mou_signed:         number
  mou_expiring_soon:  number
  staff_referred_mtd: number; staff_referred_lm: number
  conversions_mtd:    number; conversions_lm:    number
  calls_made_mtd:     number; calls_lm:          number
  meetings_mtd:       number; meetings_lm:       number
}

interface BDFunnel {
  staff_referred: number
  crm_contacts:   number
  applications:   number
  converted:      number
}

interface MouExpiringItem {
  id: number; name: string; sector: string
  mou_expiry: string; days_to_expiry: number
  contact_name: string; contact_email: string
}

interface StaleAssignment {
  id: number; employer_name: string
  staff_count_at_assignment: number; assigned_at: string
  days_stale: number; sales_agent_name: string; sales_agent_email: string
}

interface DormantPartnership {
  id: number; name: string; sector: string
  mou_date: string; days_since_signed: number
  contact_name: string; contact_email: string
}

interface BDEmployer {
  id: number; name: string; sector: string; staff_count: number
  mou_status: string; mou_expiry: string | null
  assignments_count: number; staff_referred: number
  contacts_created: number; converted: number
}

interface RecentAssignment {
  id: number; employer_name: string; assignment_type: string
  status: string; staff_count_at_assignment: number
  assigned_at: string; sales_agent_name: string
  contacts_created: number; converted: number
}

interface BDDash {
  kpis:               BDKPIs
  funnel_all:         BDFunnel
  funnel_mtd:         BDFunnel
  urgency:            { mou_expiring: MouExpiringItem[]; stale_assignments: StaleAssignment[]; dormant: DormantPartnership[] }
  employers:          BDEmployer[]
  recent_assignments: RecentAssignment[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mouColor(s?: string) {
  switch (s?.toLowerCase()) {
    case 'signed':      return GREEN
    case 'negotiating': return BLUE
    case 'expired':     return RED
    default:            return AMBER
  }
}

function assignStatusColor(s: string) {
  switch (s) {
    case 'converted':   return GREEN
    case 'in_progress': return BLUE
    case 'lost':        return RED
    default:            return AMBER
  }
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: `${color}18`, color,
      whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>
      {label.replace(/_/g, ' ')}
    </span>
  )
}

/** Returns % change from prev to cur, or undefined if prev is 0 */
function changePct(cur: number, prev: number): number | undefined {
  if (!prev) return undefined
  return ((cur - prev) / prev) * 100
}

function pct(num: number, denom: number) {
  if (!denom) return '—'
  return `${Math.round((num / denom) * 100)}%`
}

// ── Referral Funnel ───────────────────────────────────────────────────────────

function ReferralFunnel({ all, mtd }: { all: BDFunnel; mtd: BDFunnel }) {
  const [period, setPeriod] = useState<'all' | 'mtd'>('all')
  const f = period === 'mtd' ? mtd : all

  const steps = [
    { label: 'Staff Referred',        value: f.staff_referred, color: NAVY,  icon: 'group' },
    { label: 'CRM Contacts Created',  value: f.crm_contacts,   color: BLUE,  icon: 'contacts' },
    { label: 'Loan Applications',     value: f.applications,   color: AMBER, icon: 'description' },
    { label: 'Converted to Customer', value: f.converted,      color: GREEN, icon: 'verified_user' },
  ]
  const maxVal = Math.max(1, f.staff_referred)

  const toggle = (
    <div style={{ display: 'flex', gap: 4 }}>
      {(['all', 'mtd'] as const).map(p => (
        <button
          key={p}
          onClick={() => setPeriod(p)}
          style={{
            fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '3px 10px',
            borderRadius: RADIUS.md, border: `1px solid ${period === p ? NAVY : 'var(--bdr)'}`,
            background: period === p ? NAVY : 'transparent',
            color: period === p ? '#fff' : 'var(--txt2)',
            cursor: 'pointer',
          }}
        >
          {p === 'mtd' ? 'This Month' : 'All-time'}
        </button>
      ))}
    </div>
  )

  return (
    <SectionCard title="Referral Conversion Funnel" actions={toggle} style={{ marginBottom: SP[3] }}>
      <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
        {steps.map((step, i) => {
          const barWidth = Math.max(12, Math.round((step.value / maxVal) * 100))
          const convRate = i > 0 ? pct(step.value, steps[i - 1].value) : null
          return (
            <div key={step.label} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div style={{
                margin: '0 3px',
                background: `${step.color}10`,
                borderTop: `3px solid ${step.color}`,
                borderRadius: `${RADIUS.sm} ${RADIUS.sm} 0 0`,
                padding: '14px 12px 12px',
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                minHeight: 96,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: step.color, marginBottom: 6 }}>
                  {step.icon}
                </span>
                <span style={{ ...NUM, fontSize: 22, fontWeight: FW.bold, color: step.color, lineHeight: 1 }}>
                  {fmtNum(step.value)}
                </span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 4, lineHeight: 1.3 }}>
                  {step.label}
                </span>
              </div>
              {/* Conversion rate between steps */}
              <div style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {convRate ? (
                  <span style={{
                    fontSize: 11, fontWeight: FW.semibold,
                    fontFamily: 'var(--font-mono)', color: 'var(--txt3)',
                  }}>
                    ↓ {convRate}
                  </span>
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--txt3)' }}>Start</span>
                )}
              </div>
              {/* Proportion bar */}
              <div style={{ margin: '0 3px', height: 4, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${barWidth}%`, height: '100%', background: step.color, borderRadius: 2 }} />
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

// ── Urgency Tray ─────────────────────────────────────────────────────────────

function UrgencyCard({
  color, icon, title, children,
}: {
  color: string; icon: string; title: string; children: React.ReactNode
}) {
  return (
    <div style={{
      background: 'var(--card)',
      border: `1px solid ${color}28`,
      borderLeft: `3px solid ${color}`,
      borderRadius: RADIUS.xl,
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15, color }}>{icon}</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color }}>{title}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  )
}

function UrgencyRow({
  onClick, left, leftSub, rightMain, rightSub, action,
}: {
  onClick: () => void
  left: string; leftSub: string
  rightMain: React.ReactNode; rightSub?: string
  action?: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 7px', borderRadius: RADIUS.md,
      background: 'var(--row-hvr)',
    }}>
      <div style={{ flex: 1, cursor: 'pointer', minWidth: 0 }} onClick={onClick}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{leftSub}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold }}>{rightMain}</div>
        {rightSub && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{rightSub}</div>}
      </div>
      {action}
    </div>
  )
}

function EmailBtn({ email, subject }: { email: string; subject: string }) {
  if (!email) return null
  return (
    <a
      href={`mailto:${email}?subject=${encodeURIComponent(subject)}`}
      title={`Email ${email}`}
      onClick={e => e.stopPropagation()}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: RADIUS.md, flexShrink: 0,
        background: 'var(--card)', border: '1px solid var(--bdr)',
        color: 'var(--txt2)', textDecoration: 'none',
        transition: 'color .12s, border-color .12s',
      }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.color = BLUE; el.style.borderColor = BLUE }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.color = 'var(--txt2)'; el.style.borderColor = 'var(--bdr)' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>mail</span>
    </a>
  )
}

function UrgencyTray({
  mouExpiring, stale, dormant, onNavigate,
}: {
  mouExpiring: MouExpiringItem[]
  stale: StaleAssignment[]
  dormant: DormantPartnership[]
  onNavigate: (to: string) => void
}) {
  const cards = [mouExpiring.length > 0, stale.length > 0, dormant.length > 0].filter(Boolean).length
  if (!cards) return null

  const cols = cards === 1 ? '1fr' : cards === 2 ? '1fr 1fr' : '1fr 1fr 1fr'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, gap: SP[3], marginBottom: SP[3] }}>

      {mouExpiring.length > 0 && (
        <UrgencyCard color={RED} icon="warning" title={`MOU Expiring Soon (${mouExpiring.length})`}>
          {mouExpiring.map(item => (
            <UrgencyRow
              key={item.id}
              onClick={() => onNavigate(`/bd/employers/${item.id}`)}
              left={item.name}
              leftSub={item.sector || item.contact_name || '—'}
              rightMain={<span style={{ color: RED }}>{item.days_to_expiry === 0 ? 'Today' : `${item.days_to_expiry}d left`}</span>}
              rightSub={fmtDate(item.mou_expiry)}
              action={<EmailBtn email={item.contact_email} subject={`MOU Renewal — ${item.name}`} />}
            />
          ))}
        </UrgencyCard>
      )}

      {stale.length > 0 && (
        <UrgencyCard color={AMBER} icon="schedule" title={`Sales Not Engaged (${stale.length})`}>
          {stale.map(item => (
            <UrgencyRow
              key={item.id}
              onClick={() => onNavigate(`/bd/assignments/${item.id}`)}
              left={item.employer_name}
              leftSub={`→ ${item.sales_agent_name} · ${fmtNum(item.staff_count_at_assignment)} staff`}
              rightMain={<span style={{ color: AMBER }}>{item.days_stale}d idle</span>}
              rightSub="0 contacts created"
              action={<EmailBtn email={item.sales_agent_email} subject={`Follow-up: ${item.employer_name} assignment`} />}
            />
          ))}
        </UrgencyCard>
      )}

      {dormant.length > 0 && (
        <UrgencyCard color={PURPLE} icon="bedtime" title={`Dormant Partnerships (${dormant.length})`}>
          {dormant.map(item => (
            <UrgencyRow
              key={item.id}
              onClick={() => onNavigate(`/bd/employers/${item.id}`)}
              left={item.name}
              leftSub={`MOU signed ${item.days_since_signed}d ago — no staff referred`}
              rightMain={<span style={{ color: PURPLE }}>Unactivated</span>}
              rightSub={`Since ${fmtDate(item.mou_date)}`}
              action={<EmailBtn email={item.contact_email} subject={`Staff Referral — ${item.name}`} />}
            />
          ))}
        </UrgencyCard>
      )}

    </div>
  )
}

// ── Employer Drawer ───────────────────────────────────────────────────────────

interface EmployerDetail {
  employer: {
    id: number; name: string; sector: string; staff_count: number
    monthly_payroll_kobo: number; credit_limit_kobo: number
    mou_status: string; mou_date: string | null; mou_expiry: string | null
    contact_name: string | null; contact_phone: string | null; contact_email: string | null
    address: string | null; notes: string | null; is_active: boolean
  }
  outcomes: {
    total_assignments: number; total_staff_referred: number
    total_crm_contacts: number; total_converted: number
  }
  recent_assignments: Array<{
    id: number; assignment_type: string; status: string
    staff_count_at_assignment: number; assigned_at: string
    sales_agent_name: string | null; contacts_created: number; converted: number
  }>
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: SP[2], paddingBottom: SP[2], borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', width: 128, flexShrink: 0, paddingTop: 2 }}>{label}</span>
      <span style={{ fontSize: TEXT.sm, color: 'var(--text)', wordBreak: 'break-word' }}>{value ?? '—'}</span>
    </div>
  )
}

function StatBubble({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{
      flex: 1, textAlign: 'center',
      background: `${color}0D`, borderRadius: RADIUS.lg,
      padding: `${SP[3]} ${SP[2]}`,
    }}>
      <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color, fontFamily: 'var(--font-mono)', lineHeight: 1.1 }}>
        {fmtNum(value)}
      </div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

function EmployerDrawerContent({ id }: { id: number }) {
  const [data, setData]       = useState<EmployerDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(null); setData(null)
    apiFetch<EmployerDetail>(`/api/bd/employers/${id}`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--txt3)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 32, animation: 'spin 1s linear infinite' }}>progress_activity</span>
    </div>
  )
  if (error) return <p style={{ color: RED, fontSize: TEXT.sm }}>{error}</p>
  if (!data) return null

  const { employer: e, outcomes: o, recent_assignments: asgns } = data

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5] }}>

      {/* Outcome strip */}
      <div style={{ display: 'flex', gap: SP[2] }}>
        <StatBubble value={o.total_staff_referred}  label="Staff Referred"   color={NAVY}   />
        <StatBubble value={o.total_crm_contacts}    label="In CRM"           color={BLUE}   />
        <StatBubble value={o.total_converted}        label="Converted"        color={GREEN}  />
        <StatBubble value={o.total_assignments}      label="Assignments"      color={AMBER}  />
      </div>

      {/* Employer info */}
      <div>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[2] }}>
          Employer Details
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
          <InfoRow label="Sector"          value={e.sector} />
          <InfoRow label="Staff Count"     value={fmtNum(e.staff_count)} />
          <InfoRow label="Monthly Payroll" value={e.monthly_payroll_kobo ? fmtKobo(e.monthly_payroll_kobo) : null} />
          <InfoRow label="Credit Limit"    value={e.credit_limit_kobo ? fmtKobo(e.credit_limit_kobo) : null} />
          <InfoRow label="MOU Status"      value={<Pill label={e.mou_status || 'none'} color={mouColor(e.mou_status)} />} />
          <InfoRow label="MOU Date"        value={e.mou_date ? fmtDate(e.mou_date) : null} />
          <InfoRow label="MOU Expiry"      value={e.mou_expiry ? fmtDate(e.mou_expiry) : null} />
        </div>
      </div>

      {/* Contact */}
      {(e.contact_name || e.contact_email || e.contact_phone) && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[2] }}>
            Contact
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
            <InfoRow label="Name"  value={e.contact_name} />
            <InfoRow label="Email" value={
              e.contact_email
                ? <a href={`mailto:${e.contact_email}`} style={{ color: BLUE }}>{e.contact_email}</a>
                : null
            } />
            <InfoRow label="Phone" value={e.contact_phone} />
          </div>
        </div>
      )}

      {/* Recent assignments */}
      {asgns.length > 0 && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[2] }}>
            Recent Assignments
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
            {asgns.map(a => (
              <div key={a.id} style={{
                display: 'flex', alignItems: 'center', gap: SP[3],
                padding: SP[3], borderRadius: RADIUS.lg,
                background: 'var(--surface)', border: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--text)' }}>
                    {a.sales_agent_name ?? 'Unassigned'}
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
                    {fmtDate(a.assigned_at)} · {a.staff_count_at_assignment} staff
                  </div>
                </div>
                <div style={{ display: 'flex', gap: SP[3], flexShrink: 0, textAlign: 'center' }}>
                  <div>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: BLUE, fontFamily: 'var(--font-mono)' }}>{a.contacts_created}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>CRM</div>
                  </div>
                  <div>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN, fontFamily: 'var(--font-mono)' }}>{a.converted}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Conv.</div>
                  </div>
                </div>
                <Pill label={a.status} color={assignStatusColor(a.status)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {e.notes && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[2] }}>
            Notes
          </div>
          <p style={{ fontSize: TEXT.sm, color: 'var(--text)', lineHeight: 1.6, margin: 0 }}>{e.notes}</p>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BDMyDashboard() {
  const navigate = useNavigate()
  const [data,            setData]           = useState<BDDash | null>(null)
  const [loading,         setLoading]        = useState(true)
  const [error,           setError]          = useState<string | null>(null)
  const [drawerOpen,      setDrawerOpen]     = useState(false)
  const [drawerEmployer,  setDrawerEmployer] = useState<{ id: number; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ my_dashboard: BDDash }>('/api/bd/my-dashboard')
      setData(r.my_dashboard)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const k = data?.kpis

  const employerCols: TableCol<BDEmployer>[] = [
    {
      key: 'name', label: 'Employer', sortable: true,
      render: r => (
        <div>
          <div style={{ fontWeight: FW.semibold }}>{r.name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.sector ?? '—'}</div>
        </div>
      ),
    },
    { key: 'staff_count', label: 'Staff', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.staff_count ?? 0)}</span> },
    { key: 'mou_status', label: 'MOU', sortable: true,
      render: r => <Pill label={r.mou_status || 'none'} color={mouColor(r.mou_status)} /> },
    { key: 'mou_expiry', label: 'Expiry', sortable: true,
      render: r => r.mou_expiry
        ? <span style={{ fontSize: TEXT.xs, fontFamily: 'var(--font-mono)', color: 'var(--txt2)' }}>{fmtDate(r.mou_expiry)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'staff_referred', label: 'Referred', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.staff_referred)}</span> },
    { key: 'contacts_created', label: 'In CRM', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.contacts_created > 0 ? BLUE : 'var(--txt3)' }}>{fmtNum(r.contacts_created)}</span> },
    {
      key: 'converted', label: 'Converted', sortable: true, align: 'right',
      render: r => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontWeight: FW.bold, color: r.converted > 0 ? GREEN : 'var(--txt3)' }}>
            {fmtNum(r.converted)}
          </span>
          {r.staff_referred > 0 && (
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>
              {pct(r.converted, r.staff_referred)}
            </div>
          )}
        </div>
      ),
    },
  ]

  const assignmentCols: TableCol<RecentAssignment>[] = [
    {
      key: 'employer_name', label: 'Employer', sortable: true,
      render: r => (
        <div>
          <div style={{ fontWeight: FW.semibold }}>{r.employer_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>→ {r.sales_agent_name}</div>
        </div>
      ),
    },
    { key: 'assignment_type', label: 'Type',
      render: r => (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: r.assignment_type === 'full_company' ? NAVY : PURPLE }}>
          {r.assignment_type === 'full_company' ? 'Full Co.' : 'Specific'}
        </span>
      ) },
    { key: 'staff_count_at_assignment', label: 'Staff', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.staff_count_at_assignment)}</span> },
    { key: 'contacts_created', label: 'In CRM', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.contacts_created > 0 ? BLUE : 'var(--txt3)' }}>{fmtNum(r.contacts_created)}</span> },
    { key: 'converted', label: 'Conv.', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: r.converted > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.converted)}</span> },
    { key: 'status', label: 'Status',
      render: r => <Pill label={r.status} color={assignStatusColor(r.status)} /> },
    { key: 'assigned_at', label: 'Date', sortable: true,
      render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{fmtDate(r.assigned_at)}</span> },
  ]

  return (
    <>
    <Drawer
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      title={drawerEmployer?.name ?? 'Employer'}
      fullPagePath={drawerEmployer ? `/bd/employers/${drawerEmployer.id}` : undefined}
    >
      {drawerEmployer && <EmployerDrawerContent id={drawerEmployer.id} />}
    </Drawer>

    <Page
      title="My BD Dashboard"
      subtitle="Employer relationships, referral pipeline and monthly activity"
      back={{ label: 'Business Dev', to: '/bd' }}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[3] }}>
        <KpiCard
          label="Employers"
          value={fmtNum(k?.employers_managed ?? 0)}
          icon="business" accent={NAVY} loading={loading}
        />
        <KpiCard
          label="Active MOUs"
          value={fmtNum(k?.mou_signed ?? 0)}
          icon="handshake" accent={GREEN} loading={loading}
        />
        <KpiCard
          label="Referred MTD"
          value={fmtNum(k?.staff_referred_mtd ?? 0)}
          change={changePct(k?.staff_referred_mtd ?? 0, k?.staff_referred_lm ?? 0)}
          changePeriod="vs last month"
          icon="person_add" accent={BLUE} loading={loading}
        />
        <KpiCard
          label="Converted MTD"
          value={fmtNum(k?.conversions_mtd ?? 0)}
          change={changePct(k?.conversions_mtd ?? 0, k?.conversions_lm ?? 0)}
          changePeriod="vs last month"
          icon="verified_user" accent={GREEN} loading={loading}
        />
        <KpiCard
          label="Calls MTD"
          value={fmtNum(k?.calls_made_mtd ?? 0)}
          change={changePct(k?.calls_made_mtd ?? 0, k?.calls_lm ?? 0)}
          changePeriod="vs last month"
          icon="phone" accent={AMBER} loading={loading}
        />
        <KpiCard
          label="Meetings MTD"
          value={fmtNum(k?.meetings_mtd ?? 0)}
          change={changePct(k?.meetings_mtd ?? 0, k?.meetings_lm ?? 0)}
          changePeriod="vs last month"
          icon="groups" accent={PURPLE} loading={loading}
        />
      </div>

      {/* ── Urgency tray ── */}
      {data && (
        <UrgencyTray
          mouExpiring={data.urgency.mou_expiring}
          stale={data.urgency.stale_assignments}
          dormant={data.urgency.dormant}
          onNavigate={navigate}
        />
      )}

      {/* ── Referral funnel with period toggle ── */}
      {data && <ReferralFunnel all={data.funnel_all} mtd={data.funnel_mtd} />}

      {/* ── Employers — full width ── */}
      <SectionCard title="My Employers" badge={data?.employers.length ?? 0} padding={false} style={{ marginBottom: SP[3] }}>
        <DataTable<BDEmployer>
          cols={employerCols}
          rows={data?.employers ?? []}
          loading={loading}
          skeletonRows={6}
          keyFn={r => r.id}
          onRowClick={r => { setDrawerEmployer({ id: r.id, name: r.name }); setDrawerOpen(true) }}
          searchKeys={['name', 'sector', 'mou_status']}
          searchPlaceholder="Search employers…"
          pageSize={10}
          emptyText="No employers yet — add one on the Employers page"
        />
      </SectionCard>

      {/* ── Recent assignments — full width ── */}
      <SectionCard title="Recent Assignments" badge={data?.recent_assignments.length ?? 0} padding={false}>
        <DataTable<RecentAssignment>
          cols={assignmentCols}
          rows={data?.recent_assignments ?? []}
          loading={loading}
          skeletonRows={5}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/bd/assignments/${r.id}`)}
          searchKeys={['employer_name', 'sales_agent_name']}
          searchPlaceholder="Search assignments…"
          pageSize={10}
          emptyText="No assignments yet — assign employers or staff from the Employers page"
        />
      </SectionCard>
    </Page>
    </>
  )
}
