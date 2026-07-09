import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, INTER } from '../../lib/design'
import { toast } from 'sonner'

interface ChecklistItem {
  id:           number
  employee_id:  number
  category:     string
  task:         string
  status:       string
  due_date:     string | null
  completed_at: string | null
  sort_order:   number
}

interface ExitRecord {
  id:               number
  exit_type:        string
  exit_date:        string
  interview_date:   string | null
  interview_notes:  string
  loan_cleared:     boolean
  assets_returned:  boolean
  it_deactivated:   boolean
  payroll_done:     boolean
  created_at:       string
}

interface Employee {
  id:              number
  first_name:      string
  last_name:       string
  job_title:       string
  department_name: string
}

const EXIT_TYPES = ['resignation', 'termination', 'retirement', 'redundancy']

export default function Offboarding() {
  const { id } = useParams<{ id: string }>()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [items,    setItems]    = useState<ChecklistItem[]>([])
  const [exit,     setExit]     = useState<ExitRecord | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [updating, setUpdating] = useState<number | null>(null)
  const [showExit, setShowExit] = useState(false)
  const [saving,   setSaving]   = useState(false)

  // Exit form
  const [exitType,  setExitType]  = useState('resignation')
  const [exitDate,  setExitDate]  = useState('')
  const [intDate,   setIntDate]   = useState('')
  const [intNotes,  setIntNotes]  = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [empRes, chkRes] = await Promise.all([
        apiFetch<{ data: Employee }>(`/api/hr/employees/${id}`),
        apiFetch<{ data: ChecklistItem[] }>(`/api/hr/employees/${id}/offboarding`),
      ])
      setEmployee(empRes.data)
      setItems(Array.isArray(chkRes.data) ? chkRes.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function createExit() {
    setSaving(true)
    try {
      await apiPost(`/api/hr/employees/${id}/exit`, {
        exit_type: exitType, exit_date: exitDate,
        interview_date: intDate || null, interview_notes: intNotes,
      })
      toast.success('Exit record created — offboarding checklist generated')
      setShowExit(false)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function updateItem(itemId: number, status: string) {
    setUpdating(itemId)
    try {
      await apiFetch(`/api/hr/employees/${id}/offboarding/${itemId}`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      })
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, status } : i))
    } catch (e: any) { toast.error(e.message) }
    finally { setUpdating(null) }
  }

  const done  = items.filter(i => i.status === 'done').length
  const total = items.length
  const pct   = total > 0 ? Math.round(done / total * 100) : 0
  const progClr = pct >= 100 ? GREEN : pct >= 50 ? AMBER : RED

  const byCat: Record<string, ChecklistItem[]> = {}
  items.forEach(i => { if (!byCat[i.category]) byCat[i.category] = []; byCat[i.category].push(i) })

  const EXIT_STATUS_CHECKS: { key: keyof ExitRecord; label: string }[] = [
    { key: 'loan_cleared',    label: 'Staff Loan Cleared'        },
    { key: 'assets_returned', label: 'Assets Returned'           },
    { key: 'it_deactivated',  label: 'IT Accounts Deactivated'   },
    { key: 'payroll_done',    label: 'Final Payroll Processed'    },
  ]

  return (
    <Page
      title={employee ? `Offboarding — ${employee.first_name} ${employee.last_name}` : 'Offboarding'}
      subtitle={employee ? `${employee.job_title} · ${employee.department_name}` : ''}
      actions={
        !exit && (
          <button onClick={() => setShowExit(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9, border: 'none', background: RED, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_off</span>
            Create Exit
          </button>
        )
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Exit record banner */}
      {exit && (
        <div style={{ background: `${RED}10`, border: `1px solid ${RED}30`, borderRadius: 12, padding: '14px 18px', marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: RED, marginBottom: 4 }}>
            Exit Record — {exit.exit_type.charAt(0).toUpperCase() + exit.exit_type.slice(1)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--txt2)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <span>Exit Date: <strong>{fmtDate(exit.exit_date)}</strong></span>
            {exit.interview_date && <span>Interview: <strong>{fmtDate(exit.interview_date)}</strong></span>}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
            {EXIT_STATUS_CHECKS.map(({ key, label }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15, color: exit[key] ? GREEN : '#D1D5DB' }}>
                  {exit[key] ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                <span style={{ color: exit[key] ? GREEN : 'var(--txt3)' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress */}
      {total > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>Offboarding Progress</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: progClr }}>{done}/{total} · {pct}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--bdr)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: progClr, borderRadius: 4, transition: 'width .3s' }} />
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--txt3)', fontSize: 14 }}>
          No offboarding checklist. Create an exit record above to generate tasks.
        </div>
      ) : (
        Object.entries(byCat).map(([cat, catItems]) => (
          <SectionCard key={cat} title={cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} badge={`${catItems.filter(i => i.status==='done').length}/${catItems.length}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {catItems.sort((a, b) => a.sort_order - b.sort_order).map(item => (
                <div key={item.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 8,
                    background: item.status === 'done' ? `${GREEN}08` : 'transparent',
                    border: `1px solid ${item.status === 'done' ? `${GREEN}25` : 'transparent'}`,
                  }}
                >
                  <button
                    disabled={updating === item.id}
                    onClick={() => updateItem(item.id, item.status === 'done' ? 'pending' : 'done')}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 0 }}
                  >
                    {updating === item.id
                      ? <Spinner size={18} />
                      : <span className="material-symbols-rounded" style={{ fontSize: 18, color: item.status === 'done' ? GREEN : '#D1D5DB' }}>
                          {item.status === 'done' ? 'check_circle' : 'radio_button_unchecked'}
                        </span>
                    }
                  </button>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: item.status === 'done' ? 400 : 600, color: item.status === 'done' ? 'var(--txt3)' : 'var(--txt)', textDecoration: item.status === 'done' ? 'line-through' : 'none' }}>
                      {item.task}
                    </div>
                    {item.due_date && (
                      <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>Due: {fmtDate(item.due_date)}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        ))
      )}

      {/* Create Exit modal */}
      <Modal open={showExit} onClose={() => setShowExit(false)} title="Create Exit Record" width={420}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createExit} disabled={saving || !exitDate}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: RED, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: (saving || !exitDate) ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}Create Exit
            </button>
            <button onClick={() => setShowExit(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Exit Type</label>
            <select value={exitType} onChange={e => setExitType(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              {EXIT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Exit Date *</label>
            <input type="date" value={exitDate} onChange={e => setExitDate(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Exit Interview Date</label>
            <input type="date" value={intDate} onChange={e => setIntDate(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Exit Interview Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={intNotes} onChange={e => setIntNotes(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
