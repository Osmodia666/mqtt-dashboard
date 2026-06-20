// src/types.ts

export type MinMax = Record<string, { min: number; max: number }>

export type Tab = 'uebersicht' | 'energie' | 'victron' | 'steuerung' | 'verlauf'

export type StatDay = {
  date: string
  verbrauch_kwh: number | null
  erzeugung_kwh: number | null
  solar_kwh: number | null
  bkw_kwh: number | null
  gas_m3: number | null
  soc_min: number | null
  soc_max: number | null
  soc_avg: number | null
}

export type StatPeriod = {
  verbrauch_kwh: number | null
  erzeugung_kwh: number | null
  solar_kwh: number | null
  bkw_kwh: number | null
  gas_m3: number | null
  tage: StatDay[]
}

export type EnergyTabType = 'ueberblick' | 'phasen' | 'details'

export type VerlaufZeitraum = 'heute' | 'woche' | 'monat' | 'jahr' | 'gesamt'

export type VerlaufAnsicht = 'strom' | 'gas'

export type HoveredBar = {
  d: StatDay
  x: number
  y: number
} | null
