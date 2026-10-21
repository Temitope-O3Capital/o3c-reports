/**
 * Turning a stream of tokens into sentences that can be spoken.
 *
 * The assistant generates text at roughly 8 tokens a second — about 6 words — and
 * a person speaks around 2.5. Synthesising the WHOLE answer before speaking would
 * waste that margin entirely and leave ten seconds of silence; synthesising each
 * sentence as it completes means the voice starts after the first one and then
 * never runs dry, because generation stays ahead of speech with room to spare.
 *
 * So the only hard problem is deciding where a sentence ends, on a stream that
 * arrives a few characters at a time.
 *
 * The naive rule — split on a full stop — is wrong in this product specifically,
 * because almost every answer contains money:
 *
 *     "We collected ₦41.2m last month."
 *
 * Splitting at the decimal gives "We collected ₦41." which Piper reads as
 * "forty-one" and then starts a new sentence with "2m last month", and the figure
 * a person hears is wrong. In a tool that reports balances that is not a cosmetic
 * bug.
 */

/** Abbreviations that end in a full stop without ending a sentence. */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'engr', 'barr',
  'ltd', 'plc', 'inc', 'co', 'no', 'vs', 'etc', 'approx', 'est',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'e.g', 'i.e', 'a.m', 'p.m',
]

/**
 * Emit anyway after this many characters with no sentence end in sight. Without
 * it, one run-on sentence means the companion sits silent through the whole
 * answer, which is worse than an awkward break.
 */
const MAX_CHUNK = 240

/** Below this, hold on — a two-word fragment is not worth a synthesis round trip. */
const MIN_CHUNK = 12

function endsWithAbbreviation(text: string): boolean {
  const m = /([A-Za-z.]+)\.$/.exec(text.trimEnd())
  if (!m) return false
  return ABBREVIATIONS.includes(m[1].toLowerCase())
}

/**
 * Is the full stop at `i` a decimal point rather than a sentence end?
 * Digit on both sides: 41.2, 0.75, 1,234.56.
 */
function isDecimalPoint(text: string, i: number): boolean {
  return /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')
}

/**
 * Find the end of the first complete sentence in `text`, or -1.
 * Returns the index one past the terminator.
 */
export function findSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '.' && c !== '!' && c !== '?' && c !== '\n') continue

    if (c === '\n') {
      // A line break is a hard boundary; nothing reads across it.
      if (i + 1 >= MIN_CHUNK) return i + 1
      continue
    }

    if (c === '.' && isDecimalPoint(text, i)) continue

    // Run past "?!" and "..." so the whole terminator goes with the sentence.
    let j = i
    while (j + 1 < text.length && '.!?'.includes(text[j + 1])) j++

    const next = text[j + 1]
    // A terminator sitting at the very end of the buffer is NOT a finished
    // sentence: the next chunk may carry another terminator ("?" then "!") or
    // continue the figure. Waiting for a following character costs one chunk of
    // latency and is the difference between speaking "Are you certain?!" and
    // speaking "Are you certain?" and then "!" on its own.
    //
    // The final sentence of an answer therefore leaves on flush(), which is
    // exactly when the stream says it is done.
    if (next === undefined) continue
    if (!/\s/.test(next)) continue

    if (endsWithAbbreviation(text.slice(0, j + 1))) continue
    if (j + 1 < MIN_CHUNK) continue

    return j + 1
  }
  return -1
}

export type SentenceStream = {
  /** Feed arriving text. Returns any sentences that are now complete. */
  push(chunk: string): string[]
  /** End of the answer: returns whatever is left, however incomplete. */
  flush(): string[]
  /** What is held back, for tests and diagnostics. */
  pending(): string
}

export function createSentenceStream(): SentenceStream {
  let buf = ''

  function drain(): string[] {
    const out: string[] = []
    for (;;) {
      const end = findSentenceEnd(buf)
      if (end === -1) {
        // No sentence end, but the buffer has grown too long to keep holding.
        // Break at the last space so a word is never cut in half.
        if (buf.length >= MAX_CHUNK) {
          const cut = buf.lastIndexOf(' ', MAX_CHUNK)
          const at = cut > MIN_CHUNK ? cut : MAX_CHUNK
          const piece = buf.slice(0, at).trim()
          buf = buf.slice(at)
          if (piece) out.push(piece)
          continue
        }
        break
      }
      const piece = buf.slice(0, end).trim()
      buf = buf.slice(end)
      if (piece) out.push(piece)
    }
    return out
  }

  return {
    push(chunk) { buf += chunk; return drain() },
    flush() {
      const rest = buf.trim()
      buf = ''
      return rest ? [rest] : []
    },
    pending() { return buf },
  }
}

/**
 * Text the voice should not try to read aloud.
 *
 * The assistant is told to write plain text, but it still emits the occasional
 * hyphen bullet and the odd table-ish run. Spoken, a line of hyphens is a long
 * pause and a row of pipes is nonsense.
 */
export function speakable(text: string): string {
  return text
    .replace(/^\s*[-–—*]\s+/gm, '')      // leading bullet markers
    .replace(/\|/g, ' ')                  // table pipes
    .replace(/`+/g, '')                   // stray code ticks
    .replace(/\*\*(.+?)\*\*/g, '$1')      // bold, if it slips through
    .replace(/_{2,}|-{3,}|={3,}/g, ' ')   // rules
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * ₦ is read as "naira" by some voices and skipped silently by others, and a
 * skipped currency symbol turns "₦41.2m" into "forty-one point two million" with
 * no unit at all. Say it explicitly.
 *
 * Abbreviated magnitudes get expanded for the same reason: "41.2m" is read as
 * "forty-one point two em" by Piper.
 */
export function sayMoney(text: string): string {
  return text
    .replace(/₦\s?([\d,]+(?:\.\d+)?)\s?bn\b/gi, '$1 billion naira')
    .replace(/₦\s?([\d,]+(?:\.\d+)?)\s?m\b/gi, '$1 million naira')
    .replace(/₦\s?([\d,]+(?:\.\d+)?)\s?k\b/gi, '$1 thousand naira')
    .replace(/₦\s?([\d,]+(?:\.\d+)?)/g, '$1 naira')
    .replace(/\bNGN\s?([\d,]+(?:\.\d+)?)/gi, '$1 naira')
}


/**
 * Repair a thousands separator written as a space.
 *
 * gpt-oss writes "21 365 accounts, 1 124 delinquent" using U+202F NARROW
 * NO-BREAK SPACE where the tool returned 21,365 and 1,124 (measured 2026-10-21
 * against the live card portfolio). The figures were right, but spoken, "1 124"
 * is read as two numbers — "one, one hundred and twenty-four" — and a wrong
 * figure said aloud in a tool that reports balances is the failure this whole
 * file exists to prevent.
 *
 * The system prompt asks for commas. That is a request; this is the guarantee.
 * Only the SPACE characters a model actually uses as separators are touched,
 * and only between digits with exactly three following, so "41.2" and
 * "September 2026" are left alone.
 */
export function fixSeparators(text: string): string {
  return text.replace(/(\d)[\u202f\u00a0\u2009](?=\d{3}(?:\D|$))/g, '$1,')
}

/** Everything a sentence needs before it is handed to the synthesiser. */
export function forSpeech(text: string): string {
  return sayMoney(fixSeparators(speakable(text)))
}
