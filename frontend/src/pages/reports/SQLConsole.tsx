import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Page, SectionCard, DataTable, ErrBanner, Button, EmptyState,
  Input, Badge, Modal, SearchInput, ConfirmModal,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete, unwrap, unwrapList } from '../../lib/api'
import { labelFor, fmtValue, alignFor, downloadRowsCSV } from '../../lib/reportFormat'
import { NAVY, AMBER, GREEN, MONO, FW, SP } from '../../lib/design'
import { fmtDatetime } from '../../lib/fmt'
import { toast } from 'sonner'

/*
  SQL CONSOLE — for BI only.

  WHY THIS PAGE EXISTS. A registry of 52 data sources still cannot answer a question
  that spans three of them, and the Report Builder is a pivot tool, not a query language.
  BI asked for SQL; this is it.

  WHAT KEEPS IT SAFE IS NOT ON THIS PAGE. Every control is server-side, and in the order
  that matters: the query runs inside a Postgres read-only transaction (verified — a
  CREATE TABLE inside it is refused by the engine), under a statement timeout, and the
  RESULT is screened for credential-shaped columns and values before a single row comes
  back. See handlers/bi_sql.go. Nothing here validates anything, deliberately: a
  client-side check on a security boundary is theatre, and worse, it teaches the reader
  that the boundary is here.

  WHAT THIS PAGE OWES THE USER. Three things the server cannot do for them:

   - say which connection ran the query, so a missing read-only role is visible rather
     than silently absent;
   - never hide a truncated result, because a cut that looks like an answer is the one
     failure a console must not have;
   - make the schema browsable, because nobody memorises 363 tables, and a console you
     have to guess at gets used once.
*/

interface SQLResult {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated: boolean
  limit: number
  elapsed_ms: number
  connection: string
}

interface SavedQuery {
  id: number
  name: string
  description: string
  sql_text: string
  is_shared: boolean
  is_mine: boolean
  created_by_name: string
  updated_at: string
}

interface SchemaTable {
  table: string
  columns: string[]
}

const STARTER = `-- Anything you can SELECT, you can ask for. One statement at a time.
--   Ctrl+Enter runs      Tab indents      ';' in the middle is refused
--
-- 52 curated data sources already exist in the Report Builder; this is for the
-- questions that span them.

SELECT c.state,
       count(*)                                   AS customers,
       count(*) FILTER (WHERE a.account_no IS NOT NULL) AS with_a_card
  FROM app.customers c
  LEFT JOIN app.accounts a ON a.cif = c.cif
 WHERE COALESCE(btrim(c.state), '') <> ''
 GROUP BY 1
 ORDER BY customers DESC
 LIMIT 20`

export default function SQLConsole() {
  const [sql, setSql] = useState(STARTER)
  const [limit, setLimit] = useState(2000)
  const [res, setRes] = useState<SQLResult | null>(null)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [schema, setSchema] = useState<SchemaTable[] | null>(null)
  const [schemaQ, setSchemaQ] = useState('')
  const [showSchema, setShowSchema] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')
  const [saveShared, setSaveShared] = useState(false)
  const [deleting, setDeleting] = useState<SavedQuery | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // EVERY READ HERE GOES THROUGH unwrap/unwrapList. respond() on the Go side wraps
  // payloads as { data, data_source, data_as_of }, so apiFetch/apiPost resolve to the
  // ENVELOPE, not the payload. Without this the saved list is an object and .map throws
  // "map is not a function" on first paint — which is what this page did in production.
  const loadSaved = useCallback(() => {
    apiFetch('/api/bi-sql/saved')
      .then(res => setSaved(unwrapList<SavedQuery>(res)))
      .catch(() => { /* listed empty */ })
  }, [])
  useEffect(() => { loadSaved() }, [loadSaved])

  const run = useCallback(async () => {
    setRunning(true); setErr(null)
    try {
      setRes(unwrap<SQLResult>(await apiPost('/api/bi-sql/run', { sql, limit })))
    } catch (e: any) {
      setRes(null)
      setErr(e?.message || 'The query could not be run')
    } finally {
      setRunning(false)
    }
  }, [sql, limit])

  // Ctrl/Cmd+Enter from anywhere on the page, because an analyst's hands are on the
  // keyboard and reaching for a button to re-run is the thing that makes a console
  // tiring to use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run])

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Tab') return
    // Tab indents instead of leaving the field. A SQL editor that cannot indent is a
    // note-taking app.
    e.preventDefault()
    const ta = e.currentTarget
    const { selectionStart: s, selectionEnd: en, value } = ta
    const next = value.slice(0, s) + '  ' + value.slice(en)
    setSql(next)
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2 })
  }

  async function doSave() {
    if (!saveName.trim()) { toast.error('Give the query a name'); return }
    try {
      await apiPost('/api/bi-sql/saved', {
        name: saveName.trim(), description: saveDesc, sql, is_shared: saveShared,
      })
      toast.success('Saved')
      setSaveOpen(false); setSaveName(''); setSaveDesc(''); setSaveShared(false)
      loadSaved()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save')
    }
  }

  async function doDelete() {
    if (!deleting) return
    try {
      await apiDelete(`/api/bi-sql/saved/${deleting.id}`)
      toast.success('Deleted')
      setDeleting(null); loadSaved()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not delete')
    }
  }

  async function toggleShared(q: SavedQuery) {
    try {
      await apiPut(`/api/bi-sql/saved/${q.id}`, { is_shared: !q.is_shared })
      loadSaved()
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not change sharing')
    }
  }

  function openSchema() {
    setShowSchema(true)
    if (!schema) {
      apiFetch('/api/bi-sql/schema')
        .then(res => setSchema(unwrapList<SchemaTable>(res)))
        .catch(() => toast.error('Could not load the schema'))
    }
  }

  function insertAtCursor(text: string) {
    const ta = taRef.current
    if (!ta) { setSql(s => s + text); return }
    const { selectionStart: s, selectionEnd: e, value } = ta
    setSql(value.slice(0, s) + text + value.slice(e))
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = s + text.length
    })
  }

  const cols: TableCol<Record<string, unknown>>[] = useMemo(
    () => (res?.columns ?? []).map(k => ({
      key: k,
      label: labelFor(k),
      sortable: true,
      align: alignFor(k),
      render: (r: Record<string, unknown>) => fmtValue(k, r[k]),
    })),
    [res?.columns],
  )

  const filteredSchema = useMemo(() => {
    if (!schema) return []
    const q = schemaQ.trim().toLowerCase()
    if (!q) return schema.slice(0, 60)
    return schema.filter(t =>
      t.table.toLowerCase().includes(q) ||
      t.columns.some(c => c.toLowerCase().includes(q)),
    ).slice(0, 60)
  }, [schema, schemaQ])

  // A read-only role is the difference between "the console will not return a secret"
  // and "the connection cannot read one". Shown plainly rather than buried.
  const hardened = !!res?.connection?.startsWith('read-only role')

  return (
    <Page
      title="SQL Console"
      subtitle="Read-only SQL over the whole workspace, for BI. One statement at a time; Ctrl+Enter runs it."
      actions={
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" icon="schema" onClick={openSchema}>Schema</Button>
          <Button variant="secondary" size="sm" icon="bookmark_add"
            onClick={() => setSaveOpen(true)}>Save</Button>
          <Button icon="play_arrow" onClick={run} loading={running}>Run</Button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={run} />

      <div style={{ display: 'grid', gap: SP[6], gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 300px)' }}
        className="sqlc-grid">
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: SP[6] }}>
          <SectionCard
            title="Query"
            subtitle="SELECT and WITH only. Writes are refused by Postgres, not by this page."
            actions={
              <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--txt3)' }}>Row limit</span>
                <Input type="number" value={String(limit)} min={1} max={20000}
                  onChange={e => setLimit(Math.max(1, Math.min(20000, Number(e.target.value) || 2000)))}
                  wrapStyle={{ width: 110, marginBottom: 0 }} />
              </div>
            }
          >
            <textarea
              id="bi-sql-editor"
              ref={taRef}
              value={sql}
              onChange={e => setSql(e.target.value)}
              onKeyDown={onTextareaKey}
              spellCheck={false}
              rows={16}
              style={{
                width: '100%', resize: 'vertical', fontFamily: MONO, fontSize: 13,
                lineHeight: 1.6, padding: SP[4], tabSize: 2,
                color: 'var(--txt)', background: 'var(--input-bg)',
                border: '1px solid var(--input-bdr)', borderRadius: 8, outline: 'none',
                whiteSpace: 'pre', overflowX: 'auto',
              }}
            />
          </SectionCard>

          {res && (
            <SectionCard
              title="Result"
              subtitle={`${res.row_count.toLocaleString('en-NG')} row${res.row_count === 1 ? '' : 's'} · ${res.elapsed_ms.toLocaleString('en-NG')} ms`}
              actions={res.row_count > 0 ? (
                <Button variant="secondary" size="sm" icon="download"
                  onClick={() => downloadRowsCSV('sql-console', res.rows, res.columns)}>CSV</Button>
              ) : undefined}
            >
              {/* Truncation is stated, never implied. A cut result that looks complete is
                  the one way a console can mislead an analyst into a wrong conclusion. */}
              {res.truncated && (
                <div style={{
                  background: 'var(--chip-bg)', border: `1px solid ${AMBER}`,
                  borderLeft: `3px solid ${AMBER}`, borderRadius: 6,
                  padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[4],
                  fontSize: 13, color: 'var(--txt)',
                }}>
                  <strong>This is the first {res.limit.toLocaleString('en-NG')} rows, not all of them.</strong>{' '}
                  Raise the row limit, or aggregate in the query — a total computed from a
                  truncated result is wrong.
                </div>
              )}
              <DataTable
                cols={cols}
                rows={res.rows}
                pageSize={res.rows.length > 50 ? 50 : undefined}
                emptyText={<EmptyState icon="inbox" title="No Rows"
                  description="The query ran and matched nothing. That is an answer." />}
              />
              <div style={{
                marginTop: SP[4], fontSize: 11.5, color: 'var(--txt3)',
                display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                  background: hardened ? GREEN : AMBER,
                }} />
                <span>Ran on the {res.connection}.</span>
                {!hardened && (
                  <span>
                    The console refuses to return credential columns, but the connection
                    itself can still read them — see migration 351 to move that boundary
                    into Postgres.
                  </span>
                )}
              </div>
            </SectionCard>
          )}

          {!res && !err && (
            <SectionCard title="Nothing Run Yet">
              <EmptyState icon="terminal" title="Write a query and press Ctrl+Enter"
                description="The example above counts customers by state and how many hold a card." />
            </SectionCard>
          )}
        </div>

        {/* ── Saved ── */}
        <div style={{ minWidth: 0 }}>
          <SectionCard title="Saved Queries" padding={false}
            subtitle={saved.length ? undefined : 'Nothing saved yet'}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {saved.map(q => (
                <div key={q.id} style={{
                  padding: `${SP[3]} ${SP[4]}`, borderTop: '1px solid var(--bdr)',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: SP[2], flexWrap: 'wrap' }}>
                    <button onClick={() => { setSql(q.sql_text); toast.success(`Loaded "${q.name}"`) }}
                      style={{
                        border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                        fontSize: 13, fontWeight: FW.semibold, color: NAVY, textAlign: 'left',
                      }}>
                      {q.name}
                    </button>
                    {q.is_shared && <Badge variant="info">Shared</Badge>}
                    {!q.is_mine && <Badge variant="default">{q.created_by_name}</Badge>}
                  </div>
                  {q.description && (
                    <span style={{ fontSize: 11.5, color: 'var(--txt3)', lineHeight: 1.35 }}>
                      {q.description}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--txt3)' }}>
                    {fmtDatetime(q.updated_at)}
                  </span>
                  {q.is_mine && (
                    <div style={{ display: 'flex', gap: SP[2], marginTop: 2 }}>
                      <button onClick={() => toggleShared(q)} style={linkBtn}>
                        {q.is_shared ? 'Make private' : 'Share with BI'}
                      </button>
                      <button onClick={() => setDeleting(q)} style={linkBtn}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
              {!saved.length && (
                <div style={{ padding: SP[4] }}>
                  <EmptyState icon="bookmark" title="No Saved Queries"
                    description="Save one and it is here next month. A shared query is visible to the other analysts, and editable only by you." />
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      </div>

      {/* ── Schema browser ── */}
      <Modal open={showSchema} onClose={() => setShowSchema(false)} title="Schema" width={720} maxHeight="70vh">
        <SearchInput value={schemaQ} onChange={setSchemaQ}
          placeholder="Find a table or column…" />
        <p style={{ fontSize: 12, color: 'var(--txt3)', margin: `${SP[2]} 0 ${SP[4]}` }}>
          Click a table to insert its name. Credential columns are not listed — a console
          that suggests a column it will then refuse only teaches people to try.
        </p>
        {!schema && <EmptyState icon="hourglass_top" title="Reading the Schema" />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {filteredSchema.map(t => (
            <div key={t.table} style={{
              border: '1px solid var(--bdr)', borderRadius: 8, padding: SP[3],
            }}>
              <button onClick={() => { insertAtCursor(`app.${t.table}`); setShowSchema(false) }}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  fontFamily: MONO, fontSize: 12.5, fontWeight: FW.semibold, color: NAVY,
                }}>
                app.{t.table}
              </button>
              <div style={{
                marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6,
                fontFamily: MONO, fontSize: 11, color: 'var(--txt3)',
              }}>
                {t.columns.map(c => <span key={c}>{c}</span>)}
              </div>
            </div>
          ))}
          {schema && !filteredSchema.length && (
            <EmptyState icon="search_off" title="Nothing Matches That" />
          )}
        </div>
      </Modal>

      {/* ── Save ── */}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save this query" width={520}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button onClick={doSave}>Save</Button>
          </div>
        }>
        <Input label="Name" value={saveName} onChange={e => setSaveName(e.target.value)}
          placeholder="Customers by state, with card penetration" />
        <Input label="What It Answers" value={saveDesc} onChange={e => setSaveDesc(e.target.value)}
          hint="One line, so the next person knows whether to open it." />
        <label style={{ display: 'flex', gap: SP[2], alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" id="bi-sql-share" checked={saveShared}
            onChange={e => setSaveShared(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Share with the BI team
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--txt3)' }}>
              Visible to the other analysts and still only editable by you. The console is
              BI-only, so this never reaches a department.
            </span>
          </span>
        </label>
      </Modal>

      <ConfirmModal
        open={!!deleting}
        title="Delete this saved query?"
        body={deleting ? `"${deleting.name}" will be removed${deleting.is_shared ? ', including for the colleagues it is shared with' : ''}.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={doDelete}
        onClose={() => setDeleting(null)}
      />

      <style>{`
        @media (max-width: 1000px) {
          .sqlc-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
        #bi-sql-editor:focus { border-color: ${NAVY}; box-shadow: 0 0 0 3px rgba(14,40,65,.12); }
      `}</style>
    </Page>
  )
}

const linkBtn: React.CSSProperties = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
  fontSize: 11.5, color: 'var(--txt3)', textDecoration: 'underline',
}
