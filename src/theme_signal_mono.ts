// src/theme.ts  ──  Signal · Share Tech Mono
// Schrift: Share Tech Mono (wie Gaszähler)
// Farbe: Navy-Blau, Indigo-Akzent

export const T = {
  bg:      '#0f1520',
  surf:    '#171f2e',
  border:  'rgba(255,255,255,0.08)',

  text:    '#e0eaff',
  muted:   'rgba(224,234,255,0.35)',

  accent:  '#818cf8',

  ok:      '#34d399',
  warn:    '#fbbf24',
  err:     '#f87171',

  spark: {
    power:  '#818cf8',
    energy: '#34d399',
    warn:   '#fbbf24',
    purple: '#c084fc',
    orange: '#fb923c',
    cyan:   '#38bdf8',
  },

  fontBody:  '"Share Tech Mono", monospace',
  fontLabel: '"Share Tech Mono", monospace',
  fontMono:  '"Share Tech Mono", monospace',

  labelSize: '11px',
  radius:    8,
  btnRadius: '3px',
} as const
