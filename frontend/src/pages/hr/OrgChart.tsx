import { useState, useEffect, useCallback } from 'react'
import { Page, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { NAVY, BLUE, AMBER, INTER, NUM } from '../../lib/design'

interface OrgNode {
  id:          number
  full_name:   string
  title:       string
  department:  string
  manager_id:  number | null
  children?:   OrgNode[]
}

function buildTree(flat: OrgNode[]): OrgNode[] {
  const map: Record<number, OrgNode> = {}
  const roots: OrgNode[] = []
  flat.forEach(n => { map[n.id] = { ...n, children: [] } })
  flat.forEach(n => {
    if (n.manager_id && map[n.manager_id]) {
      map[n.manager_id].children!.push(map[n.id])
    } else {
      roots.push(map[n.id])
    }
  })
  return roots
}

const DEPT_COLOR: Record<string, string> = {
  'Finance':     '#3B82F6',
  'HR':          '#8B5CF6',
  'Technology':  '#06B6D4',
  'Sales':       NAVY,
  'Collections': AMBER,
  'Risk':        '#EF4444',
  'Compliance':  '#10B981',
  'Operations':  '#F97316',
}

function NodeCard({ node, depth }: { node: OrgNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const color = DEPT_COLOR[node.department] ?? '#6B7280'
  const hasChildren = (node.children?.length ?? 0) > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Card */}
      <div
        onClick={() => hasChildren && setExpanded(e => !e)}
        style={{
          cursor: hasChildren ? 'pointer' : 'default',
          background: 'var(--card)',
          border: `2px solid ${color}`,
          borderRadius: 10,
          padding: '10px 14px',
          minWidth: 140,
          maxWidth: 180,
          textAlign: 'center',
          position: 'relative',
          userSelect: 'none',
        }}
      >
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: `${color}20`, border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 6px', fontSize: 15, fontWeight: 700, color, fontFamily: INTER }}>
          {node.full_name.charAt(0).toUpperCase()}
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.3 }}>{node.full_name}</div>
        <div style={{ fontSize: 10.5, color: 'var(--txt2)', marginTop: 2, lineHeight: 1.3 }}>{node.title || '—'}</div>
        <div style={{ fontSize: 10, color, fontWeight: 600, marginTop: 3, background: `${color}15`, borderRadius: 6, padding: '1px 6px', display: 'inline-block' }}>{node.department}</div>
        {hasChildren && (
          <div style={{ position: 'absolute', bottom: -10, left: '50%', transform: 'translateX(-50%)', width: 18, height: 18, borderRadius: '50%', background: color, color: '#fff', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
            {expanded ? '−' : '+'}
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Stem down */}
          <div style={{ width: 2, height: 20, background: 'var(--bdr)' }} />
          {/* Horizontal bar + children */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', position: 'relative' }}>
            {/* Horizontal line spanning children */}
            {node.children!.length > 1 && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: '50%',
                transform: 'translateX(-50%)',
                width: `calc(100% - 80px)`,
                height: 2,
                background: 'var(--bdr)',
              }} />
            )}
            {node.children!.map(child => (
              <div key={child.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 2, height: 18, background: 'var(--bdr)' }} />
                <NodeCard node={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function OrgChart() {
  const [nodes,   setNodes]   = useState<OrgNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [query,   setQuery]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: OrgNode[] }>('/api/hr/org-chart')
      setNodes(Array.isArray(res.data) ? res.data : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const roots = buildTree(
    query
      ? nodes.filter(n =>
          n.full_name.toLowerCase().includes(query.toLowerCase()) ||
          n.title?.toLowerCase().includes(query.toLowerCase()) ||
          n.department?.toLowerCase().includes(query.toLowerCase())
        )
      : nodes
  )

  const deptCounts: Record<string, number> = {}
  nodes.forEach(n => { deptCounts[n.department] = (deptCounts[n.department] ?? 0) + 1 })

  return (
    <Page title="Org Chart" subtitle="Reporting structure and departments">
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Total Staff',   value: nodes.length,                                       color: NAVY },
          { label: 'Departments',   value: Object.keys(deptCounts).length,                     color: BLUE },
          { label: 'Reporting Lines', value: nodes.filter(n => n.manager_id !== null).length,  color: AMBER },
          { label: 'Direct Reports (CEO)', value: nodes.filter(n => n.manager_id === null).length - 1 < 0 ? 0 : roots.flatMap(r => r.children ?? []).length, color: '#8B5CF6' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color, ...NUM }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Search + legend */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search by name, title or department…"
          style={{ padding: '8px 12px', border: '1px solid var(--input-bdr)', borderRadius: 8, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', width: 280 }}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(DEPT_COLOR).map(([dept, color]) => (
            deptCounts[dept] ? (
              <span key={dept} style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 8, background: `${color}15`, color, border: `1px solid ${color}30` }}>
                {dept} ({deptCounts[dept]})
              </span>
            ) : null
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={36} /></div>
      ) : roots.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--txt3)', fontSize: 14 }}>No employees found</div>
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: 40 }}>
          <div style={{ display: 'flex', gap: 32, justifyContent: 'center', minWidth: 'max-content', paddingTop: 20 }}>
            {roots.map(r => <NodeCard key={r.id} node={r} depth={0} />)}
          </div>
        </div>
      )}
    </Page>
  )
}
