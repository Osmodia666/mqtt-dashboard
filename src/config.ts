export const mqttConfig = {
  host: 'wss://cyberdyne.chickenkiller.com:8884',
  username: 'christopher',
  password: 'v6Vrhy6u4reJsng',
}

export const topics = [
  {
    label: 'Ender 3 Pro',
    type: 'boolean',
    statusTopic: 'mqtt.0.stat.Ender_3_Pro.POWER1',
    publishTopic: 'mqtt.0.cmnd.Ender_3_Pro.POWER',
    favorite: true,
  },
  {
    label: 'Steckdose 2',
    type: 'boolean',
    statusTopic: 'stat/Steckdose_2/POWER',
    publishTopic: 'cmnd/Steckdose_2/POWER',
  },
  {
    label: 'Teichpumpe',
    type: 'boolean',
    statusTopic: 'stat/Teichpumpe/POWER',
    publishTopic: 'cmnd/Teichpumpe/POWER',
  },
  {
    label: 'Gaszähler Stand',
    type: 'number',
    unit: 'm³',
    statusTopic: 'mqtt.0.Gaszaehler.stand', // dieser bleibt
  },
  {
    label: 'Balkonkraftwerk Power',
    type: 'number',
    unit: 'W',
    statusTopic: 'mqtt.0.Balkonkraftwerk.ENERGY_Power_0',
    favorite: true,
  },
]
