// src/App.tsx (Teil 1 von 3)
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

      if (Object.keys(updates).length === 0) return
      setValues(prev => {
        const updated = { ...prev, ...updates }
        const nextMinMax = { ...minMax }

        Object.entries(updates).forEach(([key, val]) => {
          const num = parseFloat(val)
          if (!isNaN(num) && (
            key.includes('power_L') ||
            key.includes('Verbrauch_aktuell') ||
            key === 'Pool_temp/temperatur' ||
            key.includes('Balkonkraftwerk') ||
            key.includes('Voltage') ||
            key.includes('Strom_L')
          )) {
            const cur = nextMinMax[key] ?? { min: num, max: num }
            nextMinMax[key] = { min: Math.min(cur.min, num), max: Math.max(cur.max, num) }
          }
        })

        setMinMax(nextMinMax)
        client.publish(MINMAX_TOPIC, JSON.stringify(nextMinMax), { retain: true })
        return updated
      })
      setLastUpdate(new Date().toLocaleTimeString())
    }

    const interval = setInterval(flush, 300)

    if (!initialized.current) {
      initialized.current = true
      client.on('connect', () => {
        console.log('✅ MQTT connected')
        const allTopics = topics
          .map(t => t.statusTopic || t.topic)
          .concat(topics.filter(t => t.type === 'number').map(t => t.statusTopic!))
          .filter(Boolean)
        client.subscribe([...new Set(allTopics), MINMAX_TOPIC])
        client.publish('dashboard/minmax/request', '')

        topics.forEach(({ publishTopic }) => {
          if (publishTopic?.includes('/POWER')) client.publish(publishTopic, '')
          if (publishTopic) {
            const base = publishTopic.split('/')[1]
            client.publish(`cmnd/${base}/state`, '')
          }
        })
      })

      client.on('message', (topic, msg) => {
        const message = msg.toString()
        console.log('[MQTT recv]', topic, message)

        if (topic === MINMAX_TOPIC) {
          try {
            const inc = JSON.parse(message)
            setMinMax(prev => ({ ...prev, ...inc }))
          } catch (e) {
            console.error('[MINMAX parse]', e)
          }
          return
        }

        if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
          messageQueue.current[topic] = message
        } else {
          try {
            const obj = JSON.parse(message)
            const flatten = (o: any, p = ''): Record<string, string> =>
              Object.entries(o).reduce((a, [k, v]) => {
                const nk = p ? `${p}.${k}` : k
                if (v !== null && typeof v === 'object') Object.assign(a, flatten(v, nk))
                else a[nk] = String(v)
                return a
              }, {})
            const flat = flatten(obj)
            Object.entries(flat).forEach(([k, v]) => {
              messageQueue.current[`${topic}.${k}`] = v
            })
          } catch {
            messageQueue.current[topic] = message
          }
        }
      })
    }

    return () => clearInterval(interval)
  }, [minMax])
  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">Letztes Update: {lastUpdate || 'Lade...'}</header>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">

        {/* 3D‑Drucker */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🧱 3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map((lbl, i) => {
            const t = topics.find(x => x.label === lbl)
            const v = t && values[t.statusTopic!]?.toUpperCase()
            return (
              <div key={lbl} className={`flex justify-between items-center ${i ? 'mt-3' : 'mt-1'}`}>
                <span>{lbl}</span>
                <button
                  className={`px-4 py-1 rounded text-white ${v === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => t && client.publish(t.publishTopic!, v === 'ON' ? 'OFF' : 'ON')}
                >
                  {v === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Pool */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🏊 Pool</h2>
          {(() => {
            const t = topics.find(x => x.label === 'Poolpumpe')
            const st = t && values[t.statusTopic!]?.toUpperCase()
            const raw = values['Pool_temp/temperatur']
            const num = raw ? parseFloat(raw) : NaN
            const r = minMax['Pool_temp/temperatur'] ?? { min: num, max: num }
            return (
              <>
                <div className="flex justify-between items-center">
                  <span>Pumpe</span>
                  {t && (
                    <button
                      className={`px-4 py-1 rounded text-white ${st==='ON'? 'bg-green-500' : 'bg-red-500'}`}
                      onClick={() => client.publish(t.publishTopic!, st==='ON'?'OFF':'ON')}
                    >
                      {st==='ON'?'AN':'AUS'}
                    </button>
                  )}
                </div>
                <p className="mt-3">🌡️ Temperatur: {isNaN(num) ? '...' : `${num} °C`}</p>
                {progressBar(num, 40, getBarColor('Pool Temperatur', num))}
                <p className="text-xs text-gray-400">Min: {r.min.toFixed(1)} °C | Max: {r.max.toFixed(1)} °C</p>
              </>
            )
          })()}
        </div>

        {/* Zähler */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
          <div className="flex flex-col space-y-3">
            <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_aktuell'] ?? '...'} W</p>
            <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
          </div>
        </div>

        {/* Erzeugung */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3">🔋 Erzeugung</h2>
          <p>Gesamt: {(() => {
            const raw = values['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0']
            const num = raw ? parseFloat(raw) : NaN
            return isNaN(num) ? '...' : (num + 178.779).toFixed(3)
          })()} kWh</p>
        </div>
        {/* Steckdosen + Einzelgeräte */}
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen</h2>
          {['Steckdose 1', 'Steckdose 2'].map((lbl, i) => {
            const t = topics.find(x => x.label === lbl)
            const st = t && values[t.statusTopic!]?.toUpperCase()
            return (
              <div key={lbl} className={`flex justify-between items-center ${i ? 'mt-3' : 'mt-1'}`}>
                <span>{lbl}</span>
                <button
                  className={`px-4 py-1 rounded text-white ${st==='ON'? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => client.publish(t!.publishTopic!, st==='ON'?'OFF':'ON')}
                >
                  {st==='ON'?'AN':'AUS'}
                </button>
              </div>
            )
          })}
        </div>

        {topics.filter(t => t.type !== 'group' && !['Ender 3 Pro','Sidewinder X1','Poolpumpe','Steckdose 1','Steckdose 2']).map(t => {
          const raw = values[t.statusTopic || t.topic]
          const val = raw?.toUpperCase()
          const num = parseFloat(raw || '')
          const isNum = t.type === 'number' && !isNaN(num)
          const show = isNum && ['power_L','Verbrauch_aktuell','Balkonkraftwerk'].some(k => (t.statusTopic||t.topic).includes(k))
          const r = minMax[t.statusTopic || t.topic] ?? { min: num, max: num }
          return (
            <div key={t.label} className={`rounded-xl p-4 border ${t.favorite?'border-yellow-400':'border-gray-600'} bg-gray-800`}>
              <h2 className="text-md font-bold mb-2">{t.label}</h2>
              {t.type==='boolean' ? (
                <button
                  className={`px-4 py-1 rounded text-white ${val==='ON'? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => client.publish(t.publishTopic || t.statusTopic!, val==='ON'? 'OFF':'ON')}
                >
                  {val==='ON'?'AN':'AUS'}
                </button>
              ) : isNum ? (
                <>
                  <p className="text-2xl">{num.toFixed(1)} {t.unit}</p>
                  {show && progressBar(num, r.max>0?r.max:100, getBarColor(t.label, num))}
                  {show && <p className="text-xs text-gray-400">Min: {r.min.toFixed(1)} {t.unit} | Max: {r.max.toFixed(1)} {t.unit}</p>}
                </>
              ) : (
                <p className="text-lg">{raw ?? '...'}</p>
              )}
            </div>
          )
        })}

      </div>

      {/* Gruppenkacheln */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(gr => (
          <div key={gr.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <h2 className="text-lg font-bold mb-2">{gr.label}</h2>
            {gr.keys?.map(k => {
              const raw = values[k.key]
              const num = raw ? parseFloat(raw) : NaN
              const r = minMax[k.key] ?? { min: num, max: num }
              return (
                <div key={k.key} className="mb-2">
                  <div className="text-sm">{k.label}: {isNaN(num)? '...':`${num} ${gr.unit}`}</div>
                  {progressBar(num, gr.unit==='V'?250:1000,'bg-blue-500')}
                  <div className="text-xs text-gray-400">Min: {r.min.toFixed(1)} | Max: {r.max.toFixed(1)}</div>
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
