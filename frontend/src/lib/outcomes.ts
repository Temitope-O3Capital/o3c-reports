// One outcome vocabulary, for every screen that shows one.
//
// THE PROBLEM THIS SOLVES, measured rather than assumed. The same outcome is stored
// three different ways:
//
//   helpdesk_calls.disposition   the LABEL        "Unreachable / No Answer"  (31,700 rows)
//   app.activities.outcome       the CODE         no_answer                  (10,614 rows)
//   call_center_leads.status     a third word     no_answer                  (14,931 rows)
//
// and the labels in the call log are not even today's labels — the catalogue says
// "Answered — Interested" while 777 rows say "Interested" and 4,162 say "Not Interested",
// because the vocabulary was renamed under them. Two codes exist for one meaning in two
// separate cases: not_eligible / declined_not_eligible, and call_dropped / dropped_off.
//
// The visible result was one call reading three different ways depending on which page
// you opened it from — the lead book said "Interested", My Day said
// "answered_interested", and a hand-off page showing both at once said both.
//
// WHY A RESOLVER AND NOT A MIGRATION. 36,000 rows of history were written by a dialler
// and by five generations of this vocabulary. Rewriting them would be a one-way edit of
// the audit trail to fix a display problem, and the next rename would need another one.
// Normalising on the way OUT costs nothing and is reversible by deleting this file.
//
// The catalogue itself stays server-side (ccDispositions in
// backend-go/handlers/call_center_dispositions.go) and is fetched once per session, so a
// label added there needs no change here. Only the ALIASES below are local, because they
// describe spellings the catalogue has already stopped using and the server has no
// reason to carry.

import { useEffect, useState } from 'react'
import { apiFetch } from './api'
import { humanLabel } from './labels'

/** code → label, as the server defines it. Empty until the catalogue arrives. */
let catalogue: Record<string, string> = {}
/** normalised label → code, so a stored label resolves to today's spelling. */
let reverse: Record<string, string> = {}
let inflight: Promise<void> | null = null

/** Lowercase, strip punctuation and spacing, so "Answered — Interested",
 *  "answered_interested" and "Answered - Interested" all land on one key. */
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

// Spellings the catalogue no longer uses but 36,000 historical rows still carry, plus the
// duplicate codes. Keyed by normKey, valued with the canonical code.
//
// Every entry here is a spelling actually present in the data — none are speculative.
const ALIASES: Record<string, string> = {
  interested: 'answered_interested',
  notinterested: 'answered_not_interested',
  // Two codes, one meaning. 627 rows under one and 18 under the other.
  declinednoteligible: 'not_eligible',
  // Likewise: 240 and 22.
  droppedoff: 'call_dropped',
  // The lead book's own status words, which overlap the disposition vocabulary.
  dnc: 'do_not_call',
  noanswer: 'no_answer',
  unreachable: 'no_answer',
  unreachablenoanswer: 'no_answer',
  notready: 'not_ready',
  notreadyyet: 'not_ready',
  callbackscheduled: 'callback',
  // helpdesk_calls.outcome is a third, smaller vocabulary (the dialler's own) that shares
  // the column with dispositions on some screens. Left as-is rather than mapped: these
  // describe whether the CALL connected, not what the customer said, and collapsing the
  // two would claim a missed call had an outcome it never had.
}

/** The canonical label for anything stored as an outcome — a code or any historical
 *  label. Falls back to a readable version of whatever it was given, never to blank. */
export function outcomeLabel(v: string | null | undefined): string {
  const raw = (v ?? '').trim()
  if (!raw) return ''
  const k = normKey(raw)
  const code = ALIASES[k] ?? reverse[k] ?? (catalogue[raw] ? raw : '')
  if (code && catalogue[code]) return catalogue[code]
  // The catalogue has not arrived, or this is a code it does not carry. A label that is
  // already a label passes through; a bare code becomes Title Case.
  return /[A-Z\s]/.test(raw) ? raw : humanLabel(raw)
}

/** The canonical CODE, for grouping and colouring. '' when it cannot be resolved. */
export function outcomeCode(v: string | null | undefined): string {
  const raw = (v ?? '').trim()
  if (!raw) return ''
  const k = normKey(raw)
  return ALIASES[k] ?? reverse[k] ?? (catalogue[raw] ? raw : '')
}

export type OutcomeTone = 'good' | 'warn' | 'bad' | 'neutral'

// Tone, by what the outcome MEANS for the lead rather than by how it sounds. Grouped
// deliberately coarsely: an officer scanning a day wants to see progress, waiting and
// dead ends, and a twelve-colour legend is not a scan.
const GOOD = new Set(['answered_interested', 'converted', 'paid', 'ptp', 'resolved',
  'info_provided', 'winback_reactivated', 'winback_wants_offer'])
const WARN = new Set(['callback', 'not_ready', 'info_sent', 'pending_followup',
  'payment_to_verify', 'registration_incomplete', 'dispute', 'escalated', 'not_yet_due'])
const BAD = new Set(['answered_not_interested', 'not_eligible', 'do_not_call',
  'wrong_number', 'price_objection', 'wrong_product', 'winback_declined',
  'winback_competitor', 'winback_no_need', 'winback_price', 'winback_service'])

export function outcomeTone(v: string | null | undefined): OutcomeTone {
  const c = outcomeCode(v)
  if (!c) return 'neutral'
  if (GOOD.has(c)) return 'good'
  if (WARN.has(c)) return 'warn'
  if (BAD.has(c)) return 'bad'
  // no_answer, call_dropped, call_rejected, other, closed — nothing was decided.
  return 'neutral'
}

/** Load the catalogue once per session.
 *
 *  Tries the sales endpoint and then the call-centre one, because the two are gated on
 *  different pages and a given user holds one or the other: a sales officer cannot read
 *  the call-centre route, and an agent cannot read the sales route. Either returns the
 *  same vocabulary. Both failing is not an error — every label falls back to a readable
 *  form of the stored value, so a page renders correctly with no catalogue at all. */
export function loadOutcomes(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const add = (list: { code: string; label: string }[]) => {
      for (const d of list) {
        if (!d?.code || !d?.label) continue
        catalogue[d.code] = d.label
        reverse[normKey(d.label)] = d.code
        reverse[normKey(d.code)] = d.code
      }
    }
    try {
      const r = await apiFetch<{ data: Record<string, { code: string; label: string }[]> } | Record<string, { code: string; label: string }[]>>(
        '/api/sales/activity/dispositions')
      const body: any = r
      const groups = body?.data ?? body
      Object.values(groups ?? {}).forEach((l: any) => Array.isArray(l) && add(l))
      if (Object.keys(catalogue).length) return
    } catch { /* not a sales user — try the call centre's copy */ }
    try {
      const r = await apiFetch<{ data: { code: string; label: string }[] } | { code: string; label: string }[]>(
        '/api/call-center/dispositions')
      const body: any = r
      add(Array.isArray(body) ? body : (body?.data ?? []))
    } catch { /* neither module — labels fall back to the stored value */ }
  })()
  return inflight
}

/** Test seam: drop the cached catalogue. Not used by the app. */
export function _resetOutcomes() {
  catalogue = {}
  reverse = {}
  inflight = null
}

/** Makes a component re-render once the catalogue lands.
 *
 *  outcomeLabel reads module state, so a component that called it before the fetch
 *  resolved would render the fallback and never update. One state flip per component,
 *  one fetch per session. */
export function useOutcomes(): void {
  const [, bump] = useState(0)
  useEffect(() => {
    let dead = false
    loadOutcomes().then(() => { if (!dead) bump(n => n + 1) })
    return () => { dead = true }
  }, [])
}
