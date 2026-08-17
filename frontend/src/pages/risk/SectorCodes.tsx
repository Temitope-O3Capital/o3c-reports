import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal, KpiCard } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, INTER, NUM } from '../../lib/design'
import { hasPage } from '../../hooks/useAuth'

// Sector code registry.
//
// Udara sends economic_sector as a bare CBN numeric code ('41000') and carries no label
// anywhere in its payload, so O3 owns the code→name mapping. Before this page existed
// the Risk module rendered "41000 — 39.6% of book" as a sector label on the
// concentration chart. Codes are auto-registered server-side as they appear on the loan
// book, so this list is always the complete set of things needing a name.

interface SectorCode {
  code: string
  name: string
  description: string
  source: string
  is_active: boolean
  is_mapped: boolean
  loan_count: number
  book_kobo: number
  updated_at: string | null
}

export default function SectorCodes() {
  // Mirrors the write guard on the API (risk_all | risk_head): naming a sector is
  // reference data that lands on every concentration report.
  const canEdit = hasPage('risk_all') || hasPage('risk_head')

  const [rows,     setRows]     = useState<SectorCode[]>([])
  const [unmapped, setUnmapped] = useState(0)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [editing,  setEditing]  = useState<SectorCode | null>(null)
  const [adding,   setAdding]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: { data: SectorCode[]; unmapped_count: number } }>('/api/risk/sector-codes')
      setRows(res.data?.data ?? [])
      setUnmapped(res.data?.unmapped_count ?? 0)
    } catch (e: any) { setError(e.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const mappedCount = rows.filter(r => r.is_mapped).length
  // Exposure sitting behind an unnamed code — the number that makes the gap concrete.
  const unmappedExposure = rows.filter(r => !r.is_mapped).reduce((s, r) => s + Number(r.book_kobo || 0), 0)

  const cols: TableCol<SectorCode>[] = [
    {
      key: 'code', label: 'CBN Code', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.code}</span>,
    },
    {
      key: 'name', label: 'Sector Name', sortable: true,
      render: r => r.is_mapped
        ? (
          <div>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</div>
            {r.description && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.description}</div>}
          </div>
        )
        : (
          <span style={{ fontSize: TEXT.sm, fontStyle: 'italic', color: AMBER, fontWeight: FW.semibold }}>
            Not yet named
          </span>
        ),
    },
    {
      key: 'source', label: 'Source',
      render: r => (
        <span
          title={r.source === 'udara' ? 'Code observed on the Udara loan book' : 'Added manually in the workspace'}
          style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}
        >
          {r.source === 'udara' ? 'Udara' : 'Manual'}
        </span>
      ),
    },
    {
      key: 'loan_count', label: 'Loans', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.loan_count > 0 ? fmtNum(r.loan_count) : '—'}</span>,
    },
    {
      key: 'book_kobo', label: 'Exposure', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{r.book_kobo > 0 ? fmtKobo(r.book_kobo) : '—'}</span>,
    },
    ...(canEdit ? [{
      key: 'actions' as const, label: '', align: 'right' as const,
      render: (r: SectorCode) => (
        <button
          onClick={() => setEditing(r)}
          style={{ padding: '4px 10px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {r.is_mapped ? 'Edit' : 'Name it'}
        </button>
      ),
    }] : []),
  ]

  if (loading) return (
    <Page title="Sector Codes">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page
      title="Sector Codes"
      subtitle="CBN economic sector code → name. Udara sends codes only, so these names are maintained here."
    >
      <ErrBanner error={error} onRetry={load} />

      {unmapped > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[4],
          padding: `${SP[2]} ${SP[4]}`,
          background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER, flexShrink: 0, marginTop: 1 }}>label_off</span>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
            <strong style={{ color: AMBER }}>
              {unmapped} code{unmapped !== 1 ? 's' : ''} not yet named
            </strong>{' '}
            — {fmtKobo(unmappedExposure)} of the active book sits behind them. Until they are
            named, Sector Concentration and the vintage breakdowns show “Unmapped (code)”.
            {!canEdit && ' Ask a Risk Head to name them.'}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Registered Codes" value={String(rows.length)} sub="Seen on the book or added here" icon="format_list_numbered" accent={NAVY} />
        <KpiCard label="Named"            value={String(mappedCount)} sub={`${rows.length - mappedCount} outstanding`} icon="label" accent={mappedCount === rows.length ? GREEN : AMBER} />
        <KpiCard label="Unnamed Exposure" value={fmtKobo(unmappedExposure)} sub="Active book behind unnamed codes" icon="help" accent={unmappedExposure > 0 ? AMBER : GREEN} />
      </div>

      <SectionCard
        title="Registry"
        badge={rows.length}
        padding={false}
        actions={canEdit ? (
          <button
            onClick={() => setAdding(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: 'none', background: NAVY, cursor: 'pointer', fontSize: TEXT.sm, color: '#fff', fontWeight: FW.semibold, fontFamily: 'inherit' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>add</span>Add Code
          </button>
        ) : undefined}
      >
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.code}
          emptyText="No sector codes registered yet"
          pageSize={25}
        />
      </SectionCard>

      <SectorCodeModal
        entry={editing}
        open={!!editing || adding}
        isNew={adding}
        onClose={() => { setEditing(null); setAdding(false) }}
        onDone={() => { setEditing(null); setAdding(false); load() }}
      />
    </Page>
  )
}

// ── Edit / add modal ──────────────────────────────────────────────────────────

function SectorCodeModal({ entry, open, isNew, onClose, onDone }: {
  entry: SectorCode | null; open: boolean; isNew: boolean
  onClose: () => void; onDone: () => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setCode(entry?.code ?? '')
    setName(entry?.name ?? '')
    setDesc(entry?.description ?? '')
  }, [open, entry])

  async function save() {
    const c = code.trim(), n = name.trim()
    if (!c || !n) return
    setSaving(true)
    try {
      await apiPut(`/api/risk/sector-codes/${encodeURIComponent(c)}`, {
        code: c, name: n, description: desc.trim(), is_active: true,
      })
      toast.success(`Sector ${c} saved`)
      onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to save')
    } finally { setSaving(false) }
  }

  const canSave = code.trim().length > 0 && name.trim().length > 0

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'Add Sector Code' : `Sector ${entry?.code ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        {!isNew && entry && entry.loan_count > 0 && (
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt2)', margin: 0 }}>
            {fmtNum(entry.loan_count)} active loan{entry.loan_count !== 1 ? 's' : ''} · {fmtKobo(entry.book_kobo)} exposure
          </p>
        )}

        <Field label="CBN Code">
          <input
            value={code}
            onChange={e => setCode(e.target.value)}
            disabled={!isNew}
            placeholder="41000"
            style={inputStyle(!isNew)}
          />
        </Field>

        <Field label="Sector Name">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. General Commerce"
            style={inputStyle(false)}
          />
        </Field>

        <Field label="Description (optional)">
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
            placeholder="What this classification covers…"
            style={{ ...inputStyle(false), resize: 'vertical' }}
          />
        </Field>

        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={save} disabled={!canSave || saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: 'none', background: canSave ? NAVY : 'var(--bdr)', color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: canSave && !saving ? 'pointer' : 'not-allowed', opacity: saving ? 0.7 : 1, fontFamily: 'inherit' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
      {children}
    </div>
  )
}

function inputStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', padding: SP[3], borderRadius: RADIUS.md,
    border: '1px solid var(--bdr)',
    background: disabled ? 'var(--th-bg)' : 'var(--input-bg)',
    color: disabled ? 'var(--txt3)' : 'var(--txt)',
    fontSize: TEXT.sm, fontFamily: INTER, boxSizing: 'border-box',
  }
}
