// src/config.ts
export const mqttConfig = {
  host: 'wss://cyberdyne.chickenkiller.com:8884',
  username: 'christopher',
  password: 'v6Vrhy6u4reJsng',
}

export const topics = [
  { topic: 'mqtt.0.Poolpumpe.POWER', label: 'Poolpumpe', type: 'boolean', favorite: true },
  { topic: 'mqtt.0.Balkonkraftwerk.ENERGY_Power_0', label: 'Balkonkraftwerk Power', type: 'number', unit: 'W', favorite: true },
  { topic: 'mqtt.0.Teichpumpe.POWER', label: 'Teichpumpe', type: 'boolean' },
  { topic: 'mqtt.0.Doppelsteckdose.POWER', label: 'Doppelsteckdose', type: 'boolean' },
  { topic: 'mqtt.0.Beleuchtung.POWER', label: 'Beleuchtung', type: 'boolean' },
  { topic: 'mqtt.0.Steckdose 1.POWER', label: 'Steckdose 1', type: 'boolean' },
  { topic: 'mqtt.0.Steckdose 2.POWER', label: 'Steckdose 2', type: 'boolean' },
  { topic: 'mqtt.0.Ender 3 Pro.POWER1', label: 'Ender 3 Pro', type: 'boolean' },
  { topic: 'mqtt.0.Sidewinder X1.POWER1', label: 'Sidewinder X1', type: 'boolean' },
  { topic: 'mqtt.0.Stromzähler.grid_Verbrauch_aktuell', label: 'Verbrauch aktuell', type: 'number', unit: 'W' },
  { topic: 'mqtt.0.Stromzähler.grid_Verbrauch_gesamt', label: 'Verbrauch gesamt', type: 'number', unit: 'kWh' },
  { topic: 'mqtt.0.Gaszaehler.stand', label: 'Gaszähler Stand', type: 'number', unit: 'm³' },
  { topic: 'ds18b20.0.sensors.10-0008025fe5c7', label: 'Âussentemperatur', type: 'number', unit: '°C' },
  { topic: 'mqtt.0.Pool_temp.temperatur', label: 'Pool Temperatur', type: 'number', unit: '°C' },
  { topic: 'rpi2.0.temperature.soc_temp', label: 'Raspberry Pi Temperatur', type: 'number', unit: '°C' },
  { topic: 'mqtt.0.Stromzähler.grid_Spannung_L1', label: 'Spannung L1', type: 'number', unit: 'V' },
  { topic: 'mqtt.0.Stromzähler.grid_Strom_L1', label: 'Strom L1', type: 'number', unit: 'A' },
  { topic: 'mqtt.0.Stromzähler.grid_power_L1', label: 'Leistung L1', type: 'number', unit: 'W' },
  { topic: 'mqtt.0.Stromzähler.grid_Spannung_L2', label: 'Spannung L2', type: 'number', unit: 'V' },
  { topic: 'mqtt.0.Stromzähler.grid_Strom_L2', label: 'Strom L2', type: 'number', unit: 'A' },
  { topic: 'mqtt.0.Stromzähler.grid_power_L2', label: 'Leistung L2', type: 'number', unit: 'W' },
  { topic: 'mqtt.0.Stromzähler.grid_Spannung_L3', label: 'Spannung L3', type: 'number', unit: 'V' },
  { topic: 'mqtt.0.Stromzähler.grid_Strom_L3', label: 'Strom L3', type: 'number', unit: 'A' },
  { topic: 'mqtt.0.Stromzähler.grid_power_L3', label: 'Leistung L3', type: 'number', unit: 'W' },
  { topic: 'mqtt.0.Balkonkraftwerk.ENERGY_EnergyPToday_0', label: 'Ertrag heute', type: 'number', unit: 'kWh' },
  { topic: 'mqtt.0.Balkonkraftwerk.ENERGY_EnergyPYesterday_0', label: 'Ertrag gestern', type: 'number', unit: 'kWh' }
]
