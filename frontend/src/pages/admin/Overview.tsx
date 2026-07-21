import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, NUM, INTER, SORA, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface User { id: number; full_name: string; role: string; is_active: boolean }
interface Activity {
  id: number; page: string; action: string; detail: string; ip: string; ts: string
  full_name?: string; email?: string; role?: string
}
interface Role { name: string; built_in: boolean }

// ── Module definitions ────────────────────────────────────────────────────────

interface Module {
  icon: string
  label: string
  description: string
  to: string
  stat?: (ctx: StatsCtx) => string | undefined
  accent?: string
}

interface StatsCtx {
  users: User[]
  roles: Role[]
  activity: Activity[]
}

const MODULES: Module[] = [
  {
    icon: 'group',
    label: 'Users',
    description: 'Invite staff, manage roles, reset passwords, and deactivate accounts.',
    to: '/admin/users',
    stat: c => `${c.users.filter(u => u.is_active).length} active · ${c.users.filter(u => !u.is_active).length} inactive`,
    accent: NAVY,
  },
  {
    icon: 'badge',
    label: 'Roles & Permissions',
    description: 'Configure built-in and custom roles. Control which pages each role can access.',
    to: '/admin/roles',
    stat: c => `${c.roles.length} roles · ${c.roles.filter(r => !r.built_in).length} custom`,
    accent: '#7C3AED',
  },
  {
    icon: 'key',
    label: 'API Keys',
    description: 'Store and rotate encrypted API keys for external service integrations.',
    to: '/admin/api-keys',
    accent: '#0891B2',
  },
  {
    icon: 'settings',
    label: 'System Settings',
    description: 'Configure platform-wide settings including domain, timezone, and feature flags.',
    to: '/admin/settings',
    accent: '#6B7280',
  },
  {
    icon: 'integration_instructions',
    label: 'Integrations',
    description: 'Monitor connected services — SendGrid, MSSQL, Eye, NIBSS, WhatsApp, and more.',
    to: '/admin/integrations',
    accent: BLUE,
  },
  {
    icon: 'notifications',
    label: 'Notification Settings',
    description: 'Toggle email and push alerts by module: loans, cards, helpdesk, finance, and sync.',
    to: '/admin/notification-settings',
    accent: AMBER,
  },
  {
    icon: 'mark_email_read',
    label: 'Email Senders',
    description: 'Manage verified sender identities for transactional and campaign emails.',
    to: '/admin/email-senders',
    accent: GREEN,
  },
  {
    icon: 'mail',
    label: 'Mail Health',
    description: 'SendGrid delivery metrics, open rates, suppressions, and deliverability checks.',
    to: '/admin/mail',
    accent: '#DB2777',
  },
  {
    icon: 'history',
    label: 'Audit Log',
    description: 'Full activity log of every user action — module, IP address, and timestamp.',
    to: '/admin/audit',
    stat: c => c.activity.length > 0 ? `${c.activity.length} recent events` : undefined,
    accent: RED,
  },
  {
    icon: 'sync',
    label: 'Sync Status',
    description: 'Track MSSQL ↔ PostgreSQL sync runs, success rate, and row counts.',
    to: '/admin/sync',
    accent: '#0891B2',
  },
  {
    icon: 'toggle_on',
    label: 'Module Management',
    description: 'Enable or disable product modules to control what staff see in the sidebar.',
    to: '/admin/modules',
    accent: '#7C3AED',
  },
]

// ── Module tile ───────────────────────────────────────────────────────────────

function ModuleTile({
  mod, stat, onClick,
}: { mod: Module; stat?: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  const accent = mod.accent ?? NAVY

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 0,
        padding: '20px 20px 18px',
        borderRadius: RADIUS.xl,
        border: `1.5px solid ${hovered ? accent + '50' : 'var(--card-bdr)'}`,
        background: hovered ? `${accent}07` : 'var(--card)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'border-color 150ms, background 150ms, box-shadow 150ms',
        boxShadow: hovered ? `0 4px 20px ${accent}18` : '0 1px 4px rgba(0,0,0,.04)',
        width: '100%',
      }}
    >
      {/* Icon */}
      <div style={{
        width: 44, height: 44, borderRadius: RADIUS.xl,
        background: hovered ? `${accent}20` : `${accent}12`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 14, transition: 'background 150ms',
        flexShrink: 0,
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT['2xl'], color: accent }}>
          {mod.icon}
        </span>
      </div>

      {/* Label */}
      <div style={{
        fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)',
        marginBottom: 6, lineHeight: 1.2, fontFamily: SORA,
      }}>
        {mod.label}
      </div>

      {/* Description */}
      <div style={{
        fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5,
        marginBottom: stat ? 14 : 0, fontFamily: INTER,
        flex: 1,
      }}>
        {mod.description}
      </div>

      {/* Stat badge */}
      {stat && (
        <div style={{
          fontSize: TEXT.xs, fontWeight: FW.semibold,
          color: accent,
          background: `${accent}12`,
          borderRadius: RADIUS['2xl'], padding: '3px 10px',
          fontFamily: INTER, marginTop: 'auto',
        }}>
          {stat}
        </div>
      )}

      {/* Arrow */}
      <div style={{
        position: 'absolute',
        // use a relative trick — just show at bottom-right via flex
      }} />
    </button>
  )
}

// ── Recent activity strip ─────────────────────────────────────────────────────

function ActivityFeed({ activity, loading }: { activity: Activity[]; loading: boolean }) {
  const navigate = useNavigate()

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        {[...Array(5)].map((_, i) => (
          <div key={i} style={{ height: 40, borderRadius: RADIUS.md, background: 'var(--sk-bg)' }} className="sk" />
        ))}
      </div>
    )
  }
  if (activity.length === 0) {
    return <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, padding: '20px 0' }}>No recent activity</div>
  }

  return (
    <div>
      {activity.slice(0, 8).map(a => (
        <div key={a.id} style={{
          display: 'flex', gap: SP[2], alignItems: 'flex-start',
          padding: '10px 0', borderBottom: '1px solid var(--bdr)',
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%', background: `${NAVY}12`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: NAVY }}>person</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {a.full_name ?? a.email ?? 'Unknown'} — <span style={{ color: 'var(--txt2)' }}>{a.action}</span>
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
              {a.page} · {fmtDatetime(a.ts)}
            </div>
          </div>
        </div>
      ))}
      <button onClick={() => navigate('/admin/audit')} style={{
        marginTop: 12, padding: '7px 0', width: '100%', borderRadius: RADIUS.md,
        border: '1.5px solid var(--bdr)', background: 'transparent',
        fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, cursor: 'pointer', fontFamily: INTER,
      }}>
        View full audit log →
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminOverview() {
  const navigate = useNavigate()
  const [users,    setUsers]    = useState<User[]>([])
  const [roles,    setRoles]    = useState<Role[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [u, r, a] = await Promise.allSettled([
        apiFetch<{ data: User[] }>('/api/admin/users'),
        apiFetch<{ data: Role[] }>('/api/admin/roles'),
        apiFetch<{ data: Activity[] }>('/api/admin/activity?limit=20'),
      ])
      if (u.status === 'fulfilled') setUsers(u.value?.data ?? [])
      if (r.status === 'fulfilled') setRoles(r.value?.data ?? [])
      if (a.status === 'fulfilled') setActivity(a.value?.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const ctx: StatsCtx = { users, roles, activity }

  const totalUsers  = users.length
  const activeUsers = users.filter(u => u.is_active).length

  return (
    <Page title="Admin" subtitle={loading ? undefined : `${activeUsers} of ${totalUsers} users active`}>
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: SP[6], alignItems: 'start' }}>

        {/* Module grid */}
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 14, fontFamily: INTER }}>
            Modules
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[3], position: 'relative' }}>
            {MODULES.map(mod => (
              <ModuleTile
                key={mod.to}
                mod={mod}
                stat={mod.stat?.(ctx)}
                onClick={() => navigate(mod.to)}
              />
            ))}
          </div>
        </div>

        {/* Right sidebar: recent activity */}
        <div style={{ position: 'sticky', top: 0 }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: 14, fontFamily: INTER }}>
            Recent Activity
          </div>
          <div style={{
            background: 'var(--card)', border: '1.5px solid var(--card-bdr)',
            borderRadius: RADIUS.xl, padding: '16px 18px',
          }}>
            <ActivityFeed activity={activity} loading={loading} />
          </div>

          {/* Quick stats */}
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
            {[
              { label: 'Total Users',  value: totalUsers,  color: 'var(--txt)' },
              { label: 'Active',       value: activeUsers, color: GREEN },
              { label: 'Inactive',     value: totalUsers - activeUsers, color: AMBER },
              { label: 'Roles in Use', value: [...new Set(users.map(u => u.role))].length, color: NAVY },
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                background: 'var(--card)', border: '1.5px solid var(--card-bdr)',
                borderRadius: RADIUS.lg, padding: '12px 14px',
              }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color }}>
                  {loading ? '—' : value}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </Page>
  )
}
