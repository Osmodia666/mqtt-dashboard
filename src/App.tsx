// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

type MinMax = Record<string, { min: number; max: number }>
const MINMAX_TOPIC = 'dashboard/minmax/update'

const client = mqtt.connect(mqttConfig.host, {
  username: mqttConfig.username,
  password: mqttConfig.password,
  clientId: 'dashboard-client-' + Math.random().toString(16).substr(2, 8),
  reconnectPeriod: 1000,
  connectTimeout: 30000,
  keepalive: 60,
  clean: true
})
client.setMaxListeners(50)

function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>({})
  const messageQueue = useRef<Record<string, string>>({})
  const initialized = useRef(false)

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
              key === 'Pool_temp/temperatur' ||
              key.includes('Balkonkraftwerk') ||
              key.includes('Voltage') ||
              key.includes('Strom_L')
            )) {
              const current = nextMinMax[key] ?? { min: num, max: num }
              nextMinMax[key] = {
                min: Math.min(current.min, num),
                max: Math.max(current.max, num)
              }
            }
          }

          setMinMax(nextMinMax)
          client.publish(MINMAX_TOPIC, JSON.stringify(nextMinMax), { retain: true })
          return updated
        })
        setLastUpdate(new Date().toLocaleTimeString())
      }
    }

    const interval = setInterval(flush, 300)

    if (!initialized.current) {
      initialized.current = true

      client.on('connect', () => {
        console.log('✅ MQTT connected')
        const allTopics = topics.map(t => t.statusTopic || t.topic).filter(Boolean)
        client.subscribe([...allTopics, MINMAX_TOPIC])
        client.publish('dashboard/minmax/request', '')

        topics.forEach(({ publishTopic }) => {
          if (publishTopic?.includes('/POWER')) client.publish(publishTopic, '')
          if (publishTopic) {
            const base = publishTopic.split('/')[1]
            client.publish(`cmnd/${base}/state`, '')
          }
        })
      })
      client.on('message', (topic, msgBuffer) => {
        const message = msgBuffer.toString()
        console.log('[MQTT recv]', topic, message)

        if (topic === MINMAX_TOPIC) {
          try {
            const incoming = JSON.parse(message)
            setMinMax(prev => ({ ...prev, ...incoming }))
          } catch (err) {
            console.error('[MQTT] Fehler beim MinMax-Update:', err)
          }
          return
        }

        // Sonderbehandlung für einfache, rohe Werte
        if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
          messageQueue.current[topic] = message
          return
        }

        try {
          const json = JSON.parse(message)
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
            messageQueue.current[`${topic}.${key}`] = val
          }
        } catch {
          messageQueue.current[topic] = message
        }
      })

      client.on('error', err => console.error('[MQTT error]', err))
      client.on('offline', () => console.warn('[MQTT offline]'))
    }

    return () => clearInterval(interval)
  }, [minMax])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
    if (label.includes('Balkonkraftwerk')) return value > 450 ? 'bg-green-500' : value > 150 ? 'bg-yellow-400' : 'bg-red-600'
    if (label.includes('Pool Temperatur')) return value > 23 ? 'bg-green-500' : value > 17 ? 'bg-yellow-400' : 'bg-blue-500'
    return 'bg-blue-500'
  }

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )
      client.on('message', (topic, msgBuffer) => {
        const message = msgBuffer.toString()
        console.log('[MQTT recv]', topic, message)

        if (topic === MINMAX_TOPIC) {
          try {
            const incoming = JSON.parse(message)
            setMinMax(prev => ({ ...prev, ...incoming }))
          } catch (err) {
            console.error('[MQTT] Fehler beim MinMax-Update:', err)
          }
          return
        }

        // Sonderbehandlung für einfache, rohe Werte
        if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
          messageQueue.current[topic] = message
          return
        }

        try {
          const json = JSON.parse(message)
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
            messageQueue.current[`${topic}.${key}`] = val
          }
        } catch {
          messageQueue.current[topic] = message
        }
      })

      client.on('error', err => console.error('[MQTT error]', err))
      client.on('offline', () => console.warn('[MQTT offline]'))
    }

    return () => clearInterval(interval)
  }, [minMax])

  const toggleBoolean = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    client.publish(publishTopic, next)
  }

  const getBarColor = (label: string, value: number) => {
    if (label.includes('Verbrauch aktuell')) return value >= 2000 ? 'bg-red-600' : value >= 500 ? 'bg-yellow-400' : 'bg-green-500'
    if (label.includes('Balkonkraftwerk')) return value > 450 ? 'bg-green-500' : value > 150 ? 'bg-yellow-400' : 'bg-red-600'
    if (label.includes('Pool Temperatur')) return value > 23 ? 'bg-green-500' : value > 17 ? 'bg-yellow-400' : 'bg-blue-500'
    return 'bg-blue-500'
  }

  const progressBar = (value: number, max = 100, color = 'bg-blue-500') => (
    <div className="w-full bg-gray-300 rounded-full h-2 mt-2 overflow-hidden">
      <div className={`${color} h-2 transition-all duration-1000 ease-in-out`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  )
