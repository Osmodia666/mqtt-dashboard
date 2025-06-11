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

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {/* 3D-Drucker-Kachel */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            3D-Drucker
          </h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map(label => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const raw = values[topic.statusTopic ?? topic.topic]
            const value = raw?.toUpperCase()
            return (
              <div key={label} className="flex justify-between items-center my-2">
                <span>{label}</span>
                <button
                  className={`px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, value)}
                >
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>
        {/* Pool-Kachel */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M2 12h20M2 16h20M2 20h20" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Pool
          </h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const tempRaw = values[tempKey]
            const tempVal = tempRaw !== undefined ? parseFloat(tempRaw) : NaN
            const range = minMax[tempKey] ?? { min: tempVal, max: tempVal }

            return (
              <>
                <div className="flex justify-between items-center my-2">
                  <span>Pumpe</span>
                  {pumpe && (
                    <button
                      className={`px-4 py-1 rounded text-white ${values[pumpe.topic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                      onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.topic])}
                    >
                      {values[pumpe.topic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <div className="mt-2">
                  Temperatur: {isNaN(tempVal) ? '...' : `${tempVal} °C`}
                  {progressBar(tempVal, 40, getBarColor('Pool Temperatur', tempVal))}
                  <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} °C | Max: {range.max?.toFixed(1)} °C</p>
                </div>
              </>
            )
          })()}
        </div>

        {/* Steckdosen 1+2 */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M7 12V3m10 9V3m-5 13v6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Steckdosen
          </h2>
          {['Steckdose 1', 'Steckdose 2'].map(label => {
            const t = topics.find(t => t.label === label)
            if (!t) return null
            const val = values[t.topic]?.toUpperCase()
            return (
              <div key={label} className="flex justify-between items-center my-3">
                <span>{label}</span>
                <button className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(t.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Strom+Gas Zähler */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M11 17v-5H6v5m5-5V5h2v7h5v5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Zähler
          </h2>
          <p>Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
          <p>Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
        </div>

        {/* Gruppen: Spannung, Strom, Leistung */}
        {['Spannung', 'Strom', 'Leistung'].map(groupLabel => (
          <div key={groupLabel} className="rounded-xl p-4 border border-gray-600 bg-gray-800 col-span-1">
            <h2 className="text-md font-bold mb-2 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {groupLabel}
            </h2>
            {['L1', 'L2', 'L3'].map(phase => {
              const key = Object.keys(values).find(k => k.toLowerCase().includes(groupLabel.toLowerCase()) && k.includes(phase))
              const val = key ? parseFloat(values[key]) : NaN
              const range = key && minMax[key] ? minMax[key] : { min: val, max: val }

              return (
                <div key={phase} className="mb-2">
                  <div className="text-sm">{phase}: {isNaN(val) ? '...' : `${val} ${groupLabel === 'Strom' ? 'A' : groupLabel === 'Leistung' ? 'W' : 'V'}`}</div>
                  {progressBar(val, groupLabel === 'Spannung' ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}</div>
                </div>
              )
            })}
          </div>
        ))}

        {/* Restliche Geräte */}
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Ender 3 Pro', 'Sidewinder X1', 'Poolpumpe', 'Steckdose 1', 'Steckdose 2'].includes(t.label)
        ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          let raw = values[key]
          const value = raw?.toUpperCase()
          const num = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(num)
          const showMinMax = !label.includes('gesamt') &&
            (key.includes('power_L') || key.includes('Verbrauch_aktuell') || key.includes('Balkonkraftwerk'))

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
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}</p>}
                </>
              )}
              {type === 'string' && <p className="text-lg">{raw ?? '...'}</p>}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
