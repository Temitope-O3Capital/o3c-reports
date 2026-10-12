import { useEffect, useMemo, useState } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, NameCell, Pill, EmptyState,
} from '../../components/UI'
import type { TableCol, FilterDef } from '../../components/UI'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { roleLabel } from '../../lib/roles'
import { NAVY, BLUE, GREEN, AMBER, SP, TEXT, FW } from '../../lib/design'

// PEOPLE DIRECTORY — the staff register, read-only.
//
// Built on app.o3c_users, which is the sign-in table and the only staff data O3C
// holds: there is no payroll table in any schema, no leave or attendance record, and
// no staff data source in the report builder. So this page answers exactly what that
// table can answer honestly, and says so on its face rather than dressing account
// administration up as HR reporting.
//
// Above all it does NOT claim a hire date. created_at is when an ACCOUNT was made —
// 50 of the 52 live accounts were created inside the last 90 days because the
// workspace itself is new — so every date here is labelled as an account date and
// there is no "joiners", "leavers" or "tenure" figure anywhere on the page.
//
// Administering an account (granting a role, resetting a password, suspending
// someone) is NOT here. That is User Management, behind the admin_users page. This
// page is gated on people_directory and the API has no write route at all.

interface Staff {
  id: number
  full_name: string
  email: string
  role: string
  extra_roles: string[] | null
  department: string | null
  phone: string | null
  office_location: string | null
  is_active: boolean
  suspended_at: string | null
  suspended_reason: string | null
  last_login: string | null
  created_at: string | null
  deleted_at: string | null
  status: string
  account_age_months: number
}

interface Summary {
  headcount?: {
    on_register: number; active: number; inactive: number
    suspended: number; left_company: number; departments: number; offices: number
  }
  accounts?: {
    accounts_added_90d: number; accounts_closed_90d: number
    never_signed_in: number; dormant_30d: number
  }
  by_department?: { department: string; headcount: number; never_signed_in: number }[]
  by_office?: { office: string; headcount: number }[]
}

const UNASSIGNED = 'Unassigned'

export default function PeopleDirectory() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // status=all so leavers are in the table and the status filter can reach them;
      // the summary tiles count the active register, which is the headcount question.
      const [s, list] = await Promise.all([
        apiFetch<{ data: Summary }>('/api/people/summary'),
        apiFetch<any>('/api/people/staff?status=all&limit=500'),
      ])
      setSummary(s?.data ?? null)
      setStaff(unwrapList<Staff>(list))
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the staff register')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // department is free text on o3c_users and frequently blank, so the blank is given
  // a name rather than dropped — a person with no department is an HR data gap, and
  // a filter that silently hides them would make the headcounts fail to add up.
  const rows = useMemo(() => staff.map(p => ({
    ...p,
    department_label: (p.department ?? '').trim() || UNASSIGNED,
    office_label: (p.office_location ?? '').trim() || UNASSIGNED,
  })), [staff])

  const hc = summary?.headcount
  const ac = summary?.accounts

  const cols: TableCol<typeof rows[number]>[] = [
    {
      key: 'full_name', label: 'Name', sortable: true, width: 230,
      render: r => <NameCell name={r.full_name || r.email} sub={r.email} />,
    },
    {
      key: 'role', label: 'Role', sortable: true, width: 200,
      render: r => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span>{roleLabel(r.role)}</span>
          {/* Secondary roles are what the person actually also does — the page system
              honours them (core.Claims.AllRoles), so the register shows them too. */}
          {(r.extra_roles ?? []).map(x => (
            <Pill key={x} label={roleLabel(x)} color={BLUE} bg="rgba(37,99,235,.10)" />
          ))}
        </div>
      ),
    },
    { key: 'department_label', label: 'Department', sortable: true, width: 150 },
    { key: 'office_label', label: 'Office', sortable: true, width: 160 },
    {
      key: 'status', label: 'Status', sortable: true, width: 110,
      render: r => (
        <span title={r.suspended_reason ?? undefined}>
          <StatusBadge status={r.status} />
        </span>
      ),
    },
    {
      key: 'last_login', label: 'Last Sign-In', sortable: true, width: 170,
      render: r => r.last_login
        ? <span>{fmtDatetime(r.last_login)}</span>
        : <span style={{ color: AMBER, fontWeight: FW.semibold }}>Never</span>,
    },
    {
      key: 'created_at', label: 'Account Created', sortable: true, width: 170,
      render: r => (
        <span style={{ color: 'var(--txt2)' }}>
          {fmtDatetime(r.created_at)}
        </span>
      ),
    },
  ]

  const filters: FilterDef<typeof rows[number]>[] = [
    { key: 'status', label: 'Status' },
    { key: 'department_label', label: 'Department' },
    { key: 'office_label', label: 'Office' },
  ]

  return (
    <Page
      title="People Directory"
      subtitle="The staff register: who is on it, what they do, where they sit, and whether they are signing in"
      loading={loading && !summary}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[4],
      }}>
        <KpiCard label="Active Staff" value={fmtNum(hc?.active)}
          sub={`${fmtNum(hc?.on_register)} on the register · ${fmtNum(hc?.inactive)} inactive · ${fmtNum(hc?.left_company)} left`}
          icon="groups" accent={NAVY} loading={loading && !summary} />
        <KpiCard label="Departments" value={fmtNum(hc?.departments)}
          sub={`Across ${fmtNum(hc?.offices)} ${Number(hc?.offices ?? 0) === 1 ? 'office' : 'offices'}`}
          icon="account_tree" accent={BLUE} loading={loading && !summary} />
        <KpiCard label="Never Signed In" value={fmtNum(ac?.never_signed_in)}
          sub="Active accounts that have never been used"
          icon="person_off"
          accent={Number(ac?.never_signed_in ?? 0) > 0 ? AMBER : GREEN}
          loading={loading && !summary} />
        <KpiCard label="Dormant 30 Days" value={fmtNum(ac?.dormant_30d)}
          sub="Signed in before, but not in the last 30 days"
          icon="schedule"
          accent={Number(ac?.dormant_30d ?? 0) > 0 ? AMBER : GREEN}
          loading={loading && !summary} />
      </div>

      {/* The caveat belongs on the page, not in a commit message. Without it the
          "Account Created" column reads as a start date and the register looks like
          it says something about tenure, which it cannot. */}
      <div style={{
        display: 'flex', gap: SP[2], alignItems: 'flex-start',
        padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[5],
        background: 'var(--th-bg)', borderRadius: 8,
        border: '1px solid var(--card-bdr)', fontSize: TEXT.sm, color: 'var(--txt2)',
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: BLUE }}>info</span>
        <span>
          Every date here is an <strong>account</strong> date, not an employment date. The
          workspace holds no hire date, payroll record, leave or attendance data, so this
          page reports who holds an account and whether they use it — not length of service.
          Granting roles, resetting passwords and suspending accounts stay in User Management.
        </span>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: SP[4], marginBottom: SP[5],
      }}>
        <SectionCard title="Headcount by Department"
          subtitle="Active accounts only · a blank department is shown as Unassigned">
          {(summary?.by_department ?? []).length === 0
            ? <EmptyState icon="account_tree" title="No Department Data"
                description="No active account carries a department." />
            : <Breakdown
                rows={(summary?.by_department ?? []).map(d => ({
                  label: d.department, value: d.headcount, note: d.never_signed_in,
                }))}
                noteLabel="never signed in"
              />}
        </SectionCard>

        <SectionCard title="Where People Sit"
          subtitle="Active accounts by office location">
          {(summary?.by_office ?? []).length === 0
            ? <EmptyState icon="location_on" title="No Office Data"
                description="No active account carries an office location." />
            : <Breakdown rows={(summary?.by_office ?? []).map(o => ({
                label: o.office, value: o.headcount,
              }))} />}
        </SectionCard>
      </div>

      <SectionCard title="The Register" subtitle="Every account, including those that have left"
        padding={false}>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          searchKeys={['full_name', 'email', 'role', 'department_label', 'office_label']}
          searchPlaceholder="Search by name, email, role or department"
          filters={filters}
          pageSize={25}
          emptyText={<EmptyState icon="groups" title="Nobody on the Register"
            description="The staff table returned no accounts." />}
        />
      </SectionCard>
    </Page>
  )
}

// A proportional bar list. A plain table of two numbers hides the shape of the
// company; the bar makes "Operations is 14 of 48" readable at a glance.
function Breakdown({ rows, noteLabel }: {
  rows: { label: string; value: number; note?: number }[]
  noteLabel?: string
}) {
  const max = Math.max(1, ...rows.map(r => Number(r.value ?? 0)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
      {rows.map(r => {
        const unassigned = r.label === UNASSIGNED
        return (
          <div key={r.label}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              gap: SP[2], marginBottom: 4,
            }}>
              <span style={{
                fontSize: TEXT.sm, fontWeight: FW.medium,
                color: unassigned ? AMBER : 'var(--txt1)',
              }}>
                {r.label}
              </span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                {fmtNum(r.value)}
                {noteLabel && Number(r.note ?? 0) > 0 && (
                  <span style={{ color: AMBER }}>{` · ${fmtNum(r.note)} ${noteLabel}`}</span>
                )}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--th-bg)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${(Number(r.value ?? 0) / max) * 100}%`,
                borderRadius: 3, background: unassigned ? AMBER : NAVY,
              }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
