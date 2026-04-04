// src/theme.ts  ──  Iron · Barlow
// Schrift: Barlow (Google Fonts)
// Farbe: warmes Dunkelgrau, Orange-Akzent

export const T = {
  bg:      '#111318',
  surf:    '#1a1d24',
  border:  'rgba(255,255,255,0.07)',

  text:    '#dde2f0',
  muted:   'rgba(255,255,255,0.38)',

  // Akzent (warmes Orange)
  accent:  '#e8572a',

  ok:      '#34d399',
  warn:    '#fbbf24',
  err:     '#f87171',

  spark: {
    power:  '#60a5fa',   // Blau    → Leistung
    energy: '#34d399',   // Grün    → Erzeugung / Pool
    warn:   '#fbbf24',   // Amber
    purple: '#c084fc',   // Lila    → Spannung
    orange: '#e8572a',   // Orange  → Strom L1-L3
    cyan:   '#38bdf8',   // Cyan    → Pool kalt
  },

  fontBody:  '"Barlow", system-ui, sans-serif',
  fontLabel: '"Barlow", system-ui, sans-serif',
  fontMono:  '"Barlow", system-ui, sans-serif',

  labelSize: '12px',
  radius:    10,
  btnRadius: '4px',
} as const
