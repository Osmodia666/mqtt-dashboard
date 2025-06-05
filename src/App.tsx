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
        console.log('🧠 flush', updates)
        setValues((prev) => ({ ...prev, ...updates }))
        setLastUpdate(new Date().toLocaleTimeString())
      }
    }

    const interval = setInterval(flush, 300)

    client.on('connect', () => {
      console.log('✅ MQTT verbunden!')
      const allTopics = topics.map(t => t.statusTopic ?? t.topic).filter(Boolean)
      client.subscribe(allTopics, err => {
        if (err) console.error('❌ Subscribe error:', err)
        else console.log('📡 Subscribed to topics:', allTopics)
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

        console.log('📨 JSON:', topic, flat)
      } catch {
        messageQueue.current[topic] = payload
        console.log('📨 Text:', topic, payload)
      }
    })

    return () => clearInterval(interval)
  }, [])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    console.log('⚡ publish', publishTopic, '→', next)
    client.publish(publishTopic, next, err => {
      if (err) console.error('❌ Publish-Fehler:', err)
    })
  }

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
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
          const value = values[key]?.toUpperCase()

          return (
            <div key={key} className={`bg-gray-100 dark:bg-gray-800 rounded-2xl shadow p-4 border-2 ${favorite ? 'border-yellow-400' : 'border-transparent'}`}>
              <h2 className="text-xl font-semibold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, value)}
                >
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}

              {type === 'number' && (
                <p className="text-3xl">{values[key] ?? '...'} {unit}</p>
              )}

              {type === 'string' && (
                <p className="text-xl">{values[key] ?? '...'}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-8">
        <h3 className="text-lg font-bold mb-2">🔎 Letzte MQTT-Werte</h3>
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-xl text-sm max-h-64 overflow-y-auto">
          {Object.entries(values).slice(-10).reverse().map(([topic, value]) => (
            <div key={topic}>
              <span className="font-mono text-blue-600 dark:text-blue-400">{topic}</span>: <span className="font-mono">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

export default App
