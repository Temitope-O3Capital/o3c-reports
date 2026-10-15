/**
 * Presenting what an agent typed.
 *
 * 5,266 of the 9,915 call notes on the book are written entirely in capitals, 1,854
 * carry stray leading or trailing whitespace and 182 have runs of double spaces. Read
 * back on a timeline that is a wall of shouting, and the useful half of a hand-off note
 * is the half nobody reads.
 *
 * This is presentation only. The stored note is never rewritten — the same principle
 * lib/outcomes.ts follows for the outcome vocabulary: resolve on the way out rather than
 * migrate an audit trail. An agent's own words stay exactly as they typed them in the
 * database, in exports, and in anything that reads the API directly.
 */

/**
 * Words that must keep their capitals when a shouted note is calmed down.
 *
 * Deliberately excludes US and IT. Both are real initialisms, and both are far more
 * often the ordinary English words: "NEVER HEARD ABOUT US" came back as the United
 * States and "WANTS TO THINK ABOUT IT" as the IT department. An initialism that is also
 * a common word does more harm kept than lost.
 */
const KEEP_UPPER = new Set([
  // Ours and the industry's.
  'CIF', 'BVN', 'NIN', 'DPD', 'PTP', 'NPL', 'LOS', 'KYC', 'POS', 'ATM', 'USSD',
  'OTP', 'TIN', 'ID', 'SMS', 'PND', 'CRC', 'NGN', 'USD', 'GBP', 'EUR', 'VAT',
  // Places and institutions that are genuinely initialisms.
  'FCT', 'UK', 'USA', 'EU', 'GTB', 'UBA', 'FCMB', 'MD', 'CEO', 'CFO',
])

/** Names that are conventionally mixed-case, so sentence-casing them looks wrong. */
const FIXED_CASE: Record<string, string> = {
  whatsapp: 'WhatsApp', opay: 'OPay', newedge: 'NewEdge', palmpay: 'PalmPay',
  iphone: 'iPhone', paystack: 'Paystack', interswitch: 'Interswitch',
}

/** Is this note shouting, rather than merely containing an acronym? */
function isShouting(s: string): boolean {
  if (s !== s.toUpperCase()) return false
  // At least two runs of four-plus capitals: "BVN" alone is an acronym, not a shout.
  const runs = s.match(/[A-Z]{4,}/g)
  return !!runs && runs.length >= 2
}

function calmWord(w: string): string {
  const bare = w.replace(/[^A-Za-z]/g, '')
  if (KEEP_UPPER.has(bare)) return w
  const fixed = FIXED_CASE[bare.toLowerCase()]
  if (fixed) return w.replace(bare, fixed)
  return w.toLowerCase()
}

/**
 * A note as it should be read: trimmed, single-spaced, and brought down out of block
 * capitals when the whole thing was shouted. Mixed-case notes are returned untouched —
 * whatever the agent chose to capitalise, they chose.
 */
export function readableNote(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (!isShouting(s)) return s

  const calmed = s.split(' ').map(calmWord).join(' ')
  // Open each sentence with a capital. Split on the terminator so "1PM." keeps its stop.
  return calmed.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead, ch) => lead + ch.toUpperCase())
}

/** True when there is nothing worth rendering — 182 notes are a stray character. */
export function noteIsEmpty(raw: string | null | undefined): boolean {
  return readableNote(raw).length <= 2
}
