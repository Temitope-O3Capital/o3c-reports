import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // @telnyx/webrtc uses Node globals
    global: 'globalThis',
    'process.env': {},
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@tiptap/') || id.includes('prosemirror')) return 'tiptap'
          if (id.includes('recharts') || id.includes('d3-')) return 'charts'
          if (id.includes('react-router')) return 'react-router'
          // The softphone SDK is ~235 kB and only two call-centre roles ever load the
          // widget. Without its own chunk it falls into `vendor`, which every member of
          // staff downloads — lazy-loading the component alone doesn't move it.
          if (id.includes('@telnyx')) return 'telnyx'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
})
