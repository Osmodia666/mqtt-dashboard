import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})
client.setMaxListeners(100)

type MinMax = Record<string, {
  min: number,
  minTime: string,
  max: number,
  maxTime: string
}>
const MINMAX_TOPIC = 'dashboard/minmax/update'
const INFLUX_TOPIC = 'influx/data'
const FLUSH_INTERVAL = 10000

// MiniBarGraph component
function MiniBarGraph({ data, height = 24, color = "#60a5fa" }: { data: number[], height?: number, color?: string }) {
  if (!data.length) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${data.length} ${height}`}>
      {data.map((v, i) => (
        <rect
          key={i}
          x={i}
          y={height - ((v - min) / range) * height}
          width="1"
          height={((v - min) / range) * height}
          fill={color}
        />
      ))}
    </svg>
  )
}

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const influxQueue = useRef<Record<string, number>>({})

  // Sparkline histories
  const POOL_HISTORY_LEN = 30
  const VERBRAUCH_HISTORY_LEN = 30
  const ERZEUGUNG_HISTORY_LEN = 30
  const [poolTempHistory, setPoolTempHistory] = useState<number[]>([])
  const [verbrauchHistory, setVerbrauchHistory] = useState<number[]>([])
  const [erzeugungHistory, setErzeugungHistory] = useState<number[]>([])

  function updateMinMax(key: string, val: string) {
    const num = parseFloat(val)
    if (
      !isNaN(num) &&
      (
        key.includes('power_L') ||
        key.includes('Verbrauch_aktuell') ||
        key === 'Pool_temp/temperatur' ||
        key.includes('Balkonkraftwerk') ||
        key.includes('Voltage') ||
        key.includes('Strom_L')
      )
    ) {
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      setMinMax(prev => {
        const current = prev[key]
        if (!current) {
          return { ...prev, [key]: { min: num, minTime: now, max: num, maxTime: now } }
        }
        let updated = false
        let min = current.min
        let minTime = current.minTime
        let max = current.max
        let maxTime = current.maxTime
        if (num < min) {
          min = num
          minTime = now
          updated = true
        }
        if (num > max) {
          max = num
          maxTime = now
          updated = true
        }
        if (updated) {
          return { ...prev, [key]: { min, minTime, max, maxTime } }
        }
        return prev
      })
    }
  }

  useEffect(() => {
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

      // 1. Pool Temperatur
      if (topic === 'Pool_temp/temperatur') {
        const num = parseFloat(payload)
        if (!isNaN(num)) {
          setPoolTempHistory(prev => [...prev.slice(-POOL_HISTORY_LEN + 1), num])
        }
      }
      // 2. Verbrauch aktuell (find in flattened payloads below)
      // 3. Erzeugung aktuell (power_L1 from Balkonkraftwerk, see below)

      // Update these two topics immediately
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        setValues(prev => {
          const merged = { ...prev, [topic]: payload }
          setLastUpdate(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
          return merged
        })
        updateMinMax(topic, payload)
        const num = parseFloat(payload)
        if (!isNaN(num)) {
          influxQueue.current[topic] = num
        }
        return
      }

      if (topic === MINMAX_TOPIC) {
        try {
          const incoming = JSON.parse(payload)
          setMinMax(prev => {
            const merged: MinMax = { ...prev }
            for (const key in incoming) {
              if (typeof incoming[key] === 'object' && incoming[key] !== null) {
                const inc = incoming[key]
                const prevTimes = prev[key] || { minTime: '', maxTime: '' }
                merged[key] = {
                  min: inc.min,
                  minTime: inc.minTime || prevTimes.minTime || '',
                  max: inc.max,
                  maxTime: inc.maxTime || prevTimes.maxTime || ''
                }
              }
            }
            return merged
          })
        } catch (err) {
          console.error('[MQTT] Fehler beim MinMax-Update:', err)
        }
        return
      }

      // Flatten JSON MQTT payloads
      let updates: Record<string, string> = {}
      try {
        const json = JSON.parse(payload)
        const flatten = (obj: any, prefix = ''): Record<string, string> => {
          return Object.entries(obj).reduce((acc, [key, val]) => {
            const newKey = prefix ? `${prefix}.${key}` : key
            if (typeof val === 'object' && val !== null) {
              Object.assign(acc, flatten(val, newKey))
            } else {
              acc[newKey] = String(val)
            }
            return acc
          }, {})
        }
        const flat = flatten(json)
        for (const [key, val] of Object.entries(flat)) {
          const combinedKey = `${topic}.${key}`
          updates[combinedKey] = val
        }
      } catch (e) {
        updates[topic] = payload
      }

      // For Verbrauch aktuell and Erzeugung aktuell in JSON payloads
      Object.entries(updates).forEach(([key, val]) => {
        if (key.includes('Verbrauch_aktuell')) {
          const num = parseFloat(val)
          if (!isNaN(num)) {
            setVerbrauchHistory(prev => [...prev.slice(-VERBRAUCH_HISTORY_LEN + 1), num])
          }
        }
        if (key.includes('Balkonkraftwerk') && key.includes('power_L1')) {
          const num = parseFloat(val)
          if (!isNaN(num)) {
            setErzeugungHistory(prev => [...prev.slice(-ERZEUGUNG_HISTORY_LEN + 1), num])
          }
        }
      })

      setValues(prev => {
        const merged = { ...prev, ...updates }
        setLastUpdate(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
        return merged
      })

      Object.entries(updates).forEach(([key, val]) => {
        updateMinMax(key, val)
      })

      for (const [key, val] of Object.entries(updates)) {
        const num = parseFloat(val)
        if (!isNaN(num)) {
          influxQueue.current[key] = num
        }
      }
    })

    const influxInterval = setInterval(() => {
      const influxPayload = { ...influxQueue.current }
      influxQueue.current = {}
      if (Object.keys(influxPayload).length > 0) {
        client.publish(INFLUX_TOPIC, JSON.stringify(influxPayload))
      }
    }, FLUSH_INTERVAL)

    return () => {
      clearInterval(influxInterval)
    }
  }, [])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
    if (label.includes('Balkonkraftwerk')) return value > 450 ? 'bg-green-500' : value > 150 ? 'bg-yellow-400' : 'bg-red-600'
    if (label.includes('Pool Temperatur')) {
      if (value > 25) return 'bg-red-600'
      if (value > 23) return 'bg-green-500'
      if (value > 17) return 'bg-yellow-400'
      return 'bg-blue-500'
    }
    return 'bg-blue-500'
  }

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  const getRange = (key: string, value: number) => (
    minMax[key] ?? { min: value, minTime: '', max: value, maxTime: '' }
  )

  // --- Main render ---
  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {/* Pool Card */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🏊 Pool</h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const raw = values[tempKey]
            const val = raw !== undefined ? parseFloat(raw) : NaN
            const range = getRange(tempKey, val)

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
                <p className="text-xs text-gray-400">
                  Min: {range.min?.toFixed(1)} °C {range.minTime ? `(${range.minTime})` : ''}
                  {' | '}
                  Max: {range.max?.toFixed(1)} °C {range.maxTime ? `(${range.maxTime})` : ''}
                </p>
                <div className="mt-1">
                  <MiniBarGraph data={poolTempHistory} color="#fbbf24" height={24} />
                </div>
              </>
            )
          })()}
        </div>

        {/* Zähler Card (Verbrauch aktuell sparkline under Strom) */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
          <div className="flex flex-col space-y-3">
            <div>
              <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
              {/* Verbrauch aktuell (find key and min/max/sparkline) */}
              {(() => {
                const verbrauchKey = Object.keys(values).find(k => k.includes('Verbrauch_aktuell'))
                if (!verbrauchKey) return null
                const num = parseFloat(values[verbrauchKey])
                const range = getRange(verbrauchKey, num)
                return (
                  <>
                    <p className="text-xs text-gray-400">
                      Min: {range.min?.toFixed(0)} W {range.minTime ? `(${range.minTime})` : ''}
                      {' | '}
                      Max: {range.max?.toFixed(0)} W {range.maxTime ? `(${range.maxTime})` : ''}
                    </p>
                    <div className="mt-1">
                      <MiniBarGraph data={verbrauchHistory} color="#38bdf8" height={24} />
                    </div>
                  </>
                )
              })()}
            </div>
            <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
          </div>
        </div>

        {/* Erzeugung Card (sparkline under "Gesamt" row) */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3">🔋 Erzeugung</h2>
          <p>Gesamt: {(() => {
            const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
            const raw = values[key]
            const num = parseFloat(raw)
            return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
          })()} kWh</p>
          {/* Erzeugung aktuell (find L1 power key and min/max/sparkline) */}
          {(() => {
            const erzeugungKey = Object.keys(values).find(
              k => k.includes('Balkonkraftwerk') && k.includes('power_L1')
            )
            if (!erzeugungKey) return null
            const num = parseFloat(values[erzeugungKey])
            const range = getRange(erzeugungKey, num)
            return (
              <>
                <p className="text-xs text-gray-400">
                  Min: {range.min?.toFixed(0)} W {range.minTime ? `(${range.minTime})` : ''}
                  {' | '}
                  Max: {range.max?.toFixed(0)} W {range.maxTime ? `(${range.maxTime})` : ''}
                </p>
                <div className="mt-1">
                  <MiniBarGraph data={erzeugungHistory} color="#34d399" height={24} />
                </div>
              </>
            )
          })()}
        </div>

        {/* ...rest of your cards as before... */}
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
          const range = getRange(key, num)
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
                  {showMinMax && (
                    <p className="text-xs text-gray-400">
                      Min: {range.min?.toFixed(1)} {unit} {range.minTime ? `(${range.minTime})` : ''}
                      {' | '}
                      Max: {range.max?.toFixed(1)} {unit} {range.maxTime ? `(${range.maxTime})` : ''}
                    </p>
                  )}
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
              const range = getRange(key, num)
              return (
                <div key={key} className="mb-2">
                  <div className="text-sm">{label}: {isNaN(num) ? '...' : `${num} ${group.unit}`}</div>
                  {progressBar(num, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-400">
                    Min: {range.min?.toFixed(1)} {group.unit} {range.minTime ? `(${range.minTime})` : ''}
                    {' | '}
                    Max: {range.max?.toFixed(1)} {group.unit} {range.maxTime ? `(${range.maxTime})` : ''}
                  </div>
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
