import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Button, ErrBanner, EmptyState, Input, Textarea, Modal, Badge, Sk,
} from '../../components/UI'
import { apiFetch, apiPost, apiDelete, unwrapList } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, FW, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

/*
  Dashboards — the list.

  A dashboard is a page of tiles, and every tile is a view of something already saved:
  a pivot report from the Report Builder, or a saved query from the SQL console. So this
  page is the third side of a triangle the previous two phases built, not a new reporting
  engine.

  WHAT "SHARED" MEANS HERE, because it is not what it usually means. Sharing a dashboard
  shares the ARRANGEMENT, never the data. Each tile is still checked against the viewer's
  own access to that tile's source on every read, so the same shared dashboard can
  legitimately show eight tiles to a BI analyst and five to a department head, with the
  other three explaining why. That is deliberate: the alternative — a dashboard that
  widens access because someone ticked a box — would undo the per-dataset scoping the
  Report Builder enforces. See handlers/dashboards.go.
*/

interface Dashboard {
  id: number
  name: string
  description: string
  is_shared: boolean
  is_mine: boolean
  created_by_name: string | null
  tile_count: number
  updated_at: string
}

export default function Dashboards() {
  const nav = useNavigate()
  const [boards, setBoards] = useState<Dashboard[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [shared, setShared] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Dashboard | null>(null)

  const load = useCallback(() => {
    // unwrapList, because respond() wraps every payload as { data, … }. Calling an array
    // method on the envelope is what broke the Report Library and the SQL console on
    // their first day in production.
    apiFetch('/api/dashboards')
      .then(res => setBoards(unwrapList<Dashboard>(res)))
      .catch(e => setErr(e?.message || 'Could not load dashboards'))
  }, [])
  useEffect(() => { load() }, [load])

  async function create() {
    if (!name.trim()) return
    setSaving(true)
    try {
      const res: any = await apiPost('/api/dashboards', {
        name: name.trim(), description: desc.trim(), is_shared: shared,
      })
      const id = res?.data?.id ?? res?.id
      toast.success('Dashboard created')
      setCreating(false); setName(''); setDesc(''); setShared(false)
      if (id) nav(`/reports/dashboards/${id}`)
      else load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not create the dashboard')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    try {
      await apiDelete(`/api/dashboards/${deleting.id}`)
      toast.success('Dashboard deleted')
      setDeleting(null)
      load()
    } catch (e: any) {
      toast.error(e?.message || 'Could not delete the dashboard')
    }
  }

  return (
    <Page
      title="Dashboards"
      subtitle="A page of tiles over your saved reports and queries. Sharing shares the layout, not the data — every tile is still checked against the reader's own access."
      actions={<Button icon="add" onClick={() => setCreating(true)}>New Dashboard</Button>}
    >
      {err && <ErrBanner error={err} onRetry={load} />}

      {boards === null ? (
        <div style={{ display: 'grid', gap: SP[4], gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {[0, 1, 2].map(i => <Sk key={i} h={116} />)}
        </div>
      ) : boards.length === 0 ? (
        <EmptyState
          icon="dashboard"
          title="No Dashboards Yet"
          description="A dashboard holds tiles built from reports you have already saved in the Report Builder, or queries saved in the SQL Console. Create one and add your first tile."
          action={{ label: 'New Dashboard', icon: 'add', onClick: () => setCreating(true) }}
        />
      ) : (
        <div style={{ display: 'grid', gap: SP[4], gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {boards.map(b => (
            <SectionCard key={b.id} padding={false}>
              <button
                onClick={() => nav(`/reports/dashboards/${b.id}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: 'transparent', border: 'none', padding: SP[5],
                }}
              >
                <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: SP[3] }}>
                  <div style={{ fontWeight: FW.semibold, fontSize: TEXT.base, color: 'var(--txt)' }}>{b.name}</div>
                  {b.is_shared && <Badge variant="info">Shared</Badge>}
                </div>
                {b.description && (
                  <div style={{ marginTop: SP[2], fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
                    {b.description}
                  </div>
                )}
                <div style={{
                  marginTop: SP[4], display: 'flex', gap: SP[4], alignItems: 'center',
                  fontSize: TEXT.xs, color: 'var(--txt3)',
                }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {b.tile_count} {b.tile_count === 1 ? 'tile' : 'tiles'}
                  </span>
                  <span>·</span>
                  <span>{b.is_mine ? 'Yours' : (b.created_by_name || 'Unknown')}</span>
                  <span>·</span>
                  <span>{fmtDatetime(b.updated_at)}</span>
                </div>
              </button>
              {b.is_mine && (
                <div style={{
                  borderTop: '1px solid var(--bdr)', padding: `${SP[2]}px ${SP[4]}px`,
                  display: 'flex', justifyContent: 'flex-end',
                }}>
                  <Button variant="ghost" size="sm" icon="delete" onClick={() => setDeleting(b)}>
                    Delete
                  </Button>
                </div>
              )}
            </SectionCard>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New Dashboard"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} loading={saving} disabled={!name.trim()}>Create</Button>
          </>
        }>
        <div style={{ display: 'grid', gap: SP[4] }}>
          <Input label="Name" value={name} onChange={e => setName(e.target.value)}
            placeholder="Collections — Daily Watch" autoFocus />
          <Textarea label="Description" value={desc} onChange={e => setDesc(e.target.value)}
            rows={2} placeholder="What this dashboard is for, and who reads it." />
          <label style={{ display: 'flex', gap: SP[3], alignItems: 'start', cursor: 'pointer' }}>
            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)}
              style={{ marginTop: 3, accentColor: NAVY }} />
            <span>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium }}>Share with the team</span>
              <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2, lineHeight: 1.5 }}>
                Others see the layout. Each tile is still checked against their own access,
                so a colleague may see fewer tiles than you do.
              </span>
            </span>
          </label>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete This Dashboard?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={remove}>Delete</Button>
          </>
        }>
        <p style={{ fontSize: TEXT.sm, lineHeight: 1.6 }}>
          <strong>{deleting?.name}</strong> and its {deleting?.tile_count} tile(s) will be removed.
          The reports and queries the tiles read are not affected — only this arrangement of them.
        </p>
      </Modal>
    </Page>
  )
}
