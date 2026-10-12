import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page, Button } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { currentUser } from '../../hooks/useAuth'
import { LeadDetail } from './LeadDetail'
import { PlanVisitModal } from './PlanVisitModal'
import { TEXT, FW, SP, AMBER } from '../../lib/design'

// The lead, as its own page at /sales/leads/:id.
//
// It used to be a drawer over the queue, driven by ?open=<id>. That made the record
// un-linkable in practice — you could paste the URL, but it reopened the whole queue
// with a sheet on top — and it put a scrollbar inside a scrollbar on the one screen an
// officer spends their day in. A lead is a destination, not an aside: it is what a
// notification links to, what gets sent to a colleague, and what an officer keeps open
// while they are on the phone.
//
// The shell is deliberately thin. Everything about the lead lives in LeadDetail, which
// the queue no longer renders, so there is exactly one implementation of the record.

interface Officer { id: number; full_name: string; role?: string; is_active: boolean }

export default function LeadPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const leadId = Number(id) || null
  const me = currentUser()
  const [officers, setOfficers] = useState<Officer[]>([])
  const [head, setHead] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [info, setInfo] = useState<{ name: string; stage: string; city?: string; state?: string } | null>(null)

  // The transfer picker needs the roster, and whether this user may transfer at all.
  // Both are cheap and both fail soft: an officer who cannot read the roster simply
  // gets no transfer option, which is the correct outcome rather than a broken page.
  useEffect(() => {
    let dead = false
    apiFetch<{ data: Officer[] } | Officer[]>('/api/sales/officers')
      .then(r => { if (!dead) setOfficers(Array.isArray(r) ? r : (r?.data ?? [])) })
      .catch(() => { /* no roster → no transfer picker */ })
    apiFetch<{ data: any[] } | any[]>('/api/sales/teams')
      .then(r => {
        if (dead) return
        const teams = Array.isArray(r) ? r : (r?.data ?? [])
        setHead(teams.some((t: any) => t.head_user_id === me?.id))
      })
      .catch(() => { /* not a head */ })
    return () => { dead = true }
  }, [me?.id])

  const onLoaded = useCallback((l: { name: string; stage: string; city?: string; state?: string }) => {
    setInfo(l)
  }, [])

  const where = [info?.city, info?.state].filter(Boolean).join(', ')

  return (
    <Page
      title={info?.name ?? 'Lead'}
      subtitle={where || undefined}
      back={{ label: 'Leads', to: '/sales/leads' }}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          {/* No location means Sales cannot plan the visit, which is the whole reason
              the call centre is now asked for it. Say so where the planning happens
              rather than leaving an officer to wonder why the address is blank. */}
          {info && !where && (
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: AMBER }}>
              No location recorded
            </span>
          )}
          <Button size="sm" variant="secondary" icon="event"
            onClick={() => setPlanOpen(true)}>Plan a Visit</Button>
        </div>
      }
    >
      <LeadDetail
        leadId={leadId}
        officers={officers}
        meId={me?.id ?? 0}
        canManage={head}
        onChanged={() => { /* the page IS the record; nothing upstream to refresh */ }}
        onLoaded={onLoaded}
      />

      {planOpen && leadId && (
        <PlanVisitModal
          contactId={leadId}
          contactName={info?.name ?? 'this lead'}
          city={info?.city}
          state={info?.state}
          onClose={() => setPlanOpen(false)}
          onDone={() => { setPlanOpen(false); navigate('/sales/calendar') }}
        />
      )}
    </Page>
  )
}
