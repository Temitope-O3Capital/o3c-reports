import { describe, it, expect } from 'vitest'
import { fmt, fmtKobo, fmtKoboExact, fmtNum, fmtDate, fmtPct } from './fmt'

describe('fmt', () => {
  it('returns dash for null/undefined', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(undefined)).toBe('—')
  })
  it('formats billions', () => {
    expect(fmt(2_500_000_000)).toBe('₦2.50B')
  })
  it('formats millions', () => {
    expect(fmt(1_500_000)).toBe('₦1.50M')
  })
  it('formats thousands', () => {
    expect(fmt(5_200)).toBe('₦5.2K')
  })
  it('formats negative values', () => {
    expect(fmt(-1_000_000)).toBe('-₦1.00M')
  })
})

describe('fmtKobo', () => {
  it('divides by 100', () => {
    expect(fmtKobo(150000)).toBe('₦1.5K')
  })
  it('returns dash for NaN', () => {
    expect(fmtKobo('abc')).toBe('—')
  })
  it('handles zero', () => {
    expect(fmtKobo(0)).toMatch(/₦/)
  })
})

describe('fmtKoboExact', () => {
  it('formats exact kobo amounts', () => {
    expect(fmtKoboExact(100)).toContain('₦')
  })
})

describe('fmtNum', () => {
  it('returns dash for null', () => {
    expect(fmtNum(null)).toBe('—')
  })
  it('formats millions', () => {
    expect(fmtNum(2_000_000)).toBe('2.0M')
  })
  it('formats thousands', () => {
    expect(fmtNum(1_500)).toBe('1.5K')
  })
})

describe('fmtDate', () => {
  it('returns dash for empty', () => {
    expect(fmtDate(null)).toBe('—')
    expect(fmtDate('')).toBe('—')
  })
  it('parses date-only strings as UTC', () => {
    const result = fmtDate('2024-01-15')
    expect(result).toContain('2024')
    expect(result).toContain('Jan')
  })
})

describe('fmtPct', () => {
  it('formats with 1 decimal by default', () => {
    expect(fmtPct(12.5)).toBe('12.5%')
  })
  it('respects dec parameter', () => {
    expect(fmtPct(12.5, 2)).toBe('12.50%')
  })
  it('defaults null to 0', () => {
    expect(fmtPct(null)).toBe('0.0%')
  })
})
