import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#0E2841', light: '#16374F', dark: '#091A2D' },
        o3c:  { DEFAULT: '#C00000', light: '#D40000', dark: '#960000' },
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        shimmer: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        fadeIn:  { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        fadeIn:  'fadeIn 0.2s ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config
