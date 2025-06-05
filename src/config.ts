import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
})

type MinMax = Record<string, { min: number, max: number }>

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [minMax, setMinMax] = useState<MinMax>({})
  const [lastUpdate, setLastUpdate] = useState<string>('')
  const messageQueue = useRef<Record<string, string>>({})

  useEffect(() => {
    const flush = () => {
      const updates = { ...messageQueue.current }
      messageQueue.current = {}

      if (Object.keys(updates).length > 0) {
        setValues((prev) => {
          const next = { ...prev, ...updates }
          setMinMax((old) => {
            const updated = { ...old }
            for (const [key, val] of Object.entries(updates)) {
              const num = parseFloat(val)
              if (!isNaN(num)) {
                updated[key] = {
                  min: Math.min(num, old[key]?.min ?? num),
                  max: Math.max(num, old[key]?.max ?? num),
                }
              }
            }
            return updated
          })
          return next
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

      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload
        console.log('📨 Text (Sondertopic):', topic, payload)
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

  const getBarPercent = (value: number, key: string): number => {
    const mm = minMax[key]
    if (!mm || mm.max === mm.min) return 0
    return ((value - mm.min) / (mm.max - mm.min)) * 100
  }

  return (
    <main className="min-h-screen p-4 bg-gray-900 text-white relative">
      <div className="absolute top-2 right-4">
        <div
          className={`w-3 h-3 rounded-full ${client.connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={client.connected ? 'MQTT verbunden' : 'MQTT getrennt'}
        />
      </div>

      <header className="mb-4 text-sm text-gray-400">
        Letztes Update: {lastUpdate || 'Lade...'}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {topics.map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const valueStr = values[key]
          const value = valueStr ? parseFloat(valueStr) : NaN
          const percent = isNaN(value) ? 0 : getBarPercent(value, key)

          let bgColor = 'bg-gray-800'
          if (label.includes('Verbrauch aktuell')) bgColor = 'bg-yellow-900'
          if (label.includes('Balkonkraftwerk Power')) bgColor = 'bg-green-900'

          return (
            <div
              key={key}
              className={`${bgColor} rounded-2xl shadow p-4 border-2 ${favorite ? 'border-yellow-400' : 'border-transparent'}`}
            >
              <h2 className="text-lg font-bold mb-2">{label}</h2>

              {type === 'boolean' && (
                <button
                  className={`px-4 py-2 rounded-xl text-white ${valueStr?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, valueStr)}
                >
                  {valueStr?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}

              {type === 'number' && (
                <>
                  <p className="text-3xl">
                    {valueStr ?? '...'} {unit}
                  </p>
                  <div className="h-2 bg-gray-700 rounded mt-2 overflow-hidden">
                    <div className="h-full bg-blue-400" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    min: {minMax[key]?.min ?? '…'} {unit} | max: {minMax[key]?.max ?? '…'} {unit}
                  </div>
                </>
              )}

              {type === 'string' && (
                <p className="text-xl">{valueStr ?? '...'}</p>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

export default App
