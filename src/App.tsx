// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

type MinMax = Record<string, { min: number; max: number }>
const MINMAX_TOPIC = 'dashboard/minmax/update'
const REQUEST_TOPIC = 'dashboard/minmax/request'

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [minMax, setMinMax] = useState<MinMax>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const clientRef = useRef<any>(null)
  const messageQueue = useRef<Record<string, string>>({})

  // Funktion, um einen ioBroker HTTP-Adapter Endpunkt auszulesen
  async function getPlainValue(dpId: string): Promise<number | null> {
    try {
      const response = await fetch(`cyberdyne.chickenkiller.com:8087/getPlainValue/${dpId}`)
      if (!response.ok) return null
      const text = await response.text()
      const num = parseFloat(text)
      return isNaN(num) ? null : num
    } catch {
      return null
    }
  }

  // MinMax via HTTP beim Laden holen
  useEffect(() => {
    async function fetchMinMaxAll() {
      // Liste mit Keys, die du brauchst (passe an!)
      const keys = [
        'Pool_temp/temperatur',
        'tele/Stromzähler/SENSOR.grid.Verbrauch_aktuell',
        'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0',
        'tele/Stromzähler.Verbrauch_aktuell',
        // Hier weitere Keys ergänzen...
      ]

      const newMinMax: MinMax = {}

      for (const key of keys) {
        // ioBroker-Datenpunktnamen mit _ statt /
        const basePath = `0_userdata.0.MinMax.${key.replace(/\//g, '_')}`
        const min = await getPlainValue(`${basePath}.min`)
        const max = await getPlainValue(`${basePath}.max`)
        if (min !== null && max !== null) {
          newMinMax[key] = { min, max }
        }
      }
      setMinMax(newMinMax)
    }

    fetchMinMaxAll()
  }, []) // nur einmal beim Start

  // MQTT-Verbindung und Message Handling
  useEffect(() => {
    const client = mqtt.connect(mqttConfig.host, {
      username: mqttConfig.username,
      password: mqttConfig.password,
    })
    clientRef.current = client

    client.on('connect', () => {
      client.publish(REQUEST_TOPIC, '')
      const allTopics = topics.map(t => t.statusTopic || t.topic).filter(Boolean)
      client.subscribe([...allTopics, '#', MINMAX_TOPIC])
      topics.forEach(({ publishTopic }) => {
        if (publishTopic?.includes('/POWER')) client.publish(publishTopic, '')
        if (publishTopic) {
          const base = publishTopic.split('/')[1]
          client.publish(`cmnd/${base}/state`, '')
        }
      })
    })

    client.on('error', (err) => {
      console.error('MQTT Fehler:', err)
    })

    client.on('message', (topic, message) => {
      const payload = message.toString()

      // Pool Temp und Gaszähler sofort ins UI übernehmen
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload
        setValues(prev => {
          const updated = { ...prev, [topic]: payload }
          setLastUpdate(new Date().toLocaleTimeString())
          return updated
        })
        return
      }

      // MinMax-Update per MQTT
      if (topic === MINMAX_TOPIC) {
        try {
          const incoming = JSON.parse(payload)
          setMinMax(incoming)
        } catch (err) {
          console.error('[MQTT] Fehler beim MinMax-Update:', err)
        }
        return
      }

      // Alle anderen Topics: JSON flatten & in messageQueue sammeln
      try {
        const json = JSON.parse(payload)
        const flatten = (obj: any, prefix = ''): Record<string, string> =>
          Object.entries(obj).reduce((acc, [key, val]) => {
            const newKey = prefix ? `${prefix}.${key}` : key
            if (typeof val === 'object' && val !== null) {
              Object.assign(acc, flatten(val, newKey))
            } else {
              acc[newKey] = String(val)
            }
            return acc
          }, {})
        const flat = flatten(json)
        for (const [key, val] of Object.entries(flat)) {
          const combinedKey = `${topic}.${key}`
          messageQueue.current[combinedKey] = val
        }
      } catch {
        messageQueue.current[topic] = payload
      }
    })

    // Flush Funktion um messageQueue in State zu übertragen
    const flush = () => {
      const updates = { ...messageQueue.current }
      messageQueue.current = {}

      if (Object.keys(updates).length > 0) {
        setValues(prev => {
          const updated = { ...prev, ...updates }
          setLastUpdate(new Date().toLocaleTimeString())
          return updated
        })
      }
    }

    const interval = setInterval(flush, 300)
    return () => {
      clearInterval(interval)
      client.end(true)
    }
  }, [])

  // Umschalten für Boolean Werte via MQTT
  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({
      ...prev,
      [publishTopic.replace('cmnd/', 'stat/').replace('/POWER', '/POWER')]: next
    }))
    clientRef.current?.publish(publishTopic, next)
  }

  // Farbwahl für Progress Bars
  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) {
      if (value >= 1000) return 'bg-red-600'
      if (value >= 300) return 'bg-yellow-400'
      return 'bg-green-500'
    }
    if (label.includes('Balkonkraftwerk')) {
      if (value >= 500) return 'bg-green-500'
      if (value >= 250) return 'bg-yellow-400'
      return 'bg-red-600'
    }
    if (label.includes('Pool Temperatur')) return value > 23 ? 'bg-green-500' : value > 17 ? 'bg-yellow-400' : 'bg-blue-500'
    return 'bg-blue-500'
  }

  // Fortschrittsbalken UI-Komponente
  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  // === UI ===
  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {/* 3D-Drucker */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🧱 3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}`}>
                <span>{label}</span>
                <button className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Pool */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🏊 Pool</h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const raw = values[tempKey]
            const val = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[tempKey] ?? { min: val, max: val }

            return (
              <>
                <div className="flex justify-between items-center">
                  <span>Pumpe</span>
                  {pumpe && (
                    <button className={`px-4 py-1 rounded text-white ${values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                      onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.statusTopic])}>
                      {values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <p className="mt-3">🌡️ Temperatur: {isNaN(val) ? '...' : `${val} °C`}</p>
                {progressBar(val, 40, getBarColor('Pool Temperatur', val))}
                <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} °C | Max: {range.max?.toFixed(1)} °C</p>
              </>
            )
          })()}
        </div>

        {/* Zähler */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
          <div className="flex flex-col space-y-3">
            <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
            <p>🔋 BKW: {(() => {
              const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
              const raw = values[key]
              const num = parseFloat(raw)
              return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
            })()} kWh</p>
            <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
          </div>
        </div>

        {/* Strom Verbrauch & Erzeugung mit MinMax */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3">🔋 Strom</h2>
          {(() => {
            const key = 'tele/Stromzähler/SENSOR.grid.Verbrauch_aktuell'
            const raw = values[key]
            const num = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[key] ?? { min: num, max: num }

            let color = 'bg-green-500'
            if (num >= 1000) color = 'bg-red-600'
            else if (num >= 300) color = 'bg-yellow-400'

            return (
              <>
                <p className="mt-3">Verbrauch Aktuell: {isNaN(num) ? '...' : `${num} W`}</p>
                {progressBar(num, range.max > 0 ? range.max : 2000, color)}
                <p className="text-xs text-gray-400">
                  Min: {range.min?.toFixed(1)} W | Max: {range.max?.toFixed(1)} W
                </p>
              </>
            )
          })()}
          {(() => {
            const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
            const raw = values[key]
            const num = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[key] ?? { min: num, max: num }

            let color = 'bg-red-600'
            if (num >= 500) color = 'bg-green-500'
            else if (num >= 250) color = 'bg-yellow-400'
            return (
              <>
                <p className="mt-3">Erzeugung Aktuell: {isNaN(num) ? '...' : `${num} W`}</p>
                {progressBar(num, range.max > 0 ? range.max : 1000, color)}
                <p className="text-xs text-gray-400">
                  Min: {range.min?.toFixed(1)} W | Max: {range.max?.toFixed(1)} W
                </p>
              </>
            )
          })()}
        </div>

        {/* Steckdosen 1 */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen 1</h2>
          {['Steckdose 1', 'Steckdose 2'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}`}>
                <span>{label}</span>
                <button className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
          {/* Hardcoded Doppelsteckdose */}
          <div className="flex justify-between items-center mt-3">
            <span>Doppelsteckdose</span>
            <button
              className={`px-4 py-1 rounded text-white ${values['stat/Doppelsteckdose/POWER']?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
              onClick={() => toggleBoolean('cmnd/Doppelsteckdose/POWER', values['stat/Doppelsteckdose/POWER']?.toUpperCase())}
            >
              {values['stat/Doppelsteckdose/POWER']?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
            </button>
          </div>
        </div>

        {/* Steckdosen 2 */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen 2</h2>
          {[
            { label: 'Beleuchtung', publishTopic: 'cmnd/Beleuchtung/POWER', statusTopic: 'stat/Beleuchtung/POWER' },
            { label: 'Teichpumpe', publishTopic: 'cmnd/Teichpumpe/POWER', statusTopic: 'stat/Teichpumpe/POWER' }
          ].map(({ label, publishTopic, statusTopic }, i) => {
            const val = values[statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}`}>
                <span>{label}</span>
                <button className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Weitere Topics außer Gruppen */}
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Ender 3 Pro', 'Sidewinder X1', 'Poolpumpe', 'Steckdose 1', 'Steckdose 2'].includes(t.label)
        ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          let raw = values[key]
          const value = raw?.toUpperCase()
          const num = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(num)
          const showMinMax = !label.includes('gesamt') && (key.includes('power_L') || key.includes('Verbrauch_aktuell') || key.includes('Balkonkraftwerk'))
          const range = minMax[key] ?? { min: num, max: num }
          const barColor = getBarColor(label, num)
          return (
            <div key={key} className={`rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800`}>
              <h2 className="text-md font-bold mb-2">{label}</h2>
              {type === 'boolean' && (
                <button className={`px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(publishTopic ?? key, value)}>
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : num * 2, barColor)}
                  {showMinMax && <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}</p>}
                </>
              )}
              {!isNumber && type !== 'boolean' && <p>{raw ?? '...'}</p>}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
