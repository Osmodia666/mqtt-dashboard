// src/constants.ts
import { VICTRON_PORTAL_ID } from './config'
import { T } from './theme'

export const MINMAX_TOPIC = 'dashboard/minmax/update'
export const REQUEST_TOPIC = 'dashboard/minmax/request'
export const HISTORY_LENGTH = 60
export const MINMAX_CACHE_KEY = 'mqtt_minmax_cache'

export const V = (path: string) => `N/${VICTRON_PORTAL_ID}/${path}`
export const VW = (path: string) => `W/${VICTRON_PORTAL_ID}/${path}`

export const VICTRON_TOPICS = {
  soc: V('system/0/Dc/Battery/Soc'),
  batVoltage: V('system/0/Dc/Battery/Voltage'),
  batCurrent: V('system/0/Dc/Battery/Current'),
  batPower: V('system/0/Dc/Battery/Power'),
  batTemp: V('system/0/Dc/Battery/Temperature'),
  batState: V('system/0/Dc/Battery/State'),
  pvPower: V('solarcharger/288/Yield/Power'),
  pvVoltage: V('solarcharger/288/Pv/V'),
  pvCurrent: V('solarcharger/288/Pv/I'),
  mpptState: V('solarcharger/288/State'),
  acOutPower: V('vebus/288/Ac/Out/P'),
  acOutVoltage: V('vebus/288/Ac/Out/L1/V'),
  acOutFreq: V('vebus/288/Ac/Out/L1/F'),
  vebusState: V('vebus/288/VebusStatus'),
  vebusMode: V('vebus/288/Mode'),
  essMode: V('settings/0/Settings/CGwacs/BatteryLife/State'),
  gridL1: V('grid/30/Ac/L1/Power'),
  gridL2: V('grid/30/Ac/L2/Power'),
  gridL3: V('grid/30/Ac/L3/Power'),
  gridTotal: V('grid/30/Ac/Power'),
  consL1: V('system/0/Ac/Consumption/L1/Power'),
  consL2: V('system/0/Ac/Consumption/L2/Power'),
  consL3: V('system/0/Ac/Consumption/L3/Power'),
  dcSystem: V('system/0/Dc/System/Power'),
} as const

export const EXPLICIT_SUBSCRIBES = [
  'tele/Stromzähler/SENSOR',
  'tele/Balkonkraftwerk/SENSOR',
  'pool/temperatur',
  'Gaszaehler/stand',
  'stat/+/POWER',
  'stat/+/POWER1',
  'stat/+/RESULT',
  MINMAX_TOPIC,
  'Stromzähler/#',
  'stats/#',
  `N/${VICTRON_PORTAL_ID}/#`,
]

export const mpptStateLabel = (s: number): string => {
  const labels: Record<number, string> = {
    0: 'Aus',
    2: 'Fehler',
    3: 'Bulk',
    4: 'Absorption',
    5: 'Float',
    7: 'Manuell',
    11: 'Laden',
    245: 'Starten',
    247: 'Laden',
    252: 'Ext. Steuerung',
  }
  return labels[s] ?? `Status ${s}`
}

export const batStateLabel = (s: number): string => {
  const labels: Record<number, string> = {
    0: 'Bereit',
    1: 'Laden',
    2: 'Entladen',
  }
  return labels[s] ?? `Status ${s}`
}

export const leistungColor = (w: number): string => {
  if (w < 0) return T.ok
  return w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok
}

export const phasenColor = (w: number): string => {
  if (isNaN(w)) return T.muted
  if (w < 0) return T.ok
  if (w >= 1500) return T.err
  if (w >= 500) return T.warn
  return T.spark.power
}

export const BAT_CAPACITY_KWH = 3.5
export const BAT_DOD = 0.8
export const BAT_CYCLES_MAX = 6000
export const BAT_KWH_TOTAL = BAT_CYCLES_MAX * BAT_CAPACITY_KWH * BAT_DOD

export const PREIS_KWH = 0.311
export const GRUNDPREIS = 165.0
export const GAS_PREIS = 0.11
export const GAS_KWH_M3 = 10.0

export type Tab = 'uebersicht' | 'energie' | 'victron' | 'steuerung' | 'verlauf'

export const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: '⚡' },
  { id: 'energie', label: 'Energie', icon: '🌿' },
  { id: 'victron', label: 'Victron', icon: '🔋' },
  { id: 'steuerung', label: 'Steuerung', icon: '🔌' },
  { id: 'verlauf', label: 'Verlauf', icon: '📈' },
]
