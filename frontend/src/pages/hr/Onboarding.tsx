import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, NAVY, BLUE, INTER } from '../../lib/design'
import { toast } from 'sonner'

interface ChecklistItem {
  id:           number
  employee_id:  number
  category:     string
  task:         string
  status:       string
  due_date:     string | null
  completed_at: string | null
  notes:        string
  sort_order:   number
}

interface Employee {
  id:              number
  first_name:      string
  last_name:       string
  job_title:       string
  department_name: string
  employment_date: string | null
}

const CAT_COLOR: Record<string, string> = {
  it_setup:   BLUE,
  hr:         '#8B5CF6',
  finance:    GREEN,
  compliance: AMBER,
  general:    NAVY,
}
const CAT_LABEL: Record<string, string> = {
  it_setup:   'IT Setup',
  hr:         'HR',
  finance:    'Finance',
  compliance: 'Compliance',
  general:    'General',
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'done')
    return <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: GREEN }}>check_circle</span>
  if (status === 'skipped')
    return <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: 'var(--chart-lbl)' }}>cancel</span>
  return <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: '#D1D5DB' }}>radio_button_unchecked</span>
}

export default function Onboarding() {
  const { id } = useParams<{ id: string }>()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [items,    setItems]    = useState<ChecklistItem[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [initing,  setIniting]  = useState(false)
  const [updating, setUpdating] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [empRes, chkRes] = await Promise.all([
        apiFetch<{ data: Employee }>(`/api/hr/employees/${id}`),
        apiFetch<{ data: ChecklistItem[] }>(`/api/hr/employees/${id}/onboarding`),
      ])
      setEmployee(empRes.data)
      setItems(Array.isArray(chkRes.data) ? chkRes.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function initChecklist() {
    setIniting(true)
    try {
      await apiPost(`/api/hr/employees/${id}/onboarding`, {})
      toast.success('Onboarding checklist initialised')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setIniting(false) }
  }

  async function updateItem(itemId: number, status: string) {
    setUpdating(itemId)
    try {
      await apiFetch(`/api/hr/employees/${id}/onboarding/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      })
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, status } : i))
    } catch (e: any) { toast.error(e.message) }
    finally { setUpdating(null) }
  }

  const byCategory: Record<string, ChecklistItem[]> = {}
  items.forEach(item => {
    if (!byCategory[item.category]) byCategory[item.category] = []
    byCategory[item.category].push(item)
  })

  const done    = items.filter(i => i.status === 'done').length
  const total   = items.length
  const pct     = total > 0 ? Math.round(done / total * 100) : 0
  const progClr = pct >= 100 ? GREEN : pct >= 50 ? AMBER : '#EF4444'

  return (
    <Page
      title={employee ? `Onboarding — ${employee.first_name} ${employee.last_name}` : 'Onboarding'}
      subtitle={employee ? `${employee.job_title} · ${employee.department_name}` : ''}
      actions={
        <button onClick={initChecklist} disabled={initing}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: initing ? 'wait' : 'pointer', opacity: initing ? 0.7 : 1, fontFamily: INTER }}>
          {initing && <Spinner size={13} color="#fff" />}
          {items.length > 0 ? 'Re-initialise' : 'Initialise Checklist'}
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Progress bar */}
      {total > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '16px 20px', marginBottom: SP[5] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SP[2] }}>
            <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>Overall Progress</span>
            <span style={{ fontSize: TEXT.md, fontWeight: FW.extrabold, color: progClr }}>{done}/{total} tasks · {pct}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--bdr)', borderRadius: RADIUS.xs, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: progClr, borderRadius: RADIUS.xs, transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--txt3)', fontSize: TEXT.md }}>
          No checklist yet. Click "Initialise Checklist" to generate the default onboarding tasks.
        </div>
      ) : (
        Object.entries(byCategory).map(([cat, catItems]) => {
          const catDone = catItems.filter(i => i.status === 'done').length
          const color   = CAT_COLOR[cat] ?? NAVY
          return (
            <SectionCard
              key={cat}
              title={CAT_LABEL[cat] ?? cat}
              badge={`${catDone}/${catItems.length}`}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {catItems.sort((a, b) => a.sort_order - b.sort_order).map(item => (
                  <div key={item.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: SP[3], padding: '10px 14px',
                      borderRadius: RADIUS.md, background: item.status === 'done' ? `${color}08` : 'transparent',
                      border: `1px solid ${item.status === 'done' ? `${color}25` : 'transparent'}`,
                    }}
                  >
                    <button
                      disabled={updating === item.id}
                      onClick={() => updateItem(item.id, item.status === 'done' ? 'pending' : 'done')}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 0 }}
                    >
                      {updating === item.id
                        ? <Spinner size={18} />
                        : <StatusIcon status={item.status} />
                      }
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: TEXT.base, fontWeight: item.status === 'done' ? 400 : 600, color: item.status === 'done' ? 'var(--txt3)' : 'var(--txt)', textDecoration: item.status === 'done' ? 'line-through' : 'none' }}>
                        {item.task}
                      </div>
                      {item.due_date && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                          Due: {fmtDate(item.due_date)}
                          {item.completed_at && ` · Done: ${fmtDate(item.completed_at)}`}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => updateItem(item.id, item.status === 'skipped' ? 'pending' : 'skipped')}
                      style={{ padding: '2px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'none', fontSize: TEXT.xs, color: 'var(--txt3)', cursor: 'pointer' }}
                    >
                      {item.status === 'skipped' ? 'Unskip' : 'Skip'}
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          )
        })
      )}
    </Page>
  )
}
