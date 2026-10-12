// THE ENVELOPE CONTRACT, PINNED.
//
// Both of these pages shipped broken and reached production: the Report Library threw
// "find is not a function" and the SQL Console threw "map is not a function" on first
// paint, for every user. One cause, in two pages.
//
// respond() on the Go side wraps every payload:
//
//     { data: <payload>, data_source: "pg", data_as_of: "2026-10-12T…" }
//
// and lib/api's apiFetch resolves to that ENVELOPE, not to the payload. So a page that
// writes `apiFetch<Thing[]>('/x').then(setThings)` type-checks perfectly — the generic is
// a lie the compiler cannot see through — and then calls an array method on an object at
// runtime. tsc cannot catch it, the Go tests cannot catch it (the server was correct),
// and the existing frontend suite did not touch these pages. Hence this file.
//
// These tests deliberately feed the WRAPPED shape, because that is what the server sends.
// If someone later rewrites a page to read `res.data` by hand, or re-adds a bare
// `apiFetch<T[]>` with `.then(setState)`, these fail.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// jsdom implements no matchMedia, and the house Page component calls useIsMobile on every
// render. Stubbed here rather than in the shared test-setup, which several sessions edit.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// The real unwrap/unwrapList are used — they are the thing under test on the page side —
// while the network calls are replaced with envelope-shaped responses.
const apiFetch = vi.fn()
const apiPost = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    apiFetch: (...a: unknown[]) => apiFetch(...a),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
  }
})

const envelope = (data: unknown) => ({
  data,
  data_source: 'pg',
  data_as_of: '2026-10-12T08:00:00Z',
})

import ReportLibrary from './Library'
import SQLConsole from './SQLConsole'

beforeEach(() => {
  apiFetch.mockReset()
  apiPost.mockReset()
})

describe('the Report Library reads the response envelope', () => {
  it('lists the catalogue when it arrives wrapped in { data }', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/api/reports/list') {
        return Promise.resolve(envelope([
          { key: 'monthly-business', group: 'Finance', name: 'Monthly Business', description: 'x', dated: true },
          { key: 'card-portfolio', group: 'Cards', name: 'Card Portfolio', description: 'y', dated: false },
        ]))
      }
      return Promise.resolve(envelope({}))
    })

    render(<ReportLibrary />)

    // The failure mode this pins is a crash, not a styling slip: before the fix the
    // render threw on catalogue.find and the user saw the error boundary.
    await waitFor(() => {
      expect(screen.getByText('Monthly Business')).toBeTruthy()
    })
    expect(screen.getByText('Card Portfolio')).toBeTruthy()
  })

  it('does not crash when the catalogue comes back bare, as an older backend would send it', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/api/reports/list') {
        return Promise.resolve([
          { key: 'fd-book', group: 'Deposits', name: 'Fixed Deposit Book', description: 'z', dated: false },
        ])
      }
      return Promise.resolve({})
    })

    render(<ReportLibrary />)
    await waitFor(() => {
      expect(screen.getByText('Fixed Deposit Book')).toBeTruthy()
    })
  })
})

describe('the SQL Console reads the response envelope', () => {
  it('renders the saved-query list when it arrives wrapped in { data }', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/api/bi-sql/saved') {
        return Promise.resolve(envelope([
          { id: 1, name: 'Active Cards By Product', description: '', sql_text: 'SELECT 1', is_shared: true, created_by: 2, updated_at: '2026-10-01T00:00:00Z' },
        ]))
      }
      return Promise.resolve(envelope([]))
    })

    render(<SQLConsole />)

    await waitFor(() => {
      expect(screen.getByText('Active Cards By Product')).toBeTruthy()
    })
  })

  it('survives a saved list of the wrong shape entirely, rather than blanking the page', async () => {
    // unwrapList returns [] for anything that is not an array or { data: [] }. A console
    // that renders with an empty saved panel is usable; one that throws is not.
    apiFetch.mockImplementation(() => Promise.resolve(envelope({ unexpected: true })))

    render(<SQLConsole />)

    // The page's own subtitle: unique, and present only if the render completed.
    await waitFor(() => {
      expect(screen.getByText(/Read-only SQL over the whole workspace/i)).toBeTruthy()
    })
  })
})
