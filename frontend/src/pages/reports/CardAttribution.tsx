import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Page, SectionCard, DataTable, ErrBanner, KpiCard, Modal, Button, Pill, DateFilter, Tabs, Select, Input, Textarea,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtNum, today, yearStart } from '../../lib/fmt'
import { GREEN, AMBER, BLUE, NAVY, NUM, TEXT, FW, SP } from '../../lib/design'
import { useLiveData } from '../../hooks/useRealtime'
import { currentUser, hasPage } from '../../hooks/useAuth'
import { toast } from 'sonner'

/*
  Card Sales Credit.

  Fixed deposits and loans carry the officer who booked them; cards carried nobody.
  Cards are not in core banking and the account feed has no officer column, so every
  card-per-officer figure came out empty — none of this year's card accounts matched an
  officer. This page is where a seller is recorded against a card, one at a time or in
  bulk, and that credit flows straight into the management and sales reports.

  The uncredited cards are the default view on purpose: the gap is the work.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

type Basis = 'attributed' | 'issuance' | 'legacy_book' | 'unattributed'

interface CardRow {
  account_no: string
  cif: string
  name_on_card: string
  product_line: 'card' | 'prepaid'
  product_name: string
  status: string
  opened_date: string | null
  officer_id: number | null
  officer_name: string
  introducer: string
  basis: Basis
}

interface PersonRow {
  person: string
  role: string
  officer_id: number | null
  cards: number
  credit_cards: number
  prepaid_cards: number
  live: number
  via_attribution: number
  via_issuance: number
  via_legacy_book: number
}

interface Coverage {
  total: number
  credited: number
  uncredited: number
  via_attribution: number
  via_issuance: number
  via_legacy_book: number
}

interface Person { id: number; full_name: string; role: string }

const BASIS: Record<Basis, { label: string; color: string; hint: string }> = {
  attributed:   { label: 'Credited Here',   color: GREEN, hint: 'Recorded on this page' },
  issuance:     { label: 'From Issuance',   color: BLUE,  hint: 'Seller named when the card request was raised' },
  legacy_book:  { label: 'Legacy CIF Book', color: NAVY,  hint: 'Matched through the old customer book, which covers only older customers' },
  unattributed: { label: 'Not Credited',    color: AMBER, hint: 'Nobody is recorded as having sold this card' },
}

type TabKey = 'uncredited' | 'credited' | 'all'

// The list endpoint returns at most this many cards per window.
const ROW_CAP = 2000
// And the bulk endpoint credits at most this many at once.
const BULK_CAP = 1000

const productLabel = (r: CardRow) => (r.product_line === 'card' ? 'Credit Card' : 'Prepaid')
const roleText = (role: string) => role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CardAttribution() {
  const [from, setFrom] = useState(yearStart())
  const [to, setTo]     = useState(today())
  const [cards, setCards]       = useState<CardRow[]>([])
  const [people, setPeople]     = useState<PersonRow[]>([])
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [staff, setStaff]       = useState<Person[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [tab, setTab]           = useState<TabKey>('uncredited')
  const [selected, setSelected] = useState<Set<string | number>>(new Set())
  const [crediting, setCrediting] = useState<CardRow[] | null>(null)

  // Mirrors the backend write guard: the cards team, BI, and heads and management (who
  // hold "executive"). Sales officers read the credit but cannot assign it.
  const user = currentUser()
  const canCredit = !!user && (user.role === 'admin' || hasPage('cards', user) || hasPage('reports', user) || hasPage('executive', user))

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const qs = `from=${from}&to=${to}`
    try {
      const [c, p, cov] = await Promise.all([
        apiFetch<CardRow[]>(`/api/cards/attribution?${qs}&limit=${ROW_CAP}`),
        apiFetch<PersonRow[]>(`/api/cards/attribution/summary?${qs}`),
        apiFetch<Coverage>(`/api/cards/attribution/coverage?${qs}`),
      ])
      setCards(Array.isArray(c) ? c : [])
      setPeople(Array.isArray(p) ? p : [])
      setCoverage(cov)
    } catch (e: any) {
      if (!silent) setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])
  // The cards topic also watches issuance and attributions, so a credit made by a
  // colleague shows here without a refresh.
  useLiveData(() => load(true), { topics: ['cards'] })

  useEffect(() => {
    if (!canCredit) return
    apiFetch<Person[]>('/api/cards/attribution/people')
      .then(r => setStaff(Array.isArray(r) ? r : []))
      .catch(() => setStaff([]))
  }, [canCredit])

  const rows = useMemo(() => cards.filter(c =>
    tab === 'all' ? true : tab === 'credited' ? c.officer_id != null : c.officer_id == null,
  ), [cards, tab])

  const credited = people.filter(p => p.officer_id != null)
  const pct = coverage && coverage.total ? Math.round((100 * coverage.credited) / coverage.total) : null
  const selectedRows = cards.filter(c => selected.has(c.account_no))

  function changeTab(key: string) {
    setTab(key as TabKey)
    setSelected(new Set())
  }

  const cardCols: TableCol<CardRow>[] = [
    { key: 'name_on_card', label: 'Card', render: r => (
      <div style={{ minWidth: 190 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: r.name_on_card ? 'var(--txt)' : 'var(--txt3)' }}>
          {r.name_on_card || 'Name not on file'}
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2, ...NUM }}>
          {r.account_no} · {productLabel(r)}{r.product_name ? `, ${r.product_name}` : ''}
        </div>
      </div>
    ) },
    { key: 'opened_date', label: 'Opened', sortable: true, render: r => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtDate(r.opened_date)}</span>
    ) },
    { key: 'officer_name', label: 'Sold By', render: r => r.officer_id != null ? (
      <div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.officer_name}</div>
        {r.introducer && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>Introduced by {r.introducer}</div>}
      </div>
    ) : r.introducer ? (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Introduced by {r.introducer}</span>
    ) : (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>—</span>
    ) },
    { key: 'basis', label: 'Recorded', render: r => {
      const b = BASIS[r.basis] ?? BASIS.unattributed
      return <span title={b.hint}><Pill label={b.label} color={b.color} bg={`${b.color}18`} /></span>
    } },
    ...(canCredit ? [{
      key: '_credit', label: '', align: 'right' as const, render: (r: CardRow) => (
        <Button type="button" size="sm" variant={r.officer_id == null ? 'primary' : 'secondary'}
          onClick={() => setCrediting([r])}>{r.officer_id == null ? 'Credit' : 'Change'}</Button>
      ),
    }] : []),
  ]

  const personCols: TableCol<PersonRow>[] = [
    { key: 'person', label: 'Person', render: r => (
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.person}</div>
        {r.role && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{roleText(r.role)}</div>}
      </div>
    ) },
    { key: 'cards', label: 'Cards', align: 'right', sortable: true, render: r => (
      <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(r.cards)}</span>
    ) },
    { key: 'credit_cards', label: 'Credit', align: 'right', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtNum(r.credit_cards)}</span> },
    { key: 'prepaid_cards', label: 'Prepaid', align: 'right', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtNum(r.prepaid_cards)}</span> },
    { key: 'via_attribution', label: 'How Recorded', render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {[
          r.via_attribution ? `${fmtNum(r.via_attribution)} here` : '',
          r.via_issuance ? `${fmtNum(r.via_issuance)} at issuance` : '',
          r.via_legacy_book ? `${fmtNum(r.via_legacy_book)} legacy book` : '',
        ].filter(Boolean).join(' · ')}
      </span>
    ) },
  ]

  const tabs = [
    { key: 'uncredited', label: 'Not Credited', badge: coverage?.uncredited },
    { key: 'credited', label: 'Credited', badge: coverage?.credited },
    { key: 'all', label: 'All Cards', badge: coverage?.total },
  ]

  return (
    <Page
      title="Card Sales Credit"
      subtitle="Who brought each card in. Cards are not in core banking, so the seller is recorded here and flows into the management and sales reports."
      actions={<DateFilter from={from} to={to} align="right" onChange={(f, t) => { setFrom(f); setTo(t); setSelected(new Set()) }} />}
      loading={loading && !coverage && !error}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="New Cards" value={coverage ? fmtNum(coverage.total) : '—'}
          sub={`Opened ${fmtDate(from)} to ${fmtDate(to)}`} icon="credit_card" accent={NAVY} loading={!coverage && !error} />
        <KpiCard label="Credited to a Person" value={coverage ? fmtNum(coverage.credited) : '—'}
          sub={coverage ? `${fmtNum(coverage.via_attribution)} here · ${fmtNum(coverage.via_issuance)} at issuance · ${fmtNum(coverage.via_legacy_book)} legacy` : ''}
          icon="how_to_reg" accent={GREEN} loading={!coverage && !error} />
        <KpiCard label="Not Credited Yet" value={coverage ? fmtNum(coverage.uncredited) : '—'}
          sub="Count as nobody's sale in the reports" icon="person_off" accent={AMBER} loading={!coverage && !error} />
        <KpiCard label="Coverage" value={pct === null ? '—' : `${pct}%`}
          sub={pct === null ? 'No cards opened in this window' : 'Share of new cards with a seller'}
          icon="donut_large" accent={pct !== null && pct >= 80 ? GREEN : AMBER} loading={!coverage && !error} />
      </div>

      <SectionCard
        title="Credited by Person"
        subtitle="Cards brought in during the window, on the same basis the reports use."
        style={{ marginBottom: 14 }}
      >
        <DataTable cols={personCols} rows={credited} keyFn={r => r.officer_id ?? r.person}
          loading={loading && !people.length}
          emptyText="No card opened in this window has a seller recorded yet." />
      </SectionCard>

      <SectionCard
        title="Cards"
        subtitle={canCredit
          ? 'Select cards to credit several to the same person, or credit one from its row.'
          : 'Crediting is done by the cards team, BI and heads.'}
      >
        <div style={{ marginBottom: SP[3] }}>
          <Tabs tabs={tabs} active={tab} onChange={changeTab} />
        </div>
        {cards.length >= ROW_CAP && (
          <div role="status" style={{ marginBottom: SP[3], fontSize: TEXT.sm, color: AMBER }}>
            Showing the {fmtNum(ROW_CAP)} most recently opened cards in this window. Narrow the dates to reach the rest.
          </div>
        )}
        <DataTable
          cols={cardCols}
          rows={rows}
          keyFn={r => r.account_no}
          loading={loading && !cards.length}
          pageSize={25}
          searchKeys={['account_no', 'cif', 'name_on_card', 'officer_name', 'introducer']}
          searchPlaceholder="Search by name, account or CIF"
          selectable={canCredit}
          selectedIds={selected}
          onSelect={setSelected}
          bulkBar={canCredit && selected.size > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                {selected.size > BULK_CAP ? `Choose at most ${fmtNum(BULK_CAP)} cards at a time` : `${fmtNum(selected.size)} selected`}
              </span>
              <Button type="button" size="sm" variant="primary" icon="how_to_reg"
                disabled={selected.size > BULK_CAP || !selectedRows.length}
                onClick={() => setCrediting(selectedRows)}>
                Credit {fmtNum(selected.size)} {selected.size === 1 ? 'Card' : 'Cards'}
              </Button>
            </div>
          ) : undefined}
          emptyText={tab === 'uncredited'
            ? 'Every card opened in this window has a seller recorded.'
            : 'No cards match.'}
        />
      </SectionCard>

      {crediting && (
        <CreditModal
          accounts={crediting}
          staff={staff}
          onClose={() => setCrediting(null)}
          onDone={() => { setCrediting(null); setSelected(new Set()); load(true) }}
        />
      )}
    </Page>
  )
}

// ── Credit ────────────────────────────────────────────────────────────────────

function CreditModal({ accounts, staff, onClose, onDone }: {
  accounts: CardRow[]
  staff: Person[]
  onClose: () => void
  onDone: () => void
}) {
  const single = accounts.length === 1 ? accounts[0] : null
  const [officerId, setOfficerId] = useState(single?.officer_id != null ? String(single.officer_id) : '')
  const [introducer, setIntroducer] = useState(single?.introducer ?? '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const canSave = !!officerId || !!introducer.trim()
  const replacing = accounts.filter(a => a.officer_id != null).length

  async function save() {
    setSaving(true)
    const body = {
      sales_officer_id: officerId ? Number(officerId) : null,
      introducer: introducer.trim(),
      note,
    }
    try {
      if (single) {
        await apiPost('/api/cards/attribution', { ...body, account_no: single.account_no })
        toast.success(`Card ${single.account_no} credited`)
      } else {
        const res = await apiPost<{ credited: number; skipped: string[] }>('/api/cards/attribution/bulk', {
          ...body, account_nos: accounts.map(a => a.account_no),
        })
        toast.success(`${fmtNum(res.credited)} cards credited${res.skipped.length ? `; ${fmtNum(res.skipped.length)} skipped as not card accounts` : ''}`)
      }
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={single ? `Credit Card ${single.account_no}` : `Credit ${fmtNum(accounts.length)} Cards`}
      width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SP[2] }}>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={saving} disabled={!canSave || saving} onClick={save}>
            {single ? 'Save Credit' : `Credit ${fmtNum(accounts.length)} Cards`}
          </Button>
        </div>
      }
    >
      <p style={{ margin: `0 0 ${SP[3]}`, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.55 }}>
        {single
          ? `${single.name_on_card || 'Name not on file'} · ${productLabel(single)} · opened ${fmtDate(single.opened_date)}`
          : 'Every selected card is credited to the same person.'}
        {replacing > 0 && ` ${single ? 'This replaces the credit already recorded.' : `${fmtNum(replacing)} of them already have credit, which this replaces.`}`}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <Select id="cc-officer" label="Sold By" hint="Anyone on staff can be credited, not only the sales team"
          value={officerId} onChange={e => setOfficerId(e.target.value)}>
          <option value="">No Seller, Introducer Only</option>
          {staff.map(p => <option key={p.id} value={String(p.id)}>{p.full_name}</option>)}
        </Select>
        <Input id="cc-introducer" label="Introducer (Optional)" value={introducer}
          onChange={e => setIntroducer(e.target.value)} placeholder="Who brought the business, if not the seller" />
        <Textarea id="cc-note" label="Note (Optional)" value={note} rows={2}
          onChange={e => setNote(e.target.value)} placeholder="For example: branch walk-in, referral from a customer" />
      </div>
    </Modal>
  )
}
