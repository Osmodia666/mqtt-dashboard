// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})
client.setMaxListeners(100)

type MinMax = Record<string, { min: number; max: number }>
const STORAGE_KEY = 'global_minmax_store'
const LAST_RESET_KEY = 'global_minmax_store_reset'
const MINMAX_TOPIC = 'dashboard/minmax/update'

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const messageQueue = useRef<Record<string, string>>({})

  useEffect(() => {
    const now = Date.now()
    const lastReset = parseInt(localStorage.getItem(LAST_RESET_KEY) || '0', 10)
    if (now - lastReset > 86400000) {
      setMinMax({})
      localStorage.setItem(LAST_RESET_KEY, String(now))
      localStorage.removeItem(STORAGE_KEY)
    }

const flush = () => {
  const updates = { ...messageQueue.current }
  messageQueue.current = {}

  if (Object.keys(updates).length > 0) {
    setValues(prev => {
      const updated = { ...prev, ...updates }
      const nextMinMax: MinMax = { ...minMax }

      for (const [key, val] of Object.entries(updates)) {
        const num = parseFloat(val)
        if (!isNaN(num) && (
          key.includes('power_L') ||
          key.includes('Verbrauch_aktuell') ||
          key === 'Pool_temp/temperatur' ||
          key.includes('Balkonkraftwerk') ||
          key.includes('Voltage') ||
          key.includes('Strom_L')
        )) {
          const current = nextMinMax[key] ?? { min: num, max: num }
          nextMinMax[key] = {
            min: Math.min(current.min, num),
            max: Math.max(current.max, num),
          }
        }
      }

      setMinMax(nextMinMax)
      // Statt localStorage → per MQTT an den zentralen Broker senden
      client.publish(MINMAX_TOPIC, JSON.stringify(nextMinMax))
      return updated
    })
    setLastUpdate(new Date().toLocaleTimeString())
  }
}


    const interval = setInterval(flush, 300)

    client.on('connect', () => {
      client.publish('dashboard/minmax/request', '')
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

    client.on('message', (topic, message) => {
      const payload = message.toString()
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload
        return
      }

      if (topic === MINMAX_TOPIC) {
  try {
    const incoming = JSON.parse(payload)
    setMinMax(prev => ({ ...prev, ...incoming }))
  } catch (err) {
    console.error('[MQTT] Fehler beim MinMax-Update:', err)
  }
  return
}


      try {
        const json = JSON.parse(payload)
        const flatten = (obj: any, prefix = ''): Record<string, string> =>
          Object.entries(obj).reduce((acc, [key, val]) => {
            const newKey = prefix ? ${prefix}.${key} : key
            if (typeof val === 'object' && val !== null) {
              Object.assign(acc, flatten(val, newKey))
            } else {
              acc[newKey] = String(val)
            }
            return acc
          }, {})
        const flat = flatten(json)
        for (const [key, val] of Object.entries(flat)) {
          const combinedKey = ${topic}.${key}
          messageQueue.current[combinedKey] = val
        }
      } catch {
        messageQueue.current[topic] = payload
      }
    })

    return () => clearInterval(interval)
  }, [minMax])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
    if (label.includes('Balkonkraftwerk')) return value > 450 ? 'bg-green-500' : value > 150 ? 'bg-yellow-400' : 'bg-red-600'
    if (label.includes('Pool Temperatur')) return value > 23 ? 'bg-green-500' : value > 17 ? 'bg-yellow-400' : 'bg-blue-500'
    return 'bg-blue-500'
  }

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={${color} h-2 transition-all duration-1000 ease-in-out} style={{ width: ${Math.min(100, (value / max) * 100)}% }} />
    </div>
  )

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🧱 3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}}>
                <span>{label}</span>
                <button className={px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

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
            <button className={px-4 py-1 rounded text-white ${values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}}
              onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.statusTopic])}>
              {values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
            </button>
          )}
        </div>
        <p className="mt-3">🌡️ Temperatur: {isNaN(val) ? '...' : ${val} °C}</p>
        {progressBar(val, 40, getBarColor('Pool Temperatur', val))}
        <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} °C | Max: {range.max?.toFixed(1)} °C</p>
      </>
    )
  })()}
</div>


  <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
  <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
  <div className="flex flex-col space-y-3">
      <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
    <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
  </div>
</div>

<div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
  <h2 className="text-md font-bold mb-3">🔋 Erzeugung</h2>
  <p>Gesamt: {(() => {
    const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
    const raw = values[key]
    const num = parseFloat(raw)
    return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
  })()} kWh</p>
</div>

        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen</h2>
          {['Steckdose 1', 'Steckdose 2'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}}>
                <span>{label}</span>
                <button className={px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

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
            <div key={key} className={rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800}>
              <h2 className="text-md font-bold mb-2">{label}</h2>
              {type === 'boolean' && (
                <button className={px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}} onClick={() => toggleBoolean(publishTopic ?? key, value)}>
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}</p>}
                </>
              )}
              {type === 'string' && <p className="text-lg">{raw ?? '...'}</p>}
            </div>
          )
        })}
      </div>

      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <h2 className="text-lg font-bold mb-2">{group.label}</h2>
            {group.keys?.map(({ label, key }) => {
              const raw = values[key]
              const num = raw !== undefined ? parseFloat(raw) : NaN
              const range = minMax[key] ?? { min: num, max: num }
              return (
                <div key={key} className="mb-2">
                  <div className="text-sm">{label}: {isNaN(num) ? '...' : ${num} ${group.unit}}</div>
                  {progressBar(num, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}</div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </main>
  )
}

export default App
