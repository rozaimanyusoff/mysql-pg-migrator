/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Mist / Sage light mode — replaces Tailwind's neutral gray with a
        // subtle green tint so light mode feels softer without looking green.
        // Dark mode uses slate-* throughout so this palette doesn't affect it.
        gray: {
          50:  '#f4f6f4',
          100: '#eaeeea',
          200: '#d9dfd9',
          300: '#c2cac2',
          400: '#8d9b8d',
          500: '#697469',
          600: '#4c594c',
          700: '#374737',
          800: '#202e20',
          900: '#141e14',
          950: '#0b150b',
        },
      },
    },
  },
  plugins: [],
};
