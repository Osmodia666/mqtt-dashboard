// src/theme.ts  ──  Option B: dunklerer BG, Pill-Labels, farbige Card-Border

export const T = {
  bg:      '#080d14',
  surf:    '#0d1422',
  border:  'rgba(255,255,255,0.07)',

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
  radius:    7,
  btnRadius: '3px',
} as const
