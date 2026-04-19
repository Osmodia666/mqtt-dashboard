// src/config.ts

export const mqttConfig = {
  host: 'wss://cyberdyne.chickenkiller.com:8443/mqtt/',
  username: 'christopher',
  password: 'v6Vrhy6u4reJsng',
}

// Venus OS Portal-ID – anpassen!
export const VICTRON_PORTAL_ID = 'b827eb75907a'

// ESS-Modi (Settings/CGwacs/BatteryLife/State)
export const ESS_MODES = [
  { value: 1, label: 'Optimiert',      sub: 'mit BatteryLife' },
  { value: 10, label: 'Optimiert',     sub: 'ohne BatteryLife' },
  { value: 9, label: 'Batterie laden', sub: 'Batterie geladen halten' },
  { value: 3, label: 'Extern',         sub: 'ESS Externe Steuerung' },
] as const

// Wechselrichter-Modi (vebus/.../Mode)
export const INVERTER_MODES = [
  { value: 3, label: 'An',               sub: 'Normal' },
  { value: 1, label: 'Nur Laden',        sub: 'Charger only' },
  { value: 2, label: 'Nur Inverter',     sub: 'Inverter only' },
  { value: 4, label: 'Aus',              sub: 'Off' },
] as const

export const topics = [
  {
    label: 'Sidewinder X1',
    type: 'boolean',
    statusTopic: 'stat/Sidewinder_X1/POWER1',
    publishTopic: 'cmnd/Sidewinder_X1/POWER',
    favorite: true,
  },
  {
    label: 'Steckdose 1',
    type: 'boolean',
    statusTopic: 'stat/Steckdose_1/POWER',
    publishTopic: 'cmnd/Steckdose_1/POWER',
  },
  {
    label: 'Steckdose 2',
    type: 'boolean',
    statusTopic: 'stat/Steckdose_2/POWER',
    publishTopic: 'cmnd/Steckdose_2/POWER',
  },
  {
    label: 'Poolpumpe',
    type: 'boolean',
    statusTopic: 'stat/Poolpumpe/POWER',
    publishTopic: 'cmnd/Poolpumpe/POWER',
  },
  {
    label: 'Leistung L1–L3',
    type: 'group',
    unit: 'W',
    keys: [
      { label: 'L1', key: 'Stromzähler/Wirkleistung_L1' },
      { label: 'L2', key: 'Stromzähler/Wirkleistung_L2' },
      { label: 'L3', key: 'Stromzähler/Wirkleistung_L3' },
    ],
  },
  {
    label: 'Spannung L1–L3',
    type: 'group',
    unit: 'V',
    keys: [
      { label: 'L1', key: 'Stromzähler/Spannung_L1' },
      { label: 'L2', key: 'Stromzähler/Spannung_L2' },
      { label: 'L3', key: 'Stromzähler/Spannung_L3' },
    ],
  },
  {
    label: 'Strom L1–L3',
    type: 'group',
    unit: 'A',
    keys: [
      { label: 'L1', key: 'Stromzähler/Strom_L1' },
      { label: 'L2', key: 'Stromzähler/Strom_L2' },
      { label: 'L3', key: 'Stromzähler/Strom_L3' },
    ],
  },
]
