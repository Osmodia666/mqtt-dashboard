// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'
import { FiCpu, FiDroplet, FiThermometer, FiZap, FiActivity, FiBox } from 'react-icons/fi'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})
client.setMaxListeners(100)

const STORAGE_KEY = 'global_minmax_store'
const LAST_RESET_KEY = 'global_minmax_store_reset'
const MINMAX_TOPIC = 'dashboard/minmax/update'

type MinMax = Record<string, { min: number; max: number }>

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
        if (publishTopic?.includes('/POWER')) {
          client.publish(publishTopic, '')
        }
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

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
    if (label.includes('Balkonkraftwerk')) return value > 450 ? 'bg-green-500' : value > 150 ? 'bg-yellow-400' : 'bg-red-600'
    if (label.includes('Pool Temperatur')) return value > 23 ? 'bg-green-500' : value > 17 ? 'bg-yellow-400' : 'bg-blue-500'
    return 'bg-blue-500'
  }

  const IconTitle = ({ icon, title }: { icon: JSX.Element, title: string }) => (
    <h2 className="text-md font-bold flex items-center gap-2 mb-2">{icon}{title}</h2>
  )

  return (
    <main className="min-h-screen p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid xl:grid-cols-6 md:grid-cols-3 sm:grid-cols-2 gap-4">
        {/* 3D Drucker */}
        <div className="rounded-xl p-4 border border-yellow-500 bg-gray-800 col-span-1">
          <IconTitle icon={<FiCpu />} title="3D-Drucker" />
          {['Ender 3 Pro', 'Sidewinder X1'].map(name => {
            const dev = topics.find(t => t.label.includes(name))
            const val = values[dev?.statusTopic ?? '']
            return (
              <div key={name} className="flex justify-between mb-2">
                <span>{name}</span>
                <button onClick={() => toggleBoolean(dev?.publishTopic ?? '', val)} className={`px-3 py-1 rounded ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'} text-white text-sm`}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Pool */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800 col-span-1">
          <IconTitle icon={<FiDroplet />} title="Pool" />
          <div className="flex justify-between mb-2">
            <span>Pumpe</span>
            <button onClick={() => {
              const topic = topics.find(t => t.label === 'Poolpumpe')
              const val = values[topic?.statusTopic ?? '']
              toggleBoolean(topic?.publishTopic ?? '', val)
            }} className={`px-3 py-1 rounded ${values['stat/Poolpumpe/POWER'] === 'ON' ? 'bg-green-500' : 'bg-red-500'} text-white text-sm`}>
              {values['stat/Poolpumpe/POWER'] === 'ON' ? 'AN' : 'AUS'}
            </button>
          </div>
          <div className="text-sm">Temperatur: {values['Pool_temp/temperatur'] ?? '...'} °C</div>
          {progressBar(parseFloat(values['Pool_temp/temperatur']) || 0, 30, 'bg-blue-500')}
          <div className="text-xs text-gray-400">
            Min: {minMax['Pool_temp/temperatur']?.min?.toFixed(1) ?? '-'} °C | Max: {minMax['Pool_temp/temperatur']?.max?.toFixed(1) ?? '-'} °C
          </div>
        </div>

        {/* Zähler */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800 col-span-1">
          <IconTitle icon={<FiZap />} title="Zähler" />
          <p>Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
          <p>Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
        </div>

        {/* Weitere Einzelkacheln */}
        {topics
          .filter(t =>
            !['Ender 3 Pro', 'Sidewinder X1', 'Poolpumpe', 'Pool Temperatur:', 'Gaszähler Stand:', 'Stromzähler Stand:'].includes(t.label)
            && t.type !== 'group'
          )
          .map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
            const key = statusTopic ?? topic
            let raw = values[key]
            const value = raw?.toUpperCase()
            const num = parseFloat(raw)
            const isNumber = type === 'number' && !isNaN(num)
            if (label.includes('Erzeugung [gesamt]')) raw = (num + 178.779).toFixed(3)

            const showMinMax = (!label.includes('gesamt') && (key.includes('power_L') || key.includes('Verbrauch_aktuell') || key === 'Pool_temp/temperatur' || key.includes('Balkonkraftwerk')))
            const range = minMax[key] ?? { min: num, max: num }
            const barColor = getBarColor(label, num)

            return (
              <div key={key} className="rounded-xl p-4 border border-gray-600 bg-gray-800 col-span-1">
                <IconTitle icon={<FiActivity />} title={label} />
                {type === 'boolean' && (
                  <button onClick={() => toggleBoolean(publishTopic ?? key, value)} className={`px-3 py-1 rounded ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'} text-white text-sm`}>
                    {value === 'ON' ? 'AN' : 'AUS'}
                  </button>
                )}
                {isNumber && (
                  <>
                    <p className="text-2xl">{raw ?? '...'} {unit}</p>
                    {showMinMax && progressBar(num, range.max || 100, barColor)}
                    {showMinMax && (
                      <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} {unit} | Max: {range.max?.toFixed(1)} {unit}</p>
                    )}
                  </>
                )}
                {type === 'string' && <p className="text-xl">{raw ?? '...'}</p>}
              </div>
            )
          })}
      </div>

      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <IconTitle icon={<FiBox />} title={group.label} />
            {group.keys?.map(({ label: phaseLabel, key }) => {
              const rawVal = values[key]
              const val = rawVal !== undefined ? parseFloat(rawVal) : NaN
              const range = minMax[key] ?? { min: val, max: val }
              return (
                <div key={key} className="mb-2">
                  <div className="text-sm">{phaseLabel}: {isNaN(val) ? '...' : `${val} ${group.unit}`}</div>
                  {progressBar(val, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <p className="text-xs text-gray-400">Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}</p>
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