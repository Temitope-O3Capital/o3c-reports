import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, DataTable, Modal, Button, Select, Input, Sk,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, n } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import NewApplicationModal from '../../components/NewApplicationModal'

// The Account Officer's book.
//
// Replaces the old My Accounts page, which read crm_contacts — a one-off Zoho helpdesk
// export where only 1,794 of 29,663 rows were flagged 'customer' — and so hid 91% of
// real customers from their own officer. It also filtered on account_manager_id, a
// column that is NULL on every row, so an officer's book was always empty.
//
// This reads the customer master through /api/sales/book, which is paginated (the old
// query had no LIMIT), and links to Customer 360 by CIF rather than by row id, which
// is what made "View C360" a dead end.

interface BookRow {
  cif: string
  party_id: number | null
  full_name: string
  email: string
  phone: string
  state: string
  city: string
  account_status: string
  acquired_on: string | null
  acquired_on_source: string
  account_count: number
  officer_id: number | null
  officer_name: string | null
  active_cards: number
  card_balance_kobo: number
  max_dpd: number
  active_loans: number
  outstanding_kobo: number
  active_fds: number
  fd_principal_kobo: number
  next_maturity: string | null
}

interface Summary {
  customers: number; acquired_mtd: number; acquired_ytd: number
  undated: number; with_accounts: number
  card_balance_kobo: number; outstanding_kobo: number; fd_principal_kobo: number
  customers_in_arrears: number; fd_maturing_30d: number
}

interface Officer { id: number; full_name: string; role: string; is_active: boolean; book_size: number }

const PAGE_SIZE = 50

export default function SalesBook() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [rows, setRows] = useState<BookRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [officers, setOfficers] = useState<Officer[]>([])
  const [isHead, setIsHead] = useState(false)
  const [appFor, setAppFor] = useState<{ cif: string; name: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState(params.get('q') ?? '')
  const officerFilter = params.get('officer_id') ?? ''
  const crossSell = params.get('segment') === 'cross_sell'

  // Bulk assignment
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTo, setAssignTo] = useState('')
  const [assignReason, setAssignReason] = useState('')
  const [assigning, setAssigning] = useState(false)

  // Party (whole-person) assignment — one row's every CIF onto one officer.
  const [partyRow, setPartyRow] = useState<BookRow | null>(null)
  const [partyAssignTo, setPartyAssignTo] = useState('')
  const [partyReason, setPartyReason] = useState('')
  const [partyAssigning, setPartyAssigning] = useState(false)

  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke
  const query = useMemo(() => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(offset))
    if (dq) p.set('q', dq)
    if (officerFilter) p.set('officer_id', officerFilter)
    if (crossSell) p.set('segment', 'cross_sell')
    return p.toString()
  }, [offset, dq, officerFilter, crossSell])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const scopeQ = officerFilter ? `?officer_id=${encodeURIComponent(officerFilter)}` : ''
      const [b, s, o] = await Promise.all([
        apiFetch<{ data: BookRow[]; total: number; scope: { is_head: boolean } }>(`/api/sales/book?${query}`),
        apiFetch<{ data: Summary }>(`/api/sales/book/summary${scopeQ}`),
        apiFetch<{ data: Officer[] }>('/api/sales/officers'),
      ])
      setRows(b.data ?? []); setTotal(b.total ?? 0); setIsHead(!!b.scope?.is_head)
      setSummary(s.data); setOfficers(o.data ?? [])
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load the book')
    } finally {
      setLoading(false)
    }
  }, [query, officerFilter])

  useEffect(() => { load() }, [load])
  // Changing scope or search invalidates the current page position.
  useEffect(() => { setOffset(0); setSelected(new Set()) }, [officerFilter, dq])

  async function doAssign() {
    if (!assignTo) return
    setAssigning(true)
    try {
      const res = await apiFetch<{ data: { assigned: number; skipped: number } }>(
        '/api/sales/book/bulk-assign',
        {
          method: 'POST',
          body: JSON.stringify({
            cifs: Array.from(selected),
            officer_id: assignTo === 'unassign' ? 0 : Number(assignTo),
            reason: assignReason,
          }),
        },
      )
      setAssignOpen(false); setSelected(new Set())
      setAssignReason(''); setAssignTo('')
      await load()
      if (res.data?.skipped) {
        setErr(`${res.data.assigned} assigned; ${res.data.skipped} skipped (already assigned, or no such customer)`)
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Assignment failed')
    } finally {
      setAssigning(false)
    }
  }

  // Assign a whole person: every CIF the party holds moves to one officer in a single
  // call, so a relationship never fragments across desks. Distinct from bulk-assign,
  // which moves the exact CIFs the head ticked.
  async function doAssignParty() {
    if (!partyRow?.party_id || !partyAssignTo) return
    setPartyAssigning(true)
    try {
      const res = await apiFetch<{ data: { assigned: number } }>(
        '/api/sales/book/assign-party',
        {
          method: 'POST',
          body: JSON.stringify({
            party_id: partyRow.party_id,
            officer_id: Number(partyAssignTo),
            reason: partyReason,
          }),
        },
      )
      setPartyRow(null); setPartyAssignTo(''); setPartyReason('')
      await load()
      const nCif = res.data?.assigned ?? 0
      setErr(`${nCif} card${nCif === 1 ? '' : 's'} for this person reassigned`)
    } catch (e: any) {
      setErr(e?.message ?? 'Assignment failed')
    } finally {
      setPartyAssigning(false)
    }
  }

  function toggle(cif: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(cif) ? next.delete(cif) : next.add(cif)
      return next
    })
  }

  const allOnPageSelected = rows.length > 0 && rows.every(r => selected.has(r.cif))

  const cols: TableCol<BookRow>[] = [
    ...(isHead ? [{
      key: 'select',
      label: (
        <input
          type="checkbox"
          checked={allOnPageSelected}
          onChange={e => {
            e.stopPropagation()
            setSelected(prev => {
              const next = new Set(prev)
              rows.forEach(r => allOnPageSelected ? next.delete(r.cif) : next.add(r.cif))
              return next
            })
          }}
          aria-label="Select all on this page"
        />
      ) as any,
      sortable: false,
      width: 40,
      render: (r: BookRow) => (
        <input
          type="checkbox"
          checked={selected.has(r.cif)}
          onClick={e => e.stopPropagation()}
          onChange={() => toggle(r.cif)}
          aria-label={`Select ${r.full_name}`}
        />
      ),
    } as TableCol<BookRow>] : []),
    {
      key: 'full_name', label: 'Customer', sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.full_name || '—'}</div>
          <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.cif}</div>
        </div>
      ),
    },
    {
      key: 'acquired_on', label: 'Acquired', sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm }}>{r.acquired_on ? fmtDate(r.acquired_on) : '—'}</div>
          {/* Say when a date is inferred rather than presenting it as recorded fact. */}
          {r.acquired_on_source !== 'account_created' && r.acquired_on && (
            <div style={{ fontSize: TEXT['2xs'], color: AMBER }}>
              {r.acquired_on_source === 'first_account' ? 'from first account' : 'first seen'}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'products', label: 'Relationship', sortable: false,
      render: (r: BookRow) => {
        const lines = [
          { held: r.active_cards > 0, c: PURPLE, label: `${r.active_cards} Card${r.active_cards > 1 ? 's' : ''}` },
          { held: r.active_loans > 0, c: NAVY,   label: `${r.active_loans} Loan${r.active_loans > 1 ? 's' : ''}` },
          { held: r.active_fds  > 0, c: AMBER,  label: `${r.active_fds} FD${r.active_fds > 1 ? 's' : ''}` },
        ]
        const held = lines.filter(l => l.held)
        if (!held.length) return <span style={{ color: 'var(--txt3)' }}>—</span>
        // A healthy customer on a single product line is a cross-sell opportunity.
        const crossSell = held.length === 1 && r.max_dpd === 0
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div title={`${held.length} of 3 product lines`} style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              {lines.map((l, i) => <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: l.held ? l.c : 'var(--bdr)' }} />)}
            </div>
            {held.map(l => (
              <span key={l.label} style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 7px', borderRadius: RADIUS['2xl'], background: `${l.c}18`, color: l.c, whiteSpace: 'nowrap' }}>{l.label}</span>
            ))}
            {crossSell && (
              <span title="Single-product customer — cross-sell opportunity" style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 7px', borderRadius: RADIUS['2xl'], background: `${GREEN}14`, color: GREEN, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 12 }}>trending_up</span>cross-sell
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'card_balance_kobo', label: 'Card bal.', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.card_balance_kobo > 0 ? 'var(--txt)' : 'var(--txt3)' }}>{r.card_balance_kobo ? fmtKobo(r.card_balance_kobo) : '—'}</span>,
    },
    {
      key: 'outstanding_kobo', label: 'Loans owed', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.outstanding_kobo > 0 ? RED : 'var(--txt3)' }}>{r.outstanding_kobo ? fmtKobo(r.outstanding_kobo) : '—'}</span>,
    },
    {
      key: 'fd_principal_kobo', label: 'FD principal', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.fd_principal_kobo > 0 ? GREEN : 'var(--txt3)' }}>{r.fd_principal_kobo ? fmtKobo(r.fd_principal_kobo) : '—'}</span>,
    },
    {
      key: 'max_dpd', label: 'DPD', sortable: true, align: 'right',
      render: r => (
        <span style={{ ...NUM, color: r.max_dpd > 0 ? RED : 'var(--txt3)' }}>
          {r.max_dpd > 0 ? fmtNum(r.max_dpd) : '—'}
        </span>
      ),
    },
    {
      key: 'officer_name', label: 'Officer', sortable: true,
      render: r => r.officer_name
        ? <span style={{ color: 'var(--txt2)' }}>{r.officer_name}</span>
        : <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${AMBER}1A`, color: AMBER }}>Unassigned</span>,
    },
    {
      key: 'raise_app', label: '', sortable: false, align: 'right' as const, width: 120,
      // Raise an application for this customer without leaving the book — the app modal
      // opens pre-filled with their CIF and name.
      render: (r: BookRow) => (
        <Button variant="ghost" size="xs" icon="note_add"
          onClick={e => { e.stopPropagation(); setAppFor({ cif: r.cif, name: r.full_name }) }}>
          Raise app
        </Button>
      ),
    } as TableCol<BookRow>,
    ...(isHead ? [{
      key: 'assign_person',
      label: '',
      sortable: false,
      align: 'right' as const,
      width: 140,
      // Whole-person assignment: moves every CIF this party holds, not just this row.
      // Only offered when the row is linked to a party.
      render: (r: BookRow) => r.party_id ? (
        <Button
          variant="ghost"
          size="xs"
          icon="group_add"
          onClick={e => {
            e.stopPropagation()
            setPartyRow(r)
            setPartyAssignTo(r.officer_id ? String(r.officer_id) : '')
            setPartyReason('')
          }}
        >
          Assign person
        </Button>
      ) : null,
    } as TableCol<BookRow>] : []),
  ]

  const pageFrom = total === 0 ? 0 : offset + 1
  const pageTo = Math.min(offset + PAGE_SIZE, total)

  return (
    <Page
      title={isHead ? 'Customer Book' : 'My Book'}
      subtitle={isHead ? 'Every customer and the officer who owns them' : 'The customers you own as account officer'}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isHead && (
            <select
              value={officerFilter}
              onChange={e => {
                const p = new URLSearchParams(params)
                e.target.value ? p.set('officer_id', e.target.value) : p.delete('officer_id')
                setParams(p)
              }}
              style={{
                padding: '7px 10px', borderRadius: RADIUS.md, fontSize: TEXT.sm,
                border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
              }}
            >
              <option value="">All officers</option>
              <option value="unassigned">Unassigned</option>
              {officers.map(o => (
                <option key={o.id} value={o.id}>{o.full_name} ({o.book_size})</option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              const p = new URLSearchParams(params)
              crossSell ? p.delete('segment') : p.set('segment', 'cross_sell')
              setParams(p); setOffset(0)
            }}
            title="Customers on a single product line and not in arrears — expansion targets"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: RADIUS.md,
              fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
              border: `1px solid ${crossSell ? GREEN : 'var(--bdr)'}`,
              background: crossSell ? `${GREEN}14` : 'var(--card)', color: crossSell ? GREEN : 'var(--txt2)',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>trending_up</span>
            Cross-sell targets
          </button>
          <input
            placeholder="Search name, CIF, phone…"
            defaultValue={search}
            onKeyDown={e => { if (e.key === 'Enter') setSearch((e.target as HTMLInputElement).value) }}
            style={{
              padding: '7px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, width: 240,
              border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
            }}
          />
          {isHead && selected.size > 0 && (
            <Button variant="primary" icon="how_to_reg" onClick={() => setAssignOpen(true)}>
              Assign {selected.size}
            </Button>
          )}
        </div>
      }
    >
      {err && (
        <div style={{
          marginBottom: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md,
          background: `${AMBER}0F`, border: `1px solid ${AMBER}33`, fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>{err}</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Customers" value={summary ? fmtNum(summary.customers) : '—'}
          sub={summary ? `${fmtNum(summary.with_accounts)} with products` : undefined}
          icon="groups" accent={NAVY} loading={loading} />
        <KpiCard label="Acquired MTD" value={summary ? fmtNum(summary.acquired_mtd) : '—'}
          sub={summary ? `${fmtNum(summary.acquired_ytd)} YTD` : undefined}
          icon="person_add" accent={GREEN} loading={loading} />
        <KpiCard label="In arrears" value={summary ? fmtNum(summary.customers_in_arrears) : '—'}
          sub="Customers with days past due"
          icon="warning" accent={summary && summary.customers_in_arrears > 0 ? RED : NAVY} loading={loading} />
        <KpiCard label="FD maturing 30d" value={summary ? fmtNum(summary.fd_maturing_30d) : '—'}
          sub="Cross-sell window"
          icon="event" accent={BLUE} loading={loading} />
      </div>

      {/* Portfolio composition — the book's value across the three product lines, plus
          net position (deposits held minus credit outstanding). */}
      {summary && (
        <SectionCard title="Portfolio composition" subtitle="Value across the three product lines" style={{ marginBottom: SP[4] }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
            {[
              { label: 'Card balances', value: summary.card_balance_kobo, color: PURPLE, icon: 'credit_card' },
              { label: 'Loans outstanding', value: summary.outstanding_kobo, color: NAVY, icon: 'account_balance_wallet' },
              { label: 'FD principal', value: summary.fd_principal_kobo, color: AMBER, icon: 'savings' },
              { label: 'Net position', value: summary.fd_principal_kobo - summary.outstanding_kobo, color: (summary.fd_principal_kobo - summary.outstanding_kobo) >= 0 ? GREEN : RED, icon: 'balance', net: true },
            ].map(m => (
              <div key={m.label} style={{ borderLeft: `3px solid ${m.color}`, paddingLeft: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: m.color }}>{m.icon}</span>
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{m.label}</span>
                </div>
                <div style={{ ...NUM, fontSize: 20, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1 }}>
                  {m.net && m.value < 0 ? `-${fmtKobo(Math.abs(m.value))}` : fmtKobo(m.value)}
                </div>
                {m.net && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>deposits − credit</div>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title={officerFilter === 'unassigned' ? 'Unassigned customers' : 'Customers'}
        subtitle={loading ? undefined : `${fmtNum(pageFrom)}–${fmtNum(pageTo)} of ${fmtNum(total)}`}
        padding={false}
      >
        <DataTable<BookRow>
          cols={cols}
          rows={rows}
          loading={loading}
          skeletonRows={8}
          emptyText={
            officerFilter === 'unassigned'
              ? 'Every customer has an account officer'
              : isHead
                ? 'No customers match'
                : 'No customers are assigned to you yet. Ask your team lead to assign your book'
          }
          keyFn={r => r.cif}
          onRowClick={r => navigate(`/sales/book/${r.cif}`)}
        />

        {total > PAGE_SIZE && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: `${SP[3]} ${SP[4]}`, borderTop: '1px solid var(--bdr)',
          }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
              Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(total / PAGE_SIZE)}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
            </div>
          </div>
        )}
      </SectionCard>

      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={`Assign ${selected.size} customer${selected.size === 1 ? '' : 's'}`}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={assigning} disabled={!assignTo} onClick={doAssign}>
              Assign
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Select
            label="Account officer"
            value={assignTo}
            onChange={e => setAssignTo(e.target.value)}
          >
            <option value="">Choose an officer…</option>
            {officers.filter(o => o.is_active).map(o => (
              <option key={o.id} value={o.id}>{o.full_name}, {o.book_size} customers</option>
            ))}
            <option value="unassign">— Remove the current officer —</option>
          </Select>
          <Input
            label="Reason"
            hint="Recorded against every customer moved, so the trail explains itself later"
            value={assignReason}
            onChange={e => setAssignReason(e.target.value)}
            placeholder="e.g. Territory rebalance, officer departure"
          />
        </div>
      </Modal>

      <Modal
        open={!!partyRow}
        onClose={() => setPartyRow(null)}
        title={`Assign ${partyRow?.full_name || 'this person'}`}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setPartyRow(null)}>Cancel</Button>
            <Button variant="primary" loading={partyAssigning} disabled={!partyAssignTo} onClick={doAssignParty}>
              Assign person
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            Every card this person holds moves to the chosen officer together, so the whole
            relationship stays on one desk, not just the row you clicked.
          </div>
          <Select
            label="Account officer"
            value={partyAssignTo}
            onChange={e => setPartyAssignTo(e.target.value)}
          >
            <option value="">Choose an officer…</option>
            {officers.filter(o => o.is_active).map(o => (
              <option key={o.id} value={o.id}>{o.full_name}, {o.book_size} customers</option>
            ))}
          </Select>
          <Input
            label="Reason"
            hint="Recorded against every CIF moved, so the trail explains itself later"
            value={partyReason}
            onChange={e => setPartyReason(e.target.value)}
            placeholder="e.g. Consolidating a person's book onto one officer"
          />
        </div>
      </Modal>

      <NewApplicationModal
        open={!!appFor}
        presetCif={appFor?.cif}
        presetName={appFor?.name}
        onClose={() => setAppFor(null)}
        onSaved={() => setAppFor(null)}
      />
    </Page>
  )
}
