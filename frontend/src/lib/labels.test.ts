import { describe, expect, it } from 'vitest'
import { humanLabel, STATUS_LABELS, LEGAL_STAGE_LABELS } from './labels'

describe('humanLabel', () => {
  it('turns the values actually reaching the sales screens into labels', () => {
    // These are the real stored values, taken from app.crm_contacts on 2026-09-30. They were
    // being rendered verbatim.
    expect(humanLabel('call_centre')).toBe('Call Centre')
    expect(humanLabel('self_sourced')).toBe('Self Sourced')
    expect(humanLabel('qualified')).toBe('Qualified')
    expect(humanLabel('disqualified')).toBe('Disqualified')
    expect(humanLabel('lead')).toBe('Lead')
    expect(humanLabel('in_progress')).toBe('In Progress')
  })

  it('leaves an already-written label alone', () => {
    // The guard that matters most. These strings are passed as literals by existing callers,
    // and blind title-casing would corrupt them.
    expect(humanLabel('Referred to Legal')).toBe('Referred to Legal')
    expect(humanLabel('Letter of Demand')).toBe('Letter of Demand')
    expect(humanLabel('Suspended')).toBe('Suspended')
    expect(humanLabel('Walk-In')).toBe('Walk-In')
  })

  it('never re-cases real data', () => {
    // A pill can be handed a person's or a company's name. It must come out as it went in —
    // this is the project rule that labels are title-cased and data values are not.
    expect(humanLabel('ODIBO AMOS')).toBe('ODIBO AMOS')
    expect(humanLabel('A Global Enterprise')).toBe('A Global Enterprise')
    expect(humanLabel('Bryams Limited')).toBe('Bryams Limited')
  })

  it('keeps acronyms upper-case instead of "Kyc"', () => {
    expect(humanLabel('kyc')).toBe('KYC')
    expect(humanLabel('kyc_review')).toBe('KYC Review')
    expect(humanLabel('npl_bucket')).toBe('NPL Bucket')
    expect(humanLabel('id_number')).toBe('ID Number')
    expect(humanLabel('sms_campaign')).toBe('SMS Campaign')
    expect(humanLabel('usd_card')).toBe('USD Card')
  })

  it('reads like a person wrote it, not a loop', () => {
    expect(humanLabel('letter_of_demand')).toBe('Letter of Demand')
    expect(humanLabel('referred_to_legal')).toBe('Referred to Legal')
    // A minor word first still gets capitalised — it starts the label.
    expect(humanLabel('of_interest')).toBe('Of Interest')
  })

  it('does not lower-case the second half of a compound', () => {
    // The reason MINOR is a short list. 'in', 'up', 'off' and 'for' all carry meaning as the
    // tail of a compound here, and treating them as minor words produced "Walk in".
    expect(humanLabel('walk_in')).toBe('Walk In')
    expect(humanLabel('opt_in')).toBe('Opt In')
    expect(humanLabel('follow_up')).toBe('Follow Up')
    expect(humanLabel('hand_off')).toBe('Hand Off')
    expect(humanLabel('not_ready')).toBe('Not Ready')
  })

  it('capitalises both sides of a hyphen and keeps the hyphen', () => {
    // A hyphen is preserved rather than turned into a space, because the hyphen is part of the
    // label wherever we use one: Pre-Legal and Walk-In read wrong without it.
    expect(humanLabel('pre-legal')).toBe('Pre-Legal')
    expect(humanLabel('call-centre')).toBe('Call-Centre')
    expect(humanLabel('walk-in')).toBe('Walk-In')
    // An underscore is a word separator, so it becomes a space.
    expect(humanLabel('pre_legal')).toBe('Pre Legal')
  })

  it('prefers an explicit map over the generic transform', () => {
    // pre_legal generically becomes "Pre Legal"; the map says "Pre-Legal" and must win.
    expect(humanLabel('pre_legal', LEGAL_STAGE_LABELS)).toBe('Pre-Legal')
    expect(humanLabel('legal', STATUS_LABELS)).toBe('Referred to Legal')
    // A value missing from the map still gets a decent label rather than nothing.
    expect(humanLabel('some_new_stage', LEGAL_STAGE_LABELS)).toBe('Some New Stage')
  })

  it('handles empty and missing values without printing "undefined"', () => {
    expect(humanLabel(null)).toBe('—')
    expect(humanLabel(undefined)).toBe('—')
    expect(humanLabel('')).toBe('—')
    expect(humanLabel('   ')).toBe('—')
  })
})
