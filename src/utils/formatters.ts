// src/utils/formatters.ts

export const fw = (n: number, d = 0) => (isNaN(n) ? '…' : n.toFixed(d))

export const fr = (n: number) => (isNaN(n) ? '…' : String(Math.round(n)))

export const fkwh = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} kWh`)

export const fEur = (v: number) => (v >= 0 ? `+${v.toFixed(2)} €` : `${v.toFixed(2)} €`)

export const formatDate = (s: string, format: 'jahr' | 'monat' | 'woche' = 'woche'): string => {
  const d = new Date(s + 'T12:00:00')
  return format === 'jahr'
    ? `${d.getDate()}.${d.getMonth() + 1}.`
    : format === 'monat'
      ? `${d.getDate()}.`
      : format === 'woche'
        ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]
        : s
}

export const fmtGasDate = (s: string, format: 'jahr' | 'monat' | 'woche'): string => {
  if (s.length === 7) return s.slice(5)
  const d = new Date(s + 'T12:00:00')
  return format === 'monat' ? `${d.getDate()}.` : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]
}

export const fmtGasDateYear = (s: string): string => s.length === 7 ? s.slice(5) : s
