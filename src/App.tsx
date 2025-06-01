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
      setValues((prev) => ({ ...prev, ...messageQueue.current }))
      messageQueue.current = {}
    }
    const interval = setInterval(flush, 300)

    client.on('connect', () => {
      const topicList = topics.map(({ topic }) => topic)
      client.subscribe(topicList)
    })

    client.on('message', (topic, message) => {
      messageQueue.current[topic] = message.toString()
      setLastUpdate(new Date().toLocaleTimeString())
    })

    return () => clearInterval(interval)
  }, [])

  const toggleBoolean = (topic: string, current: string) => {
    const next = current === 'true' ? 'false' : 'true'
    client.publish(topic, next)
  }

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
      <header className="mb-4 text-sm text-gray-500 dark:text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>
      <div className="grid grid-cols-1 xs:grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {topics.map(({ topic, label, type, unit, favorite }) => (
          <div key={topic} className={`bg-gray-100 dark:bg-gray-800 rounded-2xl shadow p-4 border-2 ${favorite ? 'border-yellow-400' : 'border-transparent'}`}>
            <h2 className="text-xl font-semibold mb-2">{label}</h2>
            {type === 'boolean' && (
              <button
                className={`px-4 py-2 rounded-xl text-white ${values[topic] === 'true' ? 'bg-green-500' : 'bg-red-500'}`}
                onClick={() => toggleBoolean(topic, values[topic])}
              >
                {values[topic] === 'true' ? 'AN' : 'AUS'}
              </button>
            )}
            {type === 'number' && (
              <p className="text-3xl">{values[topic] ?? '...'} {unit}</p>
            )}
            {type === 'string' && (
              <p className="text-xl">{values[topic] ?? '...'}</p>
            )}
          </div>
        ))}
      </div>
    </main>
  )
}

export default App
