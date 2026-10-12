import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The house style has one rule about punctuation and it was broken in 78 places
// before this test existed: no em dash as a connector. It is the clearest tell in the
// product's own writing, because a dash will join any two thoughts without the writer
// having to decide how they relate — which is exactly why a machine reaches for it.
//
// Companion to labelCase.test.ts: that one governs how a LABEL is capitalised, this
// one governs how a SENTENCE is punctuated. Both exist because the rule was applied
// by hand, drifted, and was applied by hand again.
//
// What replaces the dash is a judgement the test cannot make, so it only reports.
// Writing it out: a colon introduces an apposition or a list ("Oldest first: the
// order it should be worked in"); a full stop precedes an independent clause or an
// instruction ("Interswitch has no API. Pull the CSV from their portal.").

const SRC = join(__dirname, '..')

// Copy positions: prose a person reads, as opposed to a label.
const COPY_ATTRS = /\b(subtitle|description|body|hint|sub|placeholder)=\{?(["'`])((?:(?!\2)[\s\S]){8,400}?)\2/g
const TOASTS = /toast\.(?:success|error|info|warning)\(\s*([`'"])((?:(?!\1)[\s\S]){8,400}?)\1/g

const TELLS: [RegExp, string][] = [
  // SPACED only, and that matters twice over. A bare em dash can be a numeric range,
  // and a lone dash standing in a table cell for a missing figure is correct
  // typography that must never be swept.
  [/\s\u2014\s/, 'em dash used as a connector'],
  // An en dash BETWEEN TWO VALUES is a range, which is exactly what it is for \u2014
  // "${fmtDate(from)} \u2013 ${fmtDate(to)}" is correct typography and the first run of
  // this test flagged seven of them. It is only a tell when it joins words.
  [/[A-Za-z,)]\s\u2013\s[A-Za-z(]/, 'en dash used as a connector'],

  // Vocabulary that reads as generated rather than written.
  [/\bseamless(ly)?\b/i, '"seamless"'],
  [/\brobust\b/i, '"robust"'],
  [/\bleverag(e|ing)\b/i, '"leverage"'],
  [/\bdelve\b/i, '"delve"'],
  [/\b(furthermore|moreover)\b/i, 'a connective adverb'],
  [/\bit('s| is) worth noting\b/i, '"it is worth noting"'],
  [/\bin today's\b/i, '"in today\'s ..."'],
  [/\b(elevate|empower|unlock|streamline|supercharge)\b/i, 'a marketing verb'],
  [/\bcomprehensive\b/i, '"comprehensive"'],
  [/\bcutting[- ]edge\b/i, '"cutting-edge"'],
  [/\btestament to\b/i, '"a testament to"'],
  [/\bwhen it comes to\b/i, '"when it comes to"'],
  [/\ba wealth of\b/i, '"a wealth of"'],
  [/\bneedless to say\b/i, '"needless to say"'],

  // An exclamation mark, but not `!==` or `!value` — those are operators inside a
  // template literal, and they were the whole of this rule's first run:
  // `${n} payment${n !== 1 ? 's' : ''}`.
  [/!(?![=\w({[$])/, 'an exclamation mark'],

  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji'],

  // Passive with no actor. The rule is to name who did it.
  [/\b(has|have|had) been (submitted|created|updated|processed|generated|completed|received|actioned)\b/i,
    'passive voice with no actor'],
]

// An em dash between two short capitalised names is the "Module — Subpage" title
// separator the page catalog uses ("Call Center — Performance"), not prose.
const TITLE_SEPARATOR = /^[A-Z][\w&'()/ ]{0,28}\s\u2014\s[A-Z][\w&'()/ ]{0,28}$/

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

// Comments are stripped first. This repo's comments use em dashes heavily and that is
// correct prose for a comment; the rule is about what a reader of the product sees.
// Stripping only ever REMOVES text, so a mangled literal yields a false negative,
// never a false positive that sends someone editing a comment.
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return noBlocks
    .split('\n')
    .map(line => line.replace(/(^|[^:/])\/\/[^\n]*$/, '$1'))
    .join('\n')
}

// Copy that trips a rule and should not. Keyed to its file, with the reason.
const ACCEPTED: Record<string, string[]> = {
  // Placeholders demonstrating TEMPLATE SYNTAX to whoever is composing a message —
  // note the one that spells out "*Bold*, _italic_, ~strike~ supported". They model
  // what a user might type, they are not copy O3C sends, and the exclamation mark is
  // part of showing a realistic message. The no-exclamation rule governs our own mail.
  'pages/campaigns/Report.tsx': ['an exclamation mark'],
  'pages/campaigns/TemplateEditor.tsx': ['an exclamation mark'],
}

interface Finding { file: string; tell: string; text: string }

function scan(): Finding[] {
  const found: Finding[] = []
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/')
    const src = stripComments(readFileSync(file, 'utf8'))

    const strings: string[] = []
    for (const re of [COPY_ATTRS, TOASTS]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) strings.push(m[3] ?? m[2])
    }

    for (const text of strings) {
      if (TITLE_SEPARATOR.test(text.trim())) continue
      for (const [re, tell] of TELLS) {
        if (!re.test(text)) continue
        if ((ACCEPTED[rel] ?? []).includes(tell)) continue
        found.push({ file: rel, tell, text })
      }
    }
  }
  return found
}

describe('copy style', () => {
  it('never uses a dash to join two thoughts, and does not read like a machine', () => {
    const found = scan()
    const report = found
      .map(f => `  ${f.file}\n    ${f.tell}\n    "${f.text}"`)
      .join('\n')
    expect(found, found.length
      ? `${found.length} piece(s) of copy break the house style. For a dash, decide how `
        + `the two halves relate: a colon introduces an apposition, a full stop precedes `
        + `an independent clause or an instruction.\n${report}\n`
      : '').toEqual([])
  })

  it('leaves alone the things that only look like tells', () => {
    const sep = (s: string) => TITLE_SEPARATOR.test(s)
    // The page catalog's own naming convention.
    expect(sep('Call Center — Performance')).toBe(true)
    expect(sep('Collections — Daily Watch')).toBe(true)
    // Prose joining two clauses is not a title, however it is capitalised.
    expect(sep('Account assigned — it can now be worked')).toBe(false)

    const bang = TELLS.find(([, t]) => t === 'an exclamation mark')![0]
    expect(bang.test('${n} payment${n !== 1 ? "s" : ""}')).toBe(false)
    expect(bang.test('${mod.label} ${!mod.enabled ? "off" : "on"}')).toBe(false)
    expect(bang.test('Saved!')).toBe(true)

    // A lone dash for a missing figure is correct typography, and an unspaced dash
    // can be a range. Only the spaced connector is a tell.
    const dash = TELLS[0][0]
    expect(dash.test('—')).toBe(false)
    expect(dash.test('61—90 days')).toBe(false)
    expect(dash.test('Oldest first — the order it should be worked in')).toBe(true)
  })
})
