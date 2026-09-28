// Vitest setup — loaded before every test file (vite.config.ts → test.setupFiles).
//
// vite.config.ts has pointed at this path since the test harness was configured, but
// the file itself was never created, so `npm test` failed to collect ANY suite with
// "Failed to load url .../src/test-setup.ts". That is why the frontend had no tests:
// not a decision, a missing file. Everything it needs was already in devDependencies.
//
// Keep this thin. It should do no more than register matchers and reset global state
// between tests; anything test-specific belongs in the test file.

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Unmount anything a test rendered, so a leaked component cannot affect the next test.
afterEach(() => {
  cleanup()
})
