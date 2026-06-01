/** @type {import('tailwindcss').Config} */

/*
 * Tailwind reads design tokens from CSS custom properties defined in index.css.
 * To change a brand color, shadow, or radius — edit :root in index.css only.
 * Do NOT hardcode values here; use 'rgb(var(--token) / <alpha-value>)' form.
 */

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },

      colors: {
        primary: {
          DEFAULT: 'rgb(var(--navy)       / <alpha-value>)',
          light:   'rgb(var(--navy-light) / <alpha-value>)',
          dark:    'rgb(var(--navy-dark)  / <alpha-value>)',
          50:      'rgb(var(--navy)       / 0.05)',
          100:     'rgb(var(--navy)       / 0.12)',
        },
        accent: {
          DEFAULT: 'rgb(var(--red)       / <alpha-value>)',
          light:   'rgb(var(--red-light) / <alpha-value>)',
          dark:    'rgb(var(--red-dark)  / <alpha-value>)',
          50:      'rgb(var(--red)       / 0.05)',
        },
      },

      boxShadow: {
        xs:       'var(--shadow-xs)',
        sm:       'var(--shadow-sm)',
        card:     'var(--shadow-sm)',
        'card-md':'var(--shadow-md)',
        'card-lg':'var(--shadow-lg)',
        dropdown: 'var(--shadow-xl)',
      },

      borderRadius: {
        sm:   'var(--r-sm)',
        md:   'var(--r-md)',
        lg:   'var(--r-lg)',
        xl:   'var(--r-xl)',
        card: 'var(--r-lg)',
      },

      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.05em' }],
      },

      transitionDuration: {
        fast: 'var(--t-fast)',
        base: 'var(--t-base)',
        slow: 'var(--t-slow)',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          from: { backgroundPosition: '-200% 0' },
          to:   { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        shimmer:   'shimmer 1.5s ease-in-out infinite',
      },
    },
  },
}
