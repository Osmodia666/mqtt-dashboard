// src/theme.ts  ──  Iron · Share Tech Mono
// Schrift: Share Tech Mono (wie Gaszähler)
// Farbe: warmes Dunkelgrau, Orange-Akzent

export const T = {
  bg:      '#111318',
  surf:    '#1a1d24',
  border:  'rgba(255,255,255,0.07)',

  text:    '#dde2f0',
  muted:   'rgba(255,255,255,0.36)',

  accent:  '#e8572a',

  ok:      '#34d399',
  warn:    '#fbbf24',
  err:     '#f87171',

  spark: {
    power:  '#60a5fa',
    energy: '#34d399',
    warn:   '#fbbf24',
    purple: '#c084fc',
    orange: '#e8572a',
    cyan:   '#38bdf8',
  },

  fontBody:  '"Share Tech Mono", monospace',
  fontLabel: '"Share Tech Mono", monospace',
  fontMono:  '"Share Tech Mono", monospace',

  labelSize: '11px',
  radius:    8,
  btnRadius: '3px',
} as const
