// src/App.tsx
import { useEffect, useState, useRef, useCallback } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

type MinMax = Record<string, { min: number; max: number }>
const MINMAX_TOPIC = 'dashboard/minmax/update'
const REQUEST_TOPIC = 'dashboard/minmax/request'
const HISTORY_LENGTH = 60

// --- Sparkline Component ---
function Sparkline({ data, color = '#60a5fa', height = 28 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const w = 200
  const h = height
  const pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height, display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <polyline
        points={`${pad},${h - pad} ${points} ${w - pad},${h - pad}`}
        fill={`url(#sg-${color.replace('#', '')})`}
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

// --- Sparkline color helpers ---
function sparkColor(label: string, value: number): string {
  if (label.includes('Verbrauch')) {
    if (value >= 1000) return '#dc2626'
    if (value >= 300) return '#facc15'
    return '#22c55e'
  }
  if (label.includes('Balkon') || label.includes('Erzeugung')) {
    if (value >= 500) return '#22c55e'
    if (value >= 250) return '#facc15'
    return '#ef4444'
  }
  if (label.includes('Pool') || label.includes('Temperatur')) {
    if (value > 23) return '#22c55e'
    if (value > 17) return '#facc15'
    return '#60a5fa'
  }
  if (label.includes('Spannung')) return '#a78bfa'
  if (label.includes('Strom') || label.includes('Strom L')) return '#fb923c'
  if (label.includes('Leistung')) return '#38bdf8'
  return '#60a5fa'
}

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const [history, setHistory] = useState<Record<string, number[]>>({})
  const messageQueue = useRef<Record<string, string>>({})
  const clientRef = useRef<any>(null)

  const pushHistory = useCallback((key: string, num: number) => {
    setHistory(prev => {
      const arr = prev[key] ?? []
      const next = arr.length >= HISTORY_LENGTH ? [...arr.slice(1), num] : [...arr, num]
      return { ...prev, [key]: next }
    })
  }, [])

  useEffect(() => {
    const client = mqtt.connect(mqttConfig.host, {
      username: mqttConfig.username,
      password: mqttConfig.password,
    })
    clientRef.current = client

    client.on('connect', () => {
      client.publish(REQUEST_TOPIC, JSON.stringify({ ts: Date.now() }))
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
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload
        return
      }

      if (topic === MINMAX_TOPIC) {
        try {
          const incoming = JSON.parse(payload)
          setMinMax(incoming)
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

    const flush = () => {
      const updates = { ...messageQueue.current }
      messageQueue.current = {}
      if (Object.keys(updates).length > 0) {
        setValues(prev => {
          const updated = { ...prev, ...updates }
          setLastUpdate(new Date().toLocaleTimeString())
          // Push numeric values into history
          for (const [key, val] of Object.entries(updates)) {
            const n = parseFloat(val)
            if (!isNaN(n)) pushHistory(key, n)
          }
          return updated
        })
      }
    }

    const interval = setInterval(flush, 300)
    return () => {
      clearInterval(interval)
      client.end(true)
    }
  }, [pushHistory])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({
      ...prev,
      [publishTopic.replace('cmnd/', 'stat/').replace('/POWER', '/POWER')]: next
    }))
    clientRef.current?.publish(publishTopic, next)
  }

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

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">

        {/* 3D-Drucker */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🧱 3D-Drucker</h2>
          {['Sidewinder X1'].map((label, i) => {
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
            const hist = history[tempKey] ?? []

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
                {hist.length >= 2 && (
                  <div className="mt-1 opacity-70">
                    <Sparkline data={hist} color={sparkColor('Temperatur', val)} height={28} />
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {/* Zähler */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
          <div className="flex flex-col space-y-2">
            <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.sml_v'] ?? '...'} kWh</p>
            <p>🔋 BKW: {(() => {
              const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
              const raw = values[key]
              const num = parseFloat(raw)
              return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
            })()} kWh</p>
            <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
          </div>
        </div>

        {/* Strom (Verbrauch + Erzeugung) */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3">🔋 Strom</h2>
          {(() => {
            const key = 'tele/Stromzähler/SENSOR.grid.sml_m'
            const raw = values[key]
            const num = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[key] ?? { min: num, max: num }
            const hist = history[key] ?? []
            let color = 'bg-green-500'
            if (num >= 1000) color = 'bg-red-600'
            else if (num >= 300) color = 'bg-yellow-400'
            return (
              <>
                <p className="mt-1">Verbrauch Aktuell: {isNaN(num) ? '...' : `${num} W`}</p>
                {progressBar(num, range.max > 0 ? range.max : 2000, color)}
                <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} W | Max: {range.max?.toFixed(1)} W</p>
                {hist.length >= 2 && (
                  <div className="mt-1 opacity-70">
                    <Sparkline data={hist} color={sparkColor('Verbrauch', num)} height={28} />
                  </div>
                )}
              </>
            )
          })()}
          {(() => {
            const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
            const raw = values[key]
            const num = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[key] ?? { min: num, max: num }
            const hist = history[key] ?? []
            let color = 'bg-red-600'
            if (num >= 500) color = 'bg-green-500'
            else if (num >= 250) color = 'bg-yellow-400'
            return (
              <>
                <p className="mt-3">Erzeugung Aktuell: {isNaN(num) ? '...' : `${num} W`}</p>
                {progressBar(num, range.max > 0 ? range.max : 1000, color)}
                <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} W | Max: {range.max?.toFixed(1)} W</p>
                {hist.length >= 2 && (
                  <div className="mt-1 opacity-70">
                    <Sparkline data={hist} color={sparkColor('Erzeugung', num)} height={28} />
                  </div>
                )}
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

        {/* Steckdosen + Beleuchtung */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen + Beleuchtung</h2>
          {[
            { label: 'Teichpumpe', publishTopic: 'cmnd/Teichpumpe/POWER', statusTopic: 'stat/Teichpumpe/POWER' },
            { label: 'Beleuchtung', publishTopic: 'cmnd/Beleuchtung/POWER', statusTopic: 'stat/Beleuchtung/POWER' },
            { label: 'Carport-Licht', publishTopic: 'cmnd/Carport-Licht/POWER', statusTopic: 'stat/Carport-Licht/POWER' }
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

        {/* Dynamische Topics (type !== 'group', nicht hardcoded) */}
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Sidewinder X1', 'Poolpumpe', 'Steckdose 1', 'Steckdose 2'].includes(t.label)
        ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          let raw = values[key]
          const value = raw?.toUpperCase()
          const num = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(num)
          const showMinMax = !label.includes('gesamt') && (key.includes('sml_L') || key.includes('sml_m') || key.includes('Balkonkraftwerk'))
          const range = minMax[key] ?? { min: num, max: num }
          const barColor = getBarColor(label, num)
          const hist = history[key] ?? []
          return (
            <div key={key} className={`rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800`}>
              <h2 className="text-md font-bold mb-2">{label}</h2>
              {type === 'boolean' && (
                <button className={`px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, value)}>
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}</p>}
                  {hist.length >= 2 && (
                    <div className="mt-2 opacity-70">
                      <Sparkline data={hist} color={sparkColor(label, num)} height={28} />
                    </div>
                  )}
                </>
              )}
              {type === 'string' && <p className="text-lg">{raw ?? '...'}</p>}
            </div>
          )
        })}
      </div>

      {/* Gruppen (Leistung, Spannung, Strom L1–L3) */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <h2 className="text-lg font-bold mb-2">{group.label}</h2>
            {group.keys?.map(({ label, key }) => {
              const raw = values[key]
              const num = raw !== undefined ? parseFloat(raw) : NaN
              const range = minMax[key] ?? { min: num, max: num }
              const hist = history[key] ?? []
              const isSpannung = group.label.includes('Spannung')
              return (
                <div key={key} className="mb-3">
                  <div className="text-sm">{label}: {isNaN(num) ? '...' : `${isSpannung ? num.toFixed(0) : num} ${group.unit}`}</div>
                  {progressBar(num, isSpannung ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-400">
                    Min: {range.min?.toFixed(isSpannung ? 0 : 1)} {group.unit} | Max: {range.max?.toFixed(isSpannung ? 0 : 1)} {group.unit}
                  </div>
                  {hist.length >= 2 && (
                    <div className="mt-1 opacity-60">
                      <Sparkline data={hist} color={sparkColor(group.label, num)} height={24} />
                    </div>
                  )}
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
