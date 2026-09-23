import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Button, Input, Modal, Tabs, EmptyState, Spinner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// Merchant names — reviewing the merges that keep one merchant from ranking as three.
//
// The feed truncates merchant_name at ~21 characters, so PAYCOM NIGERIA LIMITED
// arrives as PAYCOM NIGERIA LIMITE, PAYCOM NIGERIA LIMIT and PAYCOM NIGERIA LTD,
// and every "top merchants" chart splits it. A daily job (migration 244) merges a
// truncated spelling into the fuller spelling it is a strict prefix of.
//
// Those merges apply immediately — a split merchant is wrong until it is fixed —
// and are flagged for review here. This page is where someone confirms them, drops
// the ones that are wrong, or writes a mapping the prefix rule cannot see.

interface Alias {
  clean_name: string
  canonical: string
  source: string
  reviewed: boolean
  created_at: string
  short_txns: number
  short_spend: number
  canonical_txns: number
  canonical_spend: number
}

interface Counts {
  total?: number
  pending?: number
  reviewed?: number
  manual?: number
  automatic?: number
}

const naira = (v: number) => '₦' + Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function MerchantNames() {
  const [aliases, setAliases] = useState<Alias[]>([])
  const [counts, setCounts] = useState<Counts>({})
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addFrom, setAddFrom] = useState('')
  const [addTo, setAddTo] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (st: string, q: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<any>(`/api/admin/merchant-aliases?status=${st}&q=${encodeURIComponent(q)}&limit=300`)
      const d = r?.data ?? r ?? {}
      setAliases(d.aliases ?? [])
      setCounts(d.counts ?? {})
    } catch (e: any) { setError(e?.message ?? 'Could not load merchant names') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(status, search) }, [load, status, search])

  const act = async (path: string, name: string) => {
    setBusy(name); setError(null)
    try {
      await apiPost(`/api/admin/merchant-aliases/${path}`, { clean_name: name })
      await load(status, search)
    } catch (e: any) { setError(e?.message ?? 'That did not work') }
    finally { setBusy(null) }
  }

  const addMapping = async () => {
    setSaving(true); setAddErr(null)
    try {
      await apiPost('/api/admin/merchant-aliases', { clean_name: addFrom, canonical: addTo })
      setAddOpen(false); setAddFrom(''); setAddTo('')
      await load(status, search)
    } catch (e: any) { setAddErr(e?.message ?? 'Could not save the mapping') }
    finally { setSaving(false) }
  }

  const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th style={{
      padding: '9px 12px', textAlign: right ? 'right' : 'left', fontSize: TEXT.xs,
      fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER,
      textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap',
    }}>{children}</th>
  )

  return (
    <Page
      back={{ label: 'Data Management', to: '/reports/uploads' }}
      title="Merchant Names"
      subtitle="The card feed cuts merchant names at ~21 characters, so one merchant arrives under several spellings. These mappings merge them back together."
      loading={loading && aliases.length === 0}
      skeletonKpis={3}
      actions={<Button icon="add" onClick={() => setAddOpen(true)}>Add Mapping</Button>}
    >
      <ErrBanner error={error} onRetry={() => load(status, search)} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard label="Awaiting Review" value={fmtNum(counts.pending ?? 0)} sub="already applied to reports" icon="rule" accent={AMBER} />
        <KpiCard label="Confirmed" value={fmtNum(counts.reviewed ?? 0)} sub="checked by a person" icon="check_circle" accent={GREEN} />
        <KpiCard label="Written by Hand" value={fmtNum(counts.manual ?? 0)} sub="never overwritten by the job" icon="edit_note" accent={BLUE} />
      </div>

      <SectionCard
        title="Mappings"
        subtitle="Each row says: this spelling is counted as that one. Approving changes nothing in the data. It records that someone checked."
        actions={
          <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
            <Input placeholder="Search a merchant…" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 200 }} />
          </div>
        }
      >
        <div style={{ marginBottom: SP[3] }}>
          <Tabs
            tabs={[
              { key: 'pending', label: `Awaiting Review${counts.pending ? ` (${counts.pending})` : ''}` },
              { key: 'reviewed', label: 'Confirmed' },
              { key: 'all', label: 'All' },
            ]}
            active={status}
            onChange={setStatus}
          />
        </div>

        {loading && aliases.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size={28} /></div>
        ) : aliases.length === 0 ? (
          <EmptyState
            icon="done_all"
            title={status === 'pending' ? 'Nothing awaiting review' : 'No mappings here'}
            description={status === 'pending'
              ? 'Every merge the daily job proposed has been checked. New ones will appear here.'
              : 'Nothing matches this filter.'}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <Th>Counted As One Merchant</Th>
                  <Th right>Transactions</Th>
                  <Th right>Spend</Th>
                  <Th>Origin</Th>
                  <Th right>Action</Th>
                </tr>
              </thead>
              <tbody>
                {aliases.map(a => (
                  <tr key={a.clean_name} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '11px 12px', fontSize: TEXT.sm, fontFamily: INTER }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ ...NUM, color: 'var(--txt2)' }}>{a.clean_name}</span>
                        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>arrow_forward</span>
                        <span style={{ ...NUM, fontWeight: FW.bold, color: 'var(--txt)' }}>{a.canonical}</span>
                      </div>
                    </td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap' }}
                      title={`${fmtNum(a.short_txns)} on the short spelling, ${fmtNum(a.canonical_txns)} on the full one`}>
                      {fmtNum(a.short_txns)} + {fmtNum(a.canonical_txns)}
                    </td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap' }}>
                      {naira(Number(a.short_spend) + Number(a.canonical_spend))}
                    </td>
                    <td style={{ padding: '11px 12px', fontSize: TEXT.xs, fontFamily: INTER, whiteSpace: 'nowrap', color: 'var(--txt2)' }}>
                      {a.source === 'manual' ? 'By hand' : 'Daily job'}
                      {a.reviewed
                        ? <span style={{ color: GREEN, marginLeft: 6 }}>· confirmed</span>
                        : <span style={{ color: AMBER, marginLeft: 6 }}>· unchecked</span>}
                      <div style={{ color: 'var(--txt3)', marginTop: 2 }}>{fmtDate(a.created_at)}</div>
                    </td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', gap: SP[2] }}>
                        {!a.reviewed && (
                          <Button size="sm" variant="secondary" loading={busy === a.clean_name}
                            onClick={() => act('approve', a.clean_name)}>Keep</Button>
                        )}
                        <Button size="sm" variant="ghost" loading={busy === a.clean_name}
                          onClick={() => act('reject', a.clean_name)}
                          style={{ color: RED }}>Separate</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ margin: `${SP[4]} 0 0`, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6 }}>
          <strong>Separate</strong> removes the mapping, so the two spellings count as different merchants again,
          and the decision sticks: the daily job records it and will not propose that merge again. Use
          <strong>Add Mapping</strong> for a merge the automatic rule cannot see — those are never overwritten
          either.
        </p>
      </SectionCard>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a mapping" width={560}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={addMapping} loading={saving} disabled={!addFrom.trim() || !addTo.trim()}>Save</Button>
          </div>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
            Use this for merges the automatic rule cannot see. A misspelling, or a trading name that is not a
            prefix of the full one. Names are cleaned the same way the feed's are (upper case, LIMITED → LTD)
            before being stored.
          </p>
          <Input label="This spelling" placeholder="e.g. PAYCOM NIGERIA LIMIT" value={addFrom} onChange={e => setAddFrom(e.target.value)} />
          <Input label="Counts as" placeholder="e.g. PAYCOM NIGERIA LTD" value={addTo} onChange={e => setAddTo(e.target.value)} />
          {addErr && <div style={{ fontSize: TEXT.sm, color: RED, fontFamily: INTER }}>{addErr}</div>}
        </div>
      </Modal>

      <div style={{
        marginTop: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
        background: `${NAVY}08`, border: '1px solid var(--bdr)', fontSize: TEXT.xs,
        color: 'var(--txt2)', fontFamily: INTER, lineHeight: 1.6,
      }}>
        Only card <strong>purchases</strong> are counted here. On other transaction types that same field holds a
        transfer narrative, the staff member who posted a payment, or an ATM location, which is why they are
        excluded from merchant rankings entirely.
      </div>
    </Page>
  )
}
