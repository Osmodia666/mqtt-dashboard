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
          const nextMinMax: MinMax = { ...minMax }

          for (const [key, val] of Object.entries(updates)) {
            const num = parseFloat(val)
            if (!isNaN(num) && (
              key.includes('power_L') ||
              key.includes('Verbrauch_aktuell') ||
              key === 'Pool_temp/temperatur')
            ) {
              const current = nextMinMax[key] ?? { min: num, max: num }
              nextMinMax[key] = {
                min: Math.min(current.min, num),
                max: Math.max(current.max, num),
              }
            }
          }

          setMinMax(nextMinMax)
          return updated
        })
        setLastUpdate(new Date().toLocaleTimeString())
      }
    }

    const interval = setInterval(flush, 300)

    client.on('connect', () => {
      console.log('✅ MQTT verbunden!')
      const allTopics = topics.map(t => t.statusTopic || t.topic).filter(Boolean)
      client.subscribe(allTopics, err => {
        if (err) console.error('❌ Subscribe error:', err)
        else console.log('📡 Subscribed to:', allTopics)
      })
      client.subscribe('#')

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

    client.on('reconnect', () => console.log('🔁 Reconnecting...'))
    client.on('error', err => console.error('❌ MQTT Fehler:', err))

    client.on('message', (topic, message) => {
      const payload = message.toString()

      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
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
  }, [minMax])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) {
      if (value >= 2000) return 'bg-red-600'
      if (value >= 500) return 'bg-yellow-400'
      return 'bg-green-500'
    }
    if (label.includes('Balkonkraftwerk')) {
      if (value > 400) return 'bg-green-500'
      if (value > 150) return 'bg-yellow-400'
      return 'bg-red-600'
    }
    if (label.includes('Pool Temperatur')) {
      if (value > 23) return 'bg-green-500'
      if (value > 17) return 'bg-yellow-400'
      return 'bg-blue-500'
    }
    return 'bg-blue-500'
  }

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div
        className={`${color} h-2 transition-all duration-1000 ease-out`}
        style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
      />
    </div>
  )

  return (
    <main className="min-h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white transition-colors duration-300">
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
          const showMinMax =
            key.includes('power_L') || key.includes('Verbrauch_aktuell') || key === 'Pool_temp/temperatur'
          const range = minMax[key] ?? { min: num, max: num }

          let bgColor = ''
          if (label.includes('Balkonkraftwerk')) bgColor = 'bg-green-100 dark:bg-green-900'
          else if (label.includes('Verbrauch aktuell')) bgColor = 'bg-yellow-100 dark:bg-yellow-900'

          const barColor = getBarColor(label, num)

          return (
            <div key={key} className={`rounded-2xl shadow p-4 border-2 ${bgColor} ${favorite ? 'border-yellow-400' : 'border-gray-500'}`}>
              <h2 className="text-xl font-semibold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, value)}
                >
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}

              {isNumber && (
                <>
                  <p className="text-3xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && (
                    <div className="text-xs mt-1 text-gray-500 dark:text-gray-400">
                      Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}
                    </div>
                  )}
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
