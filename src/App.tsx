// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const messageQueue = useRef<Record<string, string>>({})

  useEffect(() => {
    const flush = () => {
      const updates = { ...messageQueue.current }
      messageQueue.current = {}
      if (Object.keys(updates).length > 0) {
        setValues((prev) => ({ ...prev, ...updates }))
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

      // 🔎 Sonderbehandlung für einfache Werte
      if (topic === 'Gaszaehler/stand' || topic === 'Pool_temp/temperatur') {
        messageQueue.current[topic] = payload
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
  }, [])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const renderBar = (val: string, max: number = 100) => {
    const num = parseFloat(val)
    const pct = Math.min(100, (num / max) * 100)
    return (
      <div className="w-full h-2 bg-gray-300 rounded">
        <div className="h-2 bg-blue-500 rounded" style={{ width: `${pct}%` }} />
      </div>
    )
  }

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white relative">
      {/* MQTT Status */}
      <div className="absolute top-2 right-4">
        <div
          className={`w-3 h-3 rounded-full ${client.connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={client.connected ? 'MQTT verbunden' : 'MQTT getrennt'}
        />
      </div>

      <header className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Letztes Update: {lastUpdate || 'Lade...'}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {topics.map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const raw = values[key]
          const val = raw?.toUpperCase()

          const highlightClass =
            label.includes('Verbrauch aktuell') ? 'bg-yellow-100 dark:bg-yellow-900' :
            label.includes('Balkonkraftwerk') ? 'bg-green-100 dark:bg-green-900' :
            'bg-gray-100 dark:bg-gray-800'

          return (
            <div key={key} className={`${highlightClass} rounded-2xl shadow p-4 border-2 ${favorite ? 'border-yellow-400' : 'border-transparent'}`}>
              <h2 className="text-xl font-semibold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, val)}
                >
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}

              {type === 'number' && (
                <>
                  <p className="text-3xl">{raw ?? '...'} {unit}</p>
                  {unit === '°C' && raw && renderBar(raw, 40)}
                  {unit === 'W' && raw && renderBar(raw, 3000)}
                </>
              )}

              {type === 'string' && (
                <p className="text-xl">{raw ?? '...'}</p>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
