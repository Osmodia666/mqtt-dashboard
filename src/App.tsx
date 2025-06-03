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
      console.log('✅ MQTT verbunden')

      const allStatusTopics = topics
        .map((t) => 'statusTopic' in t ? t.statusTopic : t.topic)
        .filter(Boolean)

      client.subscribe(allStatusTopics, (err) => {
        if (err) console.error('❌ Subscribe error:', err)
        else console.log('📡 Subscribed to topics:', allStatusTopics)
      })
    })

    client.on('reconnect', () => {
      console.log('🔁 Reconnecting...')
    })

    client.on('error', (err) => {
      console.error('❌ MQTT Fehler:', err)
    })

    client.on('message', (topic, message) => {
      messageQueue.current[topic] = message.toString()
      console.log('📨 Message:', topic, message.toString())
    })

    return () => clearInterval(interval)
  }, [])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current === 'true' ? 'false' : 'true'
    console.log('⚡ publish', publishTopic, '→', next)
    client.publish(publishTopic, next, (err) => {
      if (err) console.error('❌ Publish-Fehler:', err)
    })
  }

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
      <header className="mb-4 text-sm text-gray-500 dark:text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>
      <div className="grid grid-cols-1 xs:grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {topics.map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const currentValue = values[key]

          return (
            <div key={key} className={`bg-gray-100 dark:bg-gray-800 rounded-2xl shadow p-4 border-2 ${favorite ? 'border-yellow-400' : 'border-transparent'}`}>
              <h2 className="text-xl font-semibold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${currentValue === 'true' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, currentValue)}
                >
                  {currentValue === 'true' ? 'AN' : 'AUS'}
                </button>
              )}

              {type === 'number' && (
                <p className="text-3xl">{currentValue ?? '...'} {unit}</p>
              )}

              {type === 'string' && (
                <p className="text-xl">{currentValue ?? '...'}</p>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
