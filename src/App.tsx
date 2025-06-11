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
          const nextMinMax = { ...minMax }

          for (const [key, val] of Object.entries(updates)) {
            const num = parseFloat(val)
            if (!isNaN(num) &&
              (key.includes('power_L') || key.includes('Verbrauch_aktuell') ||
              key === 'Pool_temp/temperatur' || key.includes('Balkonkraftwerk') ||
              key.includes('Voltage') || key.includes('Strom_L'))) {
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

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-500 ease-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )

  const Icon = ({ name }: { name: string }) => {
    const icons: Record<string, string> = {
      pool: '🏊', plug: '🔌', bolt: '⚡', light: '💡',
      gas: '🔥', temp: '🌡️', printer: '🖨️', meter: '📟',
    }
    return <span className="text-xl mr-2">{icons[name] ?? '🔧'}</span>
  }

  return (
    <main className="min-h-screen p-4 bg-gray-950 text-white font-sans">
      <header className="mb-4 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>

      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {/* Kachel: 3D-Drucker */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="font-bold text-md mb-2 flex items-center"><Icon name="printer" />3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map(label => {
            const entry = topics.find(t => t.label === label)
            if (!entry) return null
            const val = values[entry.statusTopic ?? entry.topic]?.toUpperCase()
            return (
              <div key={label} className="flex justify-between items-center">
                <span>{label}</span>
                <button className={`px-3 py-1 text-sm rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(entry.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Kachel: Steckdose 1 & 2 */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="font-bold text-md mb-2 flex items-center"><Icon name="plug" />Steckdosen</h2>
          {['Steckdose 1', 'Steckdose 2'].map(label => {
            const entry = topics.find(t => t.label === label)
            if (!entry) return null
            const val = values[entry.statusTopic ?? entry.topic]?.toUpperCase()
            return (
              <div key={label} className="flex justify-between items-center">
                <span>{label}</span>
                <button className={`px-3 py-1 text-sm rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(entry.publishTopic!, val)}>
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Kachel: Strom- & Gaszähler */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="font-bold text-md mb-2 flex items-center"><Icon name="meter" />Zähler</h2>
          <p>Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
          <p>Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
        </div>

        {/* Kachel: Pool */}
        <div className="col-span-1 rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="font-bold text-md mb-2 flex items-center"><Icon name="pool" />Pool</h2>
          {(() => {
            const pump = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const raw = values[tempKey]
            const num = parseFloat(raw)
            const val = isNaN(num) ? '...' : `${num} °C`
            const range = minMax[tempKey] ?? { min: num, max: num }
            return (
              <>
                <div className="flex justify-between items-center">
                  <span>Pumpe</span>
                  {pump && (
                    <button className={`px-3 py-1 text-sm rounded text-white ${values[pump.topic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(pump.publishTopic!, values[pump.topic])}>
                      {values[pump.topic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <p className="mt-2">Temperatur: {val}</p>
                {progressBar(num, 40, 'bg-blue-400')}
                <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} | Max: {range.max.toFixed(1)} °C</p>
              </>
            )
          })()}
        </div>

        {/* Normale Kacheln */}
        {topics
          .filter(t => t.type !== 'group' && !['Poolpumpe', 'Ender 3 Pro', 'Sidewinder X1', 'Steckdose 1', 'Steckdose 2', 'Stromzähler Stand', 'Gaszähler Stand:'].includes(t.label))
          .map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
            const key = statusTopic ?? topic
            const raw = values[key]
            const value = raw?.toUpperCase()
            const num = parseFloat(raw)
            const isNumber = type === 'number' && !isNaN(num)
            const showMinMax = !label.includes('gesamt') && (key.includes('power_L') || key.includes('Verbrauch_aktuell') || key === 'Pool_temp/temperatur' || key.includes('Balkonkraftwerk'))
            const range = minMax[key] ?? { min: num, max: num }

            return (
              <div key={key} className={`rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800`}>
                <h2 className="font-bold text-md mb-2">{label}</h2>
                {type === 'boolean' && (
                  <button className={`px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`} onClick={() => toggleBoolean(publishTopic ?? key, value)}>
                    {value === 'ON' ? 'AN' : 'AUS'}
                  </button>
                )}
                {isNumber && (
                  <>
                    <p className="text-2xl">{raw ?? '...'} {unit}</p>
                    {progressBar(num, range.max > 0 ? range.max : 100, 'bg-blue-500')}
                    <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} | Max: {range.max.toFixed(1)} {unit}</p>
                  </>
                )}
              </div>
            )
          })}
      </div>

      {/* Gruppenanzeige: Spannung, Strom, Leistung */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <h2 className="font-semibold text-md mb-2">{group.label}</h2>
            {group.keys?.map(({ label: phase, key }) => {
              const val = parseFloat(values[key])
              const range = minMax[key] ?? { min: val, max: val }
              return (
                <div key={key}>
                  <p className="text-sm">{phase}: {isNaN(val) ? '...' : `${val} ${group.unit}`}</p>
                  {progressBar(val, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <p className="text-xs text-gray-400">Min: {range.min.toFixed(1)} | Max: {range.max.toFixed(1)}</p>
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
