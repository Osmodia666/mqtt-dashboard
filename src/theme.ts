// src/theme.ts  ──  Signal · Outfit
// Schrift: Outfit (Google Fonts)
// Farbe: Navy-Blau, Indigo-Akzent

export const T = {
  // Hintergründe
  bg:      '#0f1520',
  surf:    '#171f2e',
  border:  'rgba(255,255,255,0.08)',

  // Text
  text:    '#e0eaff',
  muted:   'rgba(224,234,255,0.38)',

  // Akzent (Indigo)
  accent:  '#818cf8',

  // Status
  ok:      '#34d399',
  warn:    '#fbbf24',
  err:     '#f87171',

  // Sparkline-Farben pro Kategorie
  spark: {
    power:  '#818cf8',   // Indigo  → Leistung
    energy: '#34d399',   // Grün    → Erzeugung / Pool
    warn:   '#fbbf24',   // Amber   → Warnung
    purple: '#c084fc',   // Lila    → Spannung
    orange: '#fb923c',   // Orange  → Strom L1-L3
    cyan:   '#38bdf8',   // Cyan    → Pool kalt
  },

  // Typografie
  fontBody:  '"Outfit", system-ui, sans-serif',
  fontLabel: '"Outfit", system-ui, sans-serif',
  fontMono:  '"Outfit", system-ui, sans-serif',

  // Größen
  labelSize: '12px',
  radius:    10,
  btnRadius: '6px',
} as const
