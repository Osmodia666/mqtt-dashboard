// src/config.ts
export const mqttConfig = {
  host: 'wss://cyberdyne.chickenkiller.com:8884',
  username: 'christopher',
  password: 'v6Vrhy6u4reJsng',
}

export const topics = [
  {
    label: 'Ender 3 Pro',
    type: 'boolean',
    statusTopic: 'stat/Ender_3_Pro/POWER1',
    publishTopic: 'cmnd/Ender_3_Pro/POWER',
    favorite: true,
  },
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
    label: 'Doppelsteckdose',
    type: 'boolean',
    statusTopic: 'stat/Doppelsteckdose/POWER',
    publishTopic: 'cmnd/Doppelsteckdose/POWER',
  },
  {
    label: 'Beleuchtung',
    type: 'boolean',
    statusTopic: 'stat/Beleuchtung/POWER',
    publishTopic: 'cmnd/Beleuchtung/POWER',
  },
  {
    label: 'Teichpumpe',
    type: 'boolean',
    statusTopic: 'stat/Teichpumpe/POWER',
    publishTopic: 'cmnd/Teichpumpe/POWER',
  },
  {
    label: 'Poolpumpe',
    type: 'boolean',
    statusTopic: 'stat/Poolpumpe/POWER',
    publishTopic: 'cmnd/Poolpumpe/POWER',
  },
  {
    label: 'Verbrauch aktuell:',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Verbrauch_aktuell',
  },
  {
    label: 'Verbrauch gesamt:',
    type: 'number',
    unit: 'kWh',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt',
  },
  {
    label: 'Einspeisung gesamt:',
    type: 'number',
    unit: 'kWh',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Eingespeist_gesamt',
  },
  {
    label: 'Gaszähler',
    type: 'string',
    topic: 'Gaszaehler/stand',
  },
  {
    label: 'Balkonkraftwerk Erzeugung:',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0',
  },
  {
    label: 'Erzeugung [gesamt]:',
    type: 'number',
    unit: 'kWh',
    statusTopic: 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0',
  },
  {
    label: 'Pool Temperatur',
    type: 'number',
    unit: '°C',
    topic: 'Pool_temp/temperatur',
  },

  // 🔌 Gruppierte Anzeige: Leistung L1–L3
  {
    label: 'Leistung L1–L3',
    type: 'group',
    unit: 'W',
    keys: [
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.power_L1' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.power_L2' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.power_L3' },
    ],
  },

  // 🔌 Gruppierte Anzeige: Spannung L1–L3
  {
    label: 'Spannung L1–L3',
    type: 'group',
    unit: 'V',
    keys: [
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.Spannung_L1' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.Spannung_L2' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.Spannung_L3' },
    ],
  },

  // 🔌 Gruppierte Anzeige: Strom L1–L3
  {
    label: 'Strom L1–L3',
    type: 'group',
    unit: 'A',
    keys: [
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.Strom_L1' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.Strom_L2' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.Strom_L3' },
    ],
  },
]
