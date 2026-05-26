/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#0E2841',
          light:   '#1a3a5c',
          dark:    '#091a2d',
          50:      '#e8eef5',
          100:     '#c5d3e6',
        },
        accent: {
          DEFAULT: '#C00000',
          dark:    '#900000',
          light:   '#e00000',
          50:      '#fef2f2',
        },
      },
      fontFamily: {
        sans: ['Manrope', 'sans-serif'],
        mono: ['DM Mono', 'monospace'],
      },
    },
  },
}
