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
      console.log('✅ MQTT verbunden')
      const allTopics = topics.map(t => t.statusTopic ?? t.topic).filter(Boolean)
      client.subscribe(allTopics, (err) => {
        if (err) console.error('❌ Subscribe error:', err)
        else console.log('📡 Subscribed to:', allTopics)
      })
    })

    client.on('error', err => console.error('❌ MQTT Fehler:', err))
    client.on('reconnect', () => console.log('🔁 Reconnecting...'))

    client.on('message', (topic, message) => {
      const payload = message.toString()

      try {
        const json = JSON.parse(payload)
        const flatten = (obj: any, prefix = ''): Record<string, string> =>
          Object.entries(obj).reduce((acc, [k, v]) => {
            const key = prefix ? `${prefix}.${k}` : k
            if (v && typeof v === 'object') {
              Object.assign(acc, flatten(v, key))
            } else {
              acc[key] = String(v)
            }
            return acc
          }, {})

        const flat = flatten(json)
        for (const [k, v] of Object.entries(flat)) {
          const combined = `${topic}.${k}`
          messageQueue.current[combined] = v
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
    </main>
  )
}

export default App
