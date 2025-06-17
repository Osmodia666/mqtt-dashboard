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

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const influxQueue = useRef<Record<string, number>>({})

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
    if (label.includes('Aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
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
    <div className="w-full bg-gray-700 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 rounded-full transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  const getRange = (key: string, value: number) => (
    minMax[key] ?? { min: value, minTime: '', max: value, maxTime: '' }
  )

  const cardBase = "rounded-2xl p-6 border border-gray-700 bg-[#232a36] shadow-lg flex flex-col gap-3 min-h-[180px]"

  // All steckdosen for merging: Steckdose 1/2, Doppelsteckdose
  const steckdosenLabels = ['Steckdose 1', 'Steckdose 2', 'Doppelsteckdose']

  return (
    <main className="min-h-screen p-4 sm:p-8 bg-[#171c23] text-white font-sans">
      <header className="mb-8 text-sm text-gray-400 font-semibold tracking-wide">
        Letztes Update: {lastUpdate || 'Lade...'}
      </header>
      <div
        className="grid gap-6"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
        }}
      >
        {/* 3D-Drucker */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🧱 3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-2' : 'mt-0'}`}>
                <span className="tracking-tight">{label}</span>
                <button className={`px-5 py-1 rounded-2xl font-bold shadow-sm text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Pool */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🏊 Pool</h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const raw = values[tempKey]
            const val = raw !== undefined ? parseFloat(raw) : NaN
            const range = getRange(tempKey, val)

            return (
              <>
                <div className="flex justify-between items-center">
                  <span className="tracking-tight">Pumpe</span>
                  {pumpe && (
                    <button className={`px-5 py-1 rounded-2xl font-bold shadow-sm text-white ${values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                      onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.statusTopic])}>
                      {values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <p className="mt-2 flex items-center gap-1 text-base font-semibold">
                  <span className="text-2xl">🌡️</span>
                  Temperatur: <span className={val > 25 ? "text-red-400 font-bold" : ""}>{isNaN(val) ? '...' : `${val} °C`}</span>
                </p>
                {progressBar(val, 40, getBarColor('Pool Temperatur', val))}
                <p className="text-xs text-gray-300 font-mono tracking-tighter">
                  Min: {range.min?.toFixed(1)} °C {range.minTime ? `(${range.minTime})` : ''}
                  {' | '}
                  Max: {range.max?.toFixed(1)} °C {range.maxTime ? `(${range.maxTime})` : ''}
                </p>
              </>
            )
          })()}
        </div>

        {/* Zähler */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🧮 Zähler</h2>
          <div className="space-y-2 text-base">
            <div className="flex items-center gap-2">
              <span className="text-xl">⚡</span>
              <span>Strom: <span className="font-bold">{values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</span></span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🔥</span>
              <span>Gas: <span className="font-bold">{values['Gaszaehler/stand'] ?? '...'} m³</span></span>
            </div>
            {/* Balkonkraftwerk Gesamt moved here */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xl">🔋</span>
              <span>Balkonkraftwerk Gesamt: <span className="font-bold">
                {(() => {
                  const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
                  const raw = values[key]
                  const num = parseFloat(raw)
                  return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
                })()} kWh
              </span></span>
            </div>
          </div>
        </div>

        {/* Balkonkraftwerk Erzeugung (detailed card) */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🔋 Str</h2>
          <div>
            <span className="font-semibold">Erzeugung: </span>
            {(() => {
              const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
              const raw = values[key]
              const num = parseFloat(raw)
              return !isNaN(num) ? `${num} W` : '...'
            })()}
          </div>
          {(() => {
            const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
            const num = parseFloat(values[key])
            const range = getRange(key, num)
            const barColor = getBarColor('Balkonkraftwerk', num)
            return (
              <>
                {progressBar(num, range.max > 0 ? range.max : 1000, barColor)}
                <p className="text-xs text-gray-300 font-mono tracking-tighter">
                  Min: {range.min?.toFixed(1)} W {range.minTime ? `(${range.minTime})` : ''}
                  {' | '}
                  Max: {range.max?.toFixed(1)} W {range.maxTime ? `(${range.maxTime})` : ''}
                </p>
              </>
            )
          })()}
        </div>

        {/* Steckdosen - merged */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🔌 Steckdosen</h2>
          {topics
            .filter(t => steckdosenLabels.includes(t.label))
            .map((topic, i) => {
              const val = values[topic.statusTopic]?.toUpperCase()
              return (
                <div key={topic.label} className={`flex justify-between items-center ${i > 0 ? 'mt-2' : 'mt-0'}`}>
                  <span className="tracking-tight">{topic.label}</span>
                  <button
                    className={`px-5 py-1 rounded-2xl font-bold shadow-sm text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                    onClick={() => toggleBoolean(topic.publishTopic!, val)}
                  >
                    {val === 'ON' ? 'AN' : 'AUS'}
                  </button>
                </div>
              )
            })}
        </div>

        {/* Schalter (Beleuchtung + Teichpumpe) */}
        <div className={cardBase}>
          <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">🎛️ Schalter</h2>
          {['Beleuchtung', 'Teichpumpe'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className="flex justify-between items-center mt-2">
                <span className="tracking-tight">{label}</span>
                <button
                  className={`px-5 py-1 rounded-2xl font-bold shadow-sm text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}
                >
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Additional cards - FILTERED so "Balkonkraftwerk Erzeugung" and "Balkonkraftwerk" are removed */}
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Ender 3 Pro', 'Sidewinder X1', 'Poolpumpe', ...steckdosenLabels, 'Beleuchtung', 'Teichpumpe', 'Balkonkraftwerk Erzeugung', 'Balkonkraftwerk'].includes(t.label)
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
            <div key={key} className={`${cardBase} ${favorite ? 'border-yellow-400' : 'border-gray-700'}`}>
              <h2 className="text-md font-bold mb-1">{label}</h2>
              {type === 'boolean' && (
                <button className={`px-5 py-1 rounded-2xl font-bold shadow-sm text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(publishTopic ?? key, value)}>
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl font-semibold">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && (
                    <p className="text-xs text-gray-300 font-mono tracking-tighter">
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

      {/* Grouped cards */}
      <div className="mt-10 grid gap-6"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        }}
      >
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className={cardBase}>
            <h2 className="text-lg font-bold mb-2">{group.label}</h2>
            {group.keys?.map(({ label, key }) => {
              const raw = values[key]
              const num = raw !== undefined ? parseFloat(raw) : NaN
              const range = getRange(key, num)
              return (
                <div key={key} className="mb-2">
                  <div className="text-sm font-semibold">{label}: <span className="font-mono">{isNaN(num) ? '...' : `${num} ${group.unit}`}</span></div>
                  {progressBar(num, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-300 font-mono">
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
