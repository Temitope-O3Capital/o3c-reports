import { useCallback, useEffect, useState } from 'react'
import { SectionCard, KpiCard, ErrBanner, Spinner, filterInputStyle } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, AMBER, GREEN, RED, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// The "Other" review — the loop that keeps the escape hatch a backlog rather than a bin.
//
// "Other — Describe What Happened" was added with a mandatory written explanation, and the only
// argument for offering it at all was that what agents write there becomes the NEXT named
// disposition. That argument holds only if somebody reads it, and until now reading it meant a
// hand-written SQL query one person could run.
//
// It has already paid out once: eleven notes in the first two days produced three outcomes the
// vocabulary could not previously say — Registration Not Completed, Says They Have Paid — To
// Verify, and Nothing Due This Cycle — plus the discovery that a support call had recorded
// "PAYING IN 2WEEKS TIME" with nowhere to put it. This screen is that read, repeatable.
//
// The RATE is the alarm, and it points the wrong way round from most metrics: high is bad.
// "Not Interested" quietly absorbed roughly 130 of 466 notes before anyone looked, because a
// wrong-but-available option is always faster than the right one. A climbing Other rate is the
// same failure arriving early enough to fix.

interface Note {
  id: number
  started_at: string
  purpose: string
  agent_name: string
  customer_name: string
  notes: string
  resolution: string
}
interface ByAgent {
  agent_name: string
  other_calls: number
  dispositioned_calls: number
  other_pct: number | null
}
interface Review {
  other_calls: number
  dispositioned_calls: number
  other_pct: number | null
  notes: Note[]
  by_agent: ByAgent[]
}

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

// Thresholds for the rate, and they are judgements rather than measurements — stated here so
// they can be argued with. 0.1% is where it sat when the vocabulary was healthy and three
// missing outcomes had just been added; anything past 5% means an outcome is missing badly
// enough that agents are reaching past the list to describe it.
function rateTone(pct: number | null): { color: string; verdict: string } {
  const p = Number(pct ?? 0)
  if (p >= 5)   return { color: RED,   verdict: 'An outcome is missing — read the notes below' }
  if (p >= 1.5) return { color: AMBER, verdict: 'Worth reading: a pattern may be forming' }
  return { color: GREEN, verdict: 'Healthy — Other is a last resort, as intended' }
}

export default function OtherReviewPanel() {
  const [from, setFrom] = useState(daysAgo(30))
  const [to, setTo] = useState(today())
  const [d, setD] = useState<Review | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await apiFetch<Review>(`/api/call-center/other-review?date_from=${from}&date_to=${to}`)
      setD({
        other_calls: Number(r?.other_calls ?? 0),
        dispositioned_calls: Number(r?.dispositioned_calls ?? 0),
        other_pct: r?.other_pct ?? 0,
        notes: r?.notes ?? [],
        by_agent: r?.by_agent ?? [],
      })
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const tone = rateTone(d?.other_pct ?? 0)

  return (
    <SectionCard
      title="Other — What The Vocabulary Cannot Say Yet"
      subtitle="Every call an agent could not describe from the list. Clusters here are the next named outcome."
      badge={d ? d.other_calls || undefined : undefined}
      style={{ marginTop: SP[4] }}
      actions={
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}
            style={{ ...filterInputStyle, height: 32 }} aria-label="From" />
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>to</span>
          <input type="date" value={to} min={from} max={today()} onChange={e => setTo(e.target.value)}
            style={{ ...filterInputStyle, height: 32 }} aria-label="To" />
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {loading && !d ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner size={26} /></div>
      ) : !d ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          {/* The rate, and what it means — a number nobody can act on is not a metric. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[3] }}>
            <KpiCard label="Other Rate" value={`${Number(d.other_pct ?? 0).toFixed(1)}%`}
              sub={tone.verdict} icon="help" accent={tone.color} />
            <KpiCard label="Calls Logged As Other" value={fmtNum(d.other_calls)}
              sub={`of ${fmtNum(d.dispositioned_calls)} with a disposition`} icon="edit_note" accent={NAVY} />
            <KpiCard label="Agents Using It" value={fmtNum(d.by_agent.length)}
              sub={d.by_agent.length > 1 ? 'spread — likely a vocabulary gap' : 'one agent — may be a habit'}
              icon="group" accent={NAVY} />
          </div>

          {/* Per agent. This is what separates "the list is missing an outcome" from "one
              person reaches for Other instead of reading it" — the fix differs completely. */}
          {d.by_agent.length > 0 && (
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: SP[2] }}>
                By Agent
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {d.by_agent.map(a => (
                  <div key={a.agent_name} style={{ display: 'flex', alignItems: 'baseline', gap: SP[2], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', minWidth: 170 }}>{a.agent_name}</span>
                    <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtNum(a.other_calls)}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      of {fmtNum(a.dispositioned_calls)} · {Number(a.other_pct ?? 0).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* The backlog itself. Read top to bottom: the wording is the evidence, and three of
              the first eleven notes named one missing outcome in three different ways. */}
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: SP[2] }}>
              What They Wrote
            </div>
            {d.notes.length === 0 ? (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: '18px 0' }}>
                Nothing logged as Other in this period. That is the healthy state: every call fitted
                an outcome the list already offers.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {d.notes.map(nt => (
                  <div key={nt.id} style={{
                    padding: '9px 11px', borderRadius: RADIUS.md,
                    background: 'var(--bg)', border: '1px solid var(--bdr)',
                  }}>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5 }}>
                      {nt.notes || nt.resolution || <span style={{ color: 'var(--txt3)' }}>(no note — the form should not have allowed this)</span>}
                    </div>
                    {nt.notes && nt.resolution && (
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>{nt.resolution}</div>
                    )}
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ textTransform: 'capitalize' }}>{nt.purpose}</span>
                      {nt.agent_name && <span>· {nt.agent_name}</span>}
                      {nt.customer_name && <span>· {nt.customer_name}</span>}
                      <span>· {fmtDatetime(nt.started_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
