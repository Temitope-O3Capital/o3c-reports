import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // No dark mode — v1 is light-only per design spec
  theme: {
    extend: {
      colors: {
        // ── Brand ────────────────────────────────────────────────
        navy: {
          50:  '#E8EDF3',
          100: '#C5D1DE',
          200: '#9EB2C6',
          300: '#7793AE',
          400: '#577A9B',
          500: '#376288',
          600: '#2A5179',
          700: '#1D3E63',
          800: '#122E4E',
          900: '#0E2841', // primary navy
          950: '#091A2B',
          DEFAULT: '#0E2841',
        },
        brand: {
          red:        '#C00000',
          'red-hover':'#A30000',
          'red-light':'#FEE2E2',
        },

        // ── Semantic surfaces ─────────────────────────────────────
        canvas:  '#F4F6F8',
        surface: '#FFFFFF',

        // ── Status scales ─────────────────────────────────────────
        success: {
          50:  '#F0FDF4',
          100: '#DCFCE7',
          500: '#22C55E',
          600: '#16A34A',
          700: '#166534',
          DEFAULT: '#166534',
        },
        warning: {
          50:  '#FFFBEB',
          100: '#FEF3C7',
          400: '#FBBF24',
          500: '#F59E0B',
          600: '#D97706',
          DEFAULT: '#D97706',
        },
        danger: {
          50:  '#FFF1F2',
          100: '#FFE4E6',
          500: '#EF4444',
          600: '#DC2626',
          700: '#C00000',
          DEFAULT: '#C00000',
        },
        info: {
          50:  '#EFF6FF',
          100: '#DBEAFE',
          500: '#3B82F6',
          600: '#2563EB',
          DEFAULT: '#2563EB',
        },

        // ── DPD buckets ───────────────────────────────────────────
        dpd: {
          current:      '#166534', // 0 DPD — green-700
          early:        '#D97706', // 1–29 — amber-600
          mild:         '#EA580C', // 30–59 — orange-600
          moderate:     '#DC2626', // 60–89 — red-600
          npl:          '#991B1B', // 90+ — red-800
          'written-off':'#374151',
          // legacy keys
          '1-30':  '#D97706',
          '31-60': '#EA580C',
          '61-90': '#DC2626',
          '91-180':'#991B1B',
          '180p':  '#374151',
        },

        // ── LOS stage palette ─────────────────────────────────────
        stage: {
          draft:       '#6B7280',
          submitted:   '#2563EB',
          docs:        '#7C3AED',
          risk:        '#0891B2',
          riskhead:    '#0E7490',
          conditions:  '#D97706',
          finance:     '#059669',
          booking:     '#166534',
          active:      '#15803D',
          declined:    '#991B1B',
          withdrawn:   '#6B7280',
        },
        // legacy los keys
        los: {
          draft:               '#6B7280',
          submitted:           '#3B82F6',
          document_collection: '#8B5CF6',
          risk_review:         '#F59E0B',
          risk_head_review:    '#F97316',
          pending_conditions:  '#6366F1',
          finance_approval:    '#0EA5E9',
          booking:             '#10B981',
          active:              '#059669',
          declined:            '#DC2626',
          withdrawn:           '#9CA3AF',
        },

        // ── Reconciliation ────────────────────────────────────────
        recon: {
          matched:   '#166534',
          unmatched: '#C00000',
          partial:   '#D97706',
          pending:   '#6B7280',
          exception: '#7C3AED',
        },

        // ── KPI RAG ───────────────────────────────────────────────
        rag: {
          green: '#166534',
          amber: '#D97706',
          red:   '#C00000',
        },

        // legacy alias
        o3c: { DEFAULT: '#C00000', light: '#D40000', dark: '#960000' },
      },

      // ── Typography ────────────────────────────────────────────────
      fontFamily: {
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['DM Mono', 'ui-monospace', 'monospace'],
      },

      // ── Shadows (navy-tinted) ─────────────────────────────────────
      boxShadow: {
        sm:          '0 1px 2px 0 rgb(14 40 65 / 0.05)',
        md:          '0 4px 6px -1px rgb(14 40 65 / 0.08), 0 2px 4px -2px rgb(14 40 65 / 0.05)',
        lg:          '0 10px 15px -3px rgb(14 40 65 / 0.08), 0 4px 6px -4px rgb(14 40 65 / 0.05)',
        xl:          '0 20px 25px -5px rgb(14 40 65 / 0.10), 0 8px 10px -6px rgb(14 40 65 / 0.05)',
        inner:       'inset 0 2px 4px 0 rgb(14 40 65 / 0.06)',
        sidebar:     '4px 0 16px -2px rgb(14 40 65 / 0.12)',
        'card-hover':'0 8px 20px -4px rgb(14 40 65 / 0.12)',
        focus:       '0 0 0 3px rgb(192 0 0 / 0.25)',
      },

      // ── Border radius ─────────────────────────────────────────────
      borderRadius: {
        sm:   '0.25rem',
        md:   '0.375rem',
        lg:   '0.5rem',
        xl:   '0.75rem',
        '2xl':'1rem',
        full: '9999px',
      },

      // ── Animations ────────────────────────────────────────────────
      keyframes: {
        shimmer: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.4' } },
        fadeIn:  { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideIn: { from: { opacity: '0', transform: 'translateX(-8px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        fadeIn:  'fadeIn 0.2s ease-out both',
        slideIn: 'slideIn 0.15s ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config
