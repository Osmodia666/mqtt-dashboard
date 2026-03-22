// src/config.ts

export const mqttConfig = {
  host: 'wss://cyberdyne.chickenkiller.com:8443/mqtt/',
  username: 'christopher',
  password: 'v6Vrhy6u4reJsng',
}

export const topics = [
  {
  label: 'Carport-Licht',
  type: 'boolean',
  statusTopic: 'stat/Carport-Licht/POWER',
  publishTopic: 'cmnd/Carport-Licht/POWER',
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
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.sml_L1_W' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.sml_L2_W' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.sml_L3_W' },
    ],
  },
  {
    label: 'Spannung L1–L3',
    type: 'group',
    unit: 'V',
    keys: [
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.sml_L1_V' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.sml_L2_V' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.sml_L3_V' },
    ],
  },
  {
    label: 'Strom L1–L3',
    type: 'group',
    unit: 'A',
    keys: [
      { label: 'L1', key: 'tele/Stromzähler/SENSOR.grid.sml_L1_A' },
      { label: 'L2', key: 'tele/Stromzähler/SENSOR.grid.sml_L2_A' },
      { label: 'L3', key: 'tele/Stromzähler/SENSOR.grid.sml_L3_A' },
    ],
  },
]
