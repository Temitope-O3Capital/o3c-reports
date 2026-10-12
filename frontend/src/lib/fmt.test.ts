import { afterEach, describe, expect, it, vi } from 'vitest'
import { today, todayLocal, monthStart, yearStart } from './fmt'
import { resolveWindow } from '../pages/reports/builder/model'

// The invariant this file exists to hold: there is ONE "today".
//
// The house date picker (DateFilter in components/UI.tsx) builds its presets from
// today() / monthStart() / yearStart() below. The Report Builder's window select
// resolves its named windows through resolveWindow(), which anchors to Africa/Lagos
// because the backend resolves a scheduled send there. Those two controls sit side by
// side on the Report Builder toolbar, and today() used to be pure browser-local — so on
// any machine not set to UTC+1 "Last 30 Days" in the picker and last_30_days in the
// select named different ranges.
//
// These assertions are deliberately cross-module rather than hard-coded dates: they
// compare the two definitions against each other, so they fail on ANY host timezone the
// moment one side drifts back to local time, and they keep passing on a Lagos machine
// where the bug is invisible.

const NO_CUSTOM = { from: '', to: '' }

afterEach(() => { vi.useRealTimers() })

// Instants chosen so that UTC, Lagos and a west-of-UTC browser disagree about the
// calendar day — the only times the bug was ever visible.
const INSTANTS = [
  '2026-03-31T23:30:00Z',  // Lagos is already 1 Apr; UTC and anything west of it is 31 Mar
  '2025-12-31T23:10:00Z',  // year boundary: Lagos is in 2026, UTC still in 2025
  '2026-06-30T23:45:00Z',  // month and quarter boundary
  '2026-10-12T09:00:00Z',  // mid-day, where every zone agrees (the control case)
]

describe('today() resolves in Africa/Lagos', () => {
  for (const at of INSTANTS) {
    it(`agrees with the Report Builder's "today" at ${at}`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const w = resolveWindow('today', NO_CUSTOM)
      expect(today()).toBe(w.from)
      expect(today()).toBe(w.to)
    })

    it(`agrees on the start of month and year at ${at}`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      expect(monthStart()).toBe(resolveWindow('this_month', NO_CUSTOM).from)
      expect(yearStart()).toBe(resolveWindow('this_year', NO_CUSTOM).from)
    })
  }

  it('is the Lagos day, not the UTC day, across the UTC midnight it straddles', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-31T23:30:00Z'))
    expect(today()).toBe('2026-04-01')
  })
})

describe('todayLocal()', () => {
  it('holds the Lagos day as a local midnight, so local date arithmetic is safe', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-31T23:30:00Z'))
    const d = todayLocal()
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 4, 1])
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0])
  })

  it('round-trips through today()', () => {
    for (const at of INSTANTS) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(at))
      const d = todayLocal()
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      expect(iso).toBe(today())
      vi.useRealTimers()
    }
  })
})

describe('the rolling-day presets agree with the named windows', () => {
  // The picker computes these by stepping todayLocal() back N days; resolveWindow steps
  // its own Lagos-anchored date back the same N. Same arithmetic, same answer — this is
  // what "Last 30 Days" and last_30_days now share.
  const relDay = (offset: number) => {
    const d = todayLocal(); d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  for (const [win, offset] of [['last_7_days', -6], ['last_30_days', -29], ['last_90_days', -89]] as const) {
    it(win, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-31T23:30:00Z'))
      const w = resolveWindow(win, NO_CUSTOM)
      expect(relDay(offset)).toBe(w.from)
      expect(today()).toBe(w.to)
    })
  }
})
