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
  const [lastUpdate, setLastUpdate] = useState<string>('')
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
          client.publish(MINMAX_TOPIC, JSON.stringify(nextMinMax))
          return updated
        })
        setLastUpdate(new Date().toLocaleTimeString())
      }
    }

    const interval = setInterval(flush, 300)

    client.on('connect', () => {
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
      <div className={`${color} h-2 transition-all duration-1000 ease-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  const Icon = ({ name }: { name: string }) => {
    const map: Record<string, string> = {
      'pool': '🏊‍♂️',
      'drucker': '🖨️',
      'strom': '⚡',
      'gas': '🔥',
      'temp': '🌡️',
      'steckdose': '🔌',
    }
    return <span className="mr-2">{map[name]}</span>
  }

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
        {/* 3D-Drucker zusammen */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3 flex items-center"><Icon name="drucker" />3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map(printer => {
            const dev = topics.find(t => t.label === printer)
            if (!dev) return null
            const key = dev.statusTopic ?? dev.topic
            const val = values[key]?.toUpperCase()
            return (
              <div key={printer} className="flex justify-between my-1">
                <span>{printer}</span>
                <button className={`px-3 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(dev.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Doppelsteckdose */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3 flex items-center"><Icon name="steckdose" />Steckdosen</h2>
          {['Steckdose 1', 'Steckdose 2'].map(label => {
            const t = topics.find(x => x.label === label)
            if (!t) return null
            const key = t.statusTopic ?? t.topic
            const val = values[key]?.toUpperCase()
            return (
              <div key={label} className="flex justify-between my-1">
                <span>{label}</span>
                <button className={`px-3 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(t.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Pool */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3 flex items-center"><Icon name="pool" />Pool</h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const key = 'Pool_temp/temperatur'
            const raw = values[key]
            const val = raw ? parseFloat(raw) : NaN
            const range = minMax[key] ?? { min: val, max: val }
            return (
              <>
                <div className="flex justify-between my-1">
                  <span>Pumpe</span>
                  {pumpe && (
                    <button className={`px-3 py-1 rounded text-white ${values[pumpe.topic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.topic])}>
                      {values[pumpe.topic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <div className="mt-2">
                  Temperatur: {isNaN(val) ? '...' : `${val} °C`}
                  {progressBar(val, 40, getBarColor('Pool Temperatur', val))}
                  <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} °C | Max: {range.max?.toFixed(1)} °C</p>
                </div>
              </>
            )
          })()}
        </div>
        {/* Zähler zusammen */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2 flex items-center"><Icon name="strom" />Zähler</h2>
          <p>Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
          <p>Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
        </div>

        {/* Alle anderen */}
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Ender 3 Pro', 'Sidewinder X1', 'Steckdose 1', 'Steckdose 2', 'Poolpumpe'].includes(t.label)
        ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const raw = values[key]
          const val = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(val)
          const showMinMax = !label.includes('gesamt') && (key.includes('power_L') || key.includes('Verbrauch_aktuell') || key === 'Pool_temp/temperatur' || key.includes('Balkonkraftwerk'))
          const range = minMax[key] ?? { min: val, max: val }
          const barColor = getBarColor(label, val)

          return (
            <div key={key} className={`rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800`}>
              <h2 className="text-md font-bold mb-2">{label}</h2>
              {type === 'boolean' && (
                <button className={`px-3 py-1 rounded text-white ${raw?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(publishTopic ?? key, raw)}>
                  {raw?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(val, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}</p>}
                </>
              )}
              {type === 'string' && <p className="text-lg">{raw ?? '...'}</p>}
            </div>
          )
        })}

        {/* Gruppen: Spannung, Strom, Leistung */}
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800 col-span-full">
            <h2 className="text-md font-bold mb-2">{group.label} L1–L3</h2>
            <div className="grid grid-cols-3 gap-4">
              {group.keys?.map(({ label: phaseLabel, key }) => {
                const raw = values[key]
                const val = raw !== undefined ? parseFloat(raw) : NaN
                const range = minMax[key] ?? { min: val, max: val }
                return (
                  <div key={key}>
                    <div className="text-sm">{phaseLabel}: {isNaN(val) ? '...' : `${val} ${group.unit}`}</div>
                    {progressBar(val, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                    <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}</p>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </main>
  )
}

export default App
