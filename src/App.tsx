// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})

type MinMax = Record<string, { min: number; max: number }>

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const messageQueue = useRef<Record<string, string>>({})

  useEffect(() => {
    const flush = () => {
      const updates = { ...messageQueue.current }
      messageQueue.current = {}
      if (Object.keys(updates).length > 0) {
        setValues(prev => {
          const updated = { ...prev, ...updates }

          const newMinMax: MinMax = { ...minMax }
          for (const [key, val] of Object.entries(updates)) {
            const num = parseFloat(val)
            if (!isNaN(num)) {
              const existing = newMinMax[key] ?? { min: num, max: num }
              newMinMax[key] = {
                min: Math.min(existing.min, num),
                max: Math.max(existing.max, num),
              }
            }
          }

          setMinMax(newMinMax)
          return updated
        })
        setLastUpdate(new Date().toLocaleTimeString())
      }
    }

    const interval = setInterval(flush, 300)

    client.on('connect', () => {
      console.log('✅ MQTT verbunden!')
      client.subscribe('#', err => {
        if (err) console.error('❌ Subscribe error:', err)
        else console.log('📡 Subscribed to all topics')
      })
    })

    client.on('reconnect', () => console.log('🔁 Reconnecting...'))
    client.on('error', err => console.error('❌ MQTT Fehler:', err))

    client.on('message', (topic, message) => {
      const payload = message.toString()
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
    <div className="w-full bg-gray-300 rounded-full h-2.5 mt-2">
      <div
        className={`${color} h-2.5 rounded-full transition-all`}
        style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
      />
    </div>
  )

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
      {/* Verbindungsanzeige */}
      <div className="fixed top-2 right-2 w-3 h-3 rounded-full" title={client.connected ? 'MQTT verbunden' : 'Getrennt'} style={{ background: client.connected ? 'green' : 'red' }} />

      <header className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Letztes Update: {lastUpdate || 'Lade...'}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {topics.map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const raw = values[key]
          const value = raw?.toUpperCase()
          const num = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(num)
          const range = minMax[key] ?? { min: num, max: num }

          let bgColor = ''
          if (label.includes('Verbrauch')) bgColor = 'bg-yellow-100 dark:bg-yellow-900'
          if (label.includes('Balkonkraftwerk')) bgColor = 'bg-green-100 dark:bg-green-900'

          return (
            <div
              key={key}
              className={`rounded-2xl shadow p-4 border-2 ${bgColor} ${
                favorite ? 'border-yellow-400' : 'border-gray-700'
              }`}
            >
              <h2 className="text-xl font-semibold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${
                    value === 'ON' ? 'bg-green-500' : 'bg-red-500'
                  }`}
                  onClick={() => toggleBoolean(publishTopic ?? key, value)}
                >
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}

              {isNumber && (
                <>
                  <p className="text-3xl">{raw ?? '...'} {unit}</p>
                  {progressBar(num, range.max > 0 ? range.max : 100)}
                  <div className="text-xs mt-1 text-gray-500 dark:text-gray-400">
                    Min: {range.min?.toFixed(1)} {unit} | Max: {range.max?.toFixed(1)} {unit}
                  </div>
                </>
              )}

              {type === 'string' && (
                <p className="text-xl">{value ?? '...'}</p>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
