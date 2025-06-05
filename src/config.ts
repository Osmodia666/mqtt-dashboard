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
    statusTopic: 'stat/Sidewinde_X1/POWER1',
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
    label: 'Pool Temperatur:',
    type: 'number',
    unit: '°C',
    statusTopic: 'Pool_temp/temperatur',
  },
   {
    label: 'Verbrauch aktuell:',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Verbrauch_aktuell',
  },
 {
    label: 'Eingespeist aktuell:',
    type: 'number',
    unit: 'kWh',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Eingespeist_gesamt',
  },  
  {
    label: 'Gaszähler Stand',
    type: 'number',
    unit: 'm³',
    statusTopic: 'Gaszaehler/stand',
  },
  {
    label: 'Spannung L1',
    type: 'number',
    unit: 'V',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Spannung_L1',
  },
   {
    label: 'Strom L1',
    type: 'number',
    unit: 'A',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Strom_L1',
  },
    {
    label: 'Leistung L1',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.power_L1',
  },
  {
    label: 'Spannung L2',
    type: 'number',
    unit: 'V',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Spannung_L2',
  },
   {
    label: 'Strom L2',
    type: 'number',
    unit: 'A',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Strom_L2',
  },
    {
    label: 'Leistung L2',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.power_L2',
  },
  {
    label: 'Spannung L3',
    type: 'number',
    unit: 'V',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Spannung_L3',
  },
   {
    label: 'Strom L3',
    type: 'number',
    unit: 'A',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.Strom_L3',
  },
    {
    label: 'Leistung L3',
    type: 'number',
    unit: 'W',
    statusTopic: 'tele/Stromzähler/SENSOR.grid.power_L3',
  },
   {
    label: 'Balkonkraftwerk Power',
    type: 'number',
    unit: 'W',
    statusTopic: 'Balkonkraftwerk/ENERGY_Power_0',
    favorite: true,
  },
]
