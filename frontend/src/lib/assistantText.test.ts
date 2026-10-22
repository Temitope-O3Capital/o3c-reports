import { describe, expect, it } from 'vitest'
import { forDisplay } from './assistantText'

describe('cleaning an answer for the screen', () => {
  it('removes the bold the model was asked not to write', () => {
    // Measured: 4 of the first 55 answers staff received contained ** and the
    // panel showed the asterisks literally.
    expect(forDisplay('The best officer is **Igwilo Jennifer** with NGN 5,953,682,018.89.'))
      .toBe('The best officer is Igwilo Jennifer with NGN 5,953,682,018.89.')
  })

  it('removes the Next step label it bolds out of habit', () => {
    expect(forDisplay('We hold NGN 22bn. **Follow-up:** Want the maturity split?'))
      .toBe('We hold NGN 22bn. Follow-up: Want the maturity split?')
  })

  it('repairs a separator even inside bold', () => {
    // Both failures in one string, which is how they actually arrive.
    expect(forDisplay('Buy **1 373.00**, sell 1 378.00.'))
      .toBe('Buy 1,373.00, sell 1,378.00.')
  })

  it('strips headings and code ticks', () => {
    expect(forDisplay('## Fixed deposits\nWe hold `22062602639.68` naira.'))
      .toBe('Fixed deposits\nWe hold 22062602639.68 naira.')
  })

  it('leaves a hyphen bullet alone, which the prompt allows', () => {
    const t = '- Active: 234\n- Closed: 205'
    expect(forDisplay(t)).toBe(t)
  })

  it('does not eat a snake_case column name', () => {
    // The regression this guards: a naive italic rule turns fee_income_ngn into
    // feeincomengn, which would then be quoted back as a column that does not exist.
    expect(forDisplay('Grouped by fee_income_ngn and outstanding_principal_kobo.'))
      .toBe('Grouped by fee_income_ngn and outstanding_principal_kobo.')
  })

  it('does not eat a lone asterisk or a multiplication', () => {
    expect(forDisplay('Rate * balance = interest.')).toBe('Rate * balance = interest.')
    expect(forDisplay('Footnote *')).toBe('Footnote *')
  })

  it('leaves an ordinary sentence untouched', () => {
    const t = 'Team Jennifer logged outreach to 5 distinct customers this week.'
    expect(forDisplay(t)).toBe(t)
  })

  it('survives an empty or missing answer', () => {
    expect(forDisplay('')).toBe('')
  })

  it('handles a figure in italics without losing the digits', () => {
    expect(forDisplay('We collected *41.2m* last month.')).toBe('We collected 41.2m last month.')
  })
})
