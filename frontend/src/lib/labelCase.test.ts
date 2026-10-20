import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Every visible label in O3C is Title Case. The rule has been applied by hand three
// times now (159 labels across ~60 files) and it keeps drifting, because a new page
// is written in whatever case its author was thinking in and nothing objects. This
// test objects.
//
// It is deliberately CONSERVATIVE. A build-blocking style test that cries wolf gets
// skipped, so it enforces only on positions that are certainly visible label text,
// and it encodes every false-positive population the manual sweeps ran into. If it
// fires, the label is almost certainly wrong.
//
// Sentences are not labels. "Write a query and press Ctrl+Enter" is an instruction
// and stays as written; "No Channel Data" is a noun phrase and does not.

const SRC = join(__dirname, '..')

// Minor words stay lowercase mid-title. Demonstratives are NOT minor: "in This Period".
const MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for',
  'by', 'with', 'at', 'per', 'vs', 'via', 'from', 'but', 'nor', 'as', 'into', 'over'])

// Units and measure abbreviations keep their conventional lowercase: "Cost per km".
const UNIT = /^(km|mo|px|kg|hrs?|mins?|days?|l|ngn|sms|api|csv|pdf|sql|m|k|bn)$/i

// A verb-led string is an instruction, which is a sentence, not a label.
const VERB_LED = /^(add|create|pick|write|choose|select|drop|upload|run|set|search|try|click|widen|import|connect|enable|paste|edit|save|enter|plan|log|send|view|open|start|stop|reset|refresh|retry|copy|download|export|assign|remove|rename|delete|cancel|confirm|approve|reject|move|merge|split|link|unlink|mark|clear|apply|filter|sort|show|hide|print|book|call|email|message|schedule|include|exclude|count|keep|refer|ask|dismiss|decline|end)\b/i

// Files whose strings are NOT UI labels.
//
//   starterTemplates  campaign email BODY copy, exempt by the house style rule
//   builder/model     filter operators ("at least", "is blank") read as sentence
//                     fragments inside a condition: "Amount is at least 500"
//   labels.ts         maps STORED VALUES to labels; its keys are data, not copy
const EXEMPT_FILES = [
  'pages/campaigns/starterTemplates.ts',
  'pages/reports/builder/model.ts',
  'lib/labels.ts',
]

// `title=` is only a visible heading on these components. On a <button>, Btn, HeadBtn,
// TBtn, Picker, KpiCard or a bare span/div it is a HOVER TOOLTIP or an accessibility
// name, which stays sentence case — that was the single largest false-positive group
// in the manual sweeps, and the prop name alone tells you nothing.
const TITLE_IS_VISIBLE = new Set([
  'Page', 'SectionCard', 'Modal', 'ConfirmModal', 'EmptyState', 'SubPage', 'Drawer',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'mocks') walk(p, out)
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/** A sentence, an instruction, or anything punctuated — not a label. */
// A finite verb makes a statement rather than a name: "Paystack is not configured",
// "Every run is signed off", "This period cannot be reconciled yet". Those read as
// sentences and keep sentence case.
const FINITE_VERB = /\b(is|are|was|were|be|been|being|am|has|have|had|can|cannot|will|would|should|must|may|does|do|did)\b/i

// ...unless it opens with an interrogative, which makes it a nominalised question
// doing a label's job: "What Was Done", "How Many Items".
const INTERROGATIVE = /^(what|when|who|whose|which|how|where|why)\b/i

export function isProse(s: string): boolean {
  const t = s.trim()
  if (/[.!?;:,…]/.test(t)) return true   // includes the ellipsis of a placeholder option
  if (/[\u2014\u2013]/.test(t)) return true   // em/en dash
  if (/\s-\s/.test(t)) return true
  if (t.split(/\s+/).length > 6) return true
  if (VERB_LED.test(t)) return true
  return FINITE_VERB.test(t) && !INTERROGATIVE.test(t)
}

/** True when a non-minor word after the first is lowercase, i.e. not Title Case. */
export function violatesTitleCase(s: string): boolean {
  const words = s.trim().split(/\s+/)
  if (words.length < 2) return false
  for (let i = 1; i < words.length; i++) {
    const bare = words[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    if (!bare || MINOR.has(bare.toLowerCase()) || UNIT.test(bare)) continue
    if (/^[a-z]/.test(bare)) return true
  }
  return false
}

/** The JSX element an attribute belongs to: nearest unclosed `<Name` before it. */
function enclosingElement(src: string, at: number): string {
  const open = src.lastIndexOf('<', at)
  if (open < 0) return ''
  const m = /^<\s*([A-Za-z][\w.]*)/.exec(src.slice(open, at + 1))
  return m ? m[1] : ''
}

// Strings that LOOK like mis-cased labels and are not, where the shape rules above
// cannot tell. Each is keyed to its file so the same words elsewhere are still
// checked, and each carries the reason it is exempt. Keep this list short: if it is
// growing, the rule is wrong rather than the code.
const ACCEPTED: Record<string, string[]> = {
  // Sub-labels that COMPLETE a figure rather than name a field: the screen reads
  // "₦12,000 in credit", "48 active cards". Capitalising them breaks the sentence.
  // Same rule that keeps ContactProfile's "12 transactions" lowercase.
  'pages/Overview.tsx': ['in credit', 'balance not synced', 'active cards'],
  'pages/admin/SyncStatus.tsx': ['due now'],

  // Status text describing a state, not a name for one — the badge says what
  // happened. See the house style rule: titles are Title Case, statements are not.
  'lib/losFlow.ts': ['Decision not received', 'Phoenix decided'],

  // Choices phrased as sentences, which is what makes them readable as answers to
  // the question above them.
  'pages/contacts/Segments.tsx': ['Only these customers'],
  'pages/retention/Retention.tsx': ['Still holds an open product'],

  // Grouping options that complete "Group …", so they stay lowercase fragments.
  // The coarse date grains join the same list for the same reason: the select is
  // labelled "Group Call Date by" and each option finishes that sentence.
  'pages/reports/builder/SummaryView.tsx': [
    'by time of day', 'by timestamp', 'by week', 'by month', 'by quarter', 'by year',
  ],

  // Cited in the casing rule itself as correctly left: a full sentence reporting an
  // outcome, not a title naming an empty state.
  'pages/reports/Library.tsx': ['The report ran and returned nothing'],
}

interface Finding { file: string; where: string; text: string }

function scan(): Finding[] {
  const found: Finding[] = []

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/')
    if (EXEMPT_FILES.includes(rel)) continue
    const src = readFileSync(file, 'utf8')

    const add = (where: string, text: string) => {
      if (text.includes('&')) return          // "Identity &amp; KYC" scans as "amp"
      if (/^\(|\)$/.test(text.trim())) return // a bare parenthetical, e.g. "(px)"
      if (isProse(text) || !violatesTitleCase(text)) return
      if ((ACCEPTED[rel] ?? []).includes(text)) return
      found.push({ file: rel, where, text })
    }

    // label= and emptyText= are always visible label text. aria-label is an
    // accessibility name and placeholder is a hint, so neither is matched here.
    // The lookbehind matters: `\blabel=` also matches the "label=" inside
    // `aria-label=`, because the hyphen is a word boundary. That silently pulled in
    // every icon-button accessibility name ("Dismiss this call-back reminder",
    // "End call") and would have had us Title-casing screen-reader text.
    for (const re of [/(?<![-\w])label=\{?"([^"{}]{2,70})"/g, /\bemptyText="([^"{}]{2,70})"/g]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) add(m[0].split('=')[0], m[1])
    }

    // title= only where the component renders it as a heading.
    const titleRe = /\btitle="([^"{}]{2,70})"/g
    let t: RegExpExecArray | null
    while ((t = titleRe.exec(src))) {
      if (TITLE_IS_VISIBLE.has(enclosingElement(src, t.index))) add('title=', t[1])
    }

    // label:/header: keys in config arrays (table columns, nav, filter groups).
    for (const re of [/\blabel:\s*'([^'{}]{2,70})'/g, /\bheader:\s*'([^'{}]{2,70})'/g,
      /\blabel:\s*"([^"{}]{2,70})"/g, /\bheader:\s*"([^"{}]{2,70})"/g]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) add(m[0].split(':')[0] + ':', m[1])
    }

    // Visible text of a select option and a table header cell.
    for (const re of [/>([A-Za-z][^<>{}]{2,60})<\/option>/g, /<th[^>]*>([A-Za-z][^<>{}]{2,60})<\/th>/g]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) add(re.source.includes('option') ? '<option>' : '<th>', m[1])
    }
  }

  return found
}

describe('label case', () => {
  it('writes every visible label in Title Case', () => {
    const found = scan()
    const report = found
      .map(f => `  ${f.file}  [${f.where}]  "${f.text}"`)
      .join('\n')
    expect(found, found.length
      ? `${found.length} label(s) are not Title Case. Either capitalise them, or — if the `
        + `string is really a sentence, a hint or a tooltip — leave it and check this test `
        + `is not treating its position as a visible label:\n${report}\n`
      : '').toEqual([])
  })

  // The guard only means something if it can fail, and only stays usable if it does
  // not fire on prose. Both directions are pinned.
  it('knows a label from a sentence', () => {
    expect(violatesTitleCase('No channel data')).toBe(true)
    expect(violatesTitleCase('No Channel Data')).toBe(false)
    expect(violatesTitleCase('Cost per km')).toBe(false)      // minor word + unit
    expect(violatesTitleCase('In This Period')).toBe(false)   // demonstrative is major
    expect(violatesTitleCase('Payroll')).toBe(false)          // single word
    expect(isProse('Write a query and press Ctrl+Enter')).toBe(true)
    expect(isProse('Paystack is not configured')).toBe(true)  // has a verb, reads as a sentence
    expect(isProse('No Channel Data')).toBe(false)
  })
})
