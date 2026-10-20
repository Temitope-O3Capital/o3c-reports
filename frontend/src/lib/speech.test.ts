import { describe, it, expect } from 'vitest'
import { createSentenceStream, findSentenceEnd, forSpeech, sayMoney, speakable } from './speech'

/** Feed a string a few characters at a time, the way tokens actually arrive. */
function stream(text: string, size = 4): { spoken: string[]; left: string } {
  const s = createSentenceStream()
  const spoken: string[] = []
  for (let i = 0; i < text.length; i += size) {
    spoken.push(...s.push(text.slice(i, i + size)))
  }
  const left = s.pending()
  spoken.push(...s.flush())
  return { spoken, left }
}

describe('finding the end of a sentence in a stream', () => {
  it('does not split a naira figure at its decimal point', () => {
    // The bug that matters. Splitting here makes the voice say "forty-one",
    // pause, then start a new sentence with "2 million" — a wrong number read
    // aloud, in a tool whose whole job is reporting balances.
    const { spoken } = stream('We collected ₦41.2m last month. That is up on September.')
    expect(spoken[0]).toBe('We collected ₦41.2m last month.')
    expect(spoken[1]).toBe('That is up on September.')
  })

  it('handles thousands separators and decimals together', () => {
    const { spoken } = stream('The balance is ₦1,234.56 exactly. Nothing is outstanding.')
    expect(spoken[0]).toContain('₦1,234.56 exactly.')
    expect(spoken).toHaveLength(2)
  })

  it('does not split after a title', () => {
    const { spoken } = stream('Mr. Adeyemi owes the most on that book right now. Call him first.')
    expect(spoken[0]).toBe('Mr. Adeyemi owes the most on that book right now.')
  })

  it('does not split after a company suffix', () => {
    const { spoken } = stream('That account belongs to Veyonra Ltd. It settled on Tuesday.')
    expect(spoken[0]).toBe('That account belongs to Veyonra Ltd. It settled on Tuesday.')
  })

  it('keeps a full terminator with its sentence', () => {
    const { spoken } = stream('Are you certain?! I would check the ledger again first.')
    expect(spoken[0]).toBe('Are you certain?!')
  })

  it('treats a line break as a hard boundary', () => {
    const { spoken } = stream('Collections are steady\nRecovery is not\n')
    expect(spoken).toEqual(['Collections are steady', 'Recovery is not'])
  })

  it('holds an incomplete sentence back rather than speaking a fragment', () => {
    const s = createSentenceStream()
    expect(s.push('We collected ₦41.2m so far this')).toEqual([])
    // Still held: a full stop at the very end of the buffer could yet be a
    // decimal point, or be followed by another terminator.
    expect(s.push(' month.')).toEqual([])
    // It leaves as soon as the next sentence proves the last one ended.
    expect(s.push(' That is')).toEqual(['We collected ₦41.2m so far this month.'])
  })

  it('releases the final sentence on flush, since nothing follows it', () => {
    const s = createSentenceStream()
    s.push('Recovery stands at ₦3.8m.')
    expect(s.flush()).toEqual(['Recovery stands at ₦3.8m.'])
  })

  it('does not go silent through a run-on sentence', () => {
    // Without a cap, one very long sentence means no audio at all until the
    // answer ends — worse than an inelegant break.
    const long = 'and then ' + 'the officer reviewed the account again '.repeat(12)
    const { spoken } = stream(long)
    expect(spoken.length).toBeGreaterThan(1)
    for (const piece of spoken) expect(piece.length).toBeLessThanOrEqual(260)
  })

  it('never cuts a word in half when breaking a run-on', () => {
    const long = 'reconciliation '.repeat(40)
    const { spoken } = stream(long)
    for (const piece of spoken) {
      for (const w of piece.split(/\s+/)) {
        if (w) expect(w).toBe('reconciliation')
      }
    }
  })

  it('returns -1 while no sentence is complete', () => {
    expect(findSentenceEnd('We collected ₦41.2m so far')).toBe(-1)
  })

  it('loses nothing: every character is either spoken or still pending', () => {
    const text = 'Collections stand at ₦41.2m. Recovery is ₦3.8m. Mr. Okafor settled his.'
    const { spoken } = stream(text, 3)
    const joined = spoken.join(' ').replace(/\s+/g, ' ')
    expect(joined).toBe(text.replace(/\s+/g, ' '))
  })
})

describe('preparing a sentence for the synthesiser', () => {
  it('says the currency rather than leaving the symbol to chance', () => {
    // Piper reads ₦ inconsistently and sometimes drops it, which turns a naira
    // figure into a bare number with no unit.
    expect(sayMoney('₦41.2m')).toBe('41.2 million naira')
    expect(sayMoney('₦3.8bn')).toBe('3.8 billion naira')
    expect(sayMoney('₦900k')).toBe('900 thousand naira')
    expect(sayMoney('₦1,234.56')).toBe('1,234.56 naira')
    expect(sayMoney('NGN 41')).toBe('41 naira')
  })

  it('strips bullets and rules that would be read as pauses or noise', () => {
    expect(speakable('- Collections are steady')).toBe('Collections are steady')
    expect(speakable('Total | 318 | ₦41.2m')).toBe('Total 318 ₦41.2m')
    expect(speakable('**Important**')).toBe('Important')
  })

  it('does the whole job in one call', () => {
    expect(forSpeech('- We collected **₦41.2m** last month'))
      .toBe('We collected 41.2 million naira last month')
  })
})
