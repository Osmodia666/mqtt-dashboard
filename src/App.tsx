// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'

type MinMax = Record<string, { min: number; max: number }>
const MINMAX_TOPIC = 'dashboard/minmax/update'
const REQUEST_TOPIC = 'dashboard/minmax/request'
const HISTORY_LENGTH = 60
const MINMAX_CACHE_KEY = 'mqtt_minmax_cache'

const EXPLICIT_SUBSCRIBES = [
  'tele/Stromzähler/SENSOR',
  'tele/Balkonkraftwerk/SENSOR',
  'Pool_temp/temperatur',
  'Gaszaehler/stand',
  'stat/+/POWER',
  'stat/+/POWER1',
  MINMAX_TOPIC,
]

// ── Carbon design tokens ───────────────────────────────────────────────────
const T = {
  bg:       '#141414',
  surf:     '#1f1f1f',
  surf2:    '#2a2a2a',
  border:   'rgba(255,255,255,0.07)',
  borderHi: 'rgba(255,107,53,0.35)',
  text:     '#e0e0e0',
  muted:    'rgba(255,255,255,0.32)',
  accent:   '#ff6b35',
  accentDim:'rgba(255,107,53,0.15)',
  ok:       '#4ade80',
  okDim:    'rgba(74,222,128,0.15)',
  warn:     '#facc15',
  warnDim:  'rgba(250,204,21,0.15)',
  err:      '#f87171',
  errDim:   'rgba(248,113,113,0.15)',
  spark: {
    power:   '#60a5fa',
    energy:  '#4ade80',
    warn:    '#facc15',
    purple:  '#c084fc',
    orange:  '#ff6b35',
    cyan:    '#38bdf8',
  },
} as const

// ── Sparkline ──────────────────────────────────────────────────────────────
function Sparkline({ data, color = T.spark.power, height = 28 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const w = 200, h = height, pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height, display: 'block' }} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function sparkColor(label: string, value: number): string {
  if (label.includes('Verbrauch'))  return value >= 1000 ? T.err  : value >= 300 ? T.warn  : T.ok
  if (label.includes('Balkon') || label.includes('Erzeugung')) return value >= 500 ? T.ok : value >= 250 ? T.warn : T.err
  if (label.includes('Pool') || label.includes('Temperatur')) return value > 23 ? T.ok : value > 17 ? T.warn : T.spark.cyan
  if (label.includes('Spannung')) return T.spark.purple
  if (label.includes('Strom'))    return T.spark.orange
  if (label.includes('Leistung')) return T.spark.power
  return T.spark.power
}

// ── LocalStorage helpers ───────────────────────────────────────────────────
function loadCachedMinMax(): MinMax {
  try { const r = localStorage.getItem(MINMAX_CACHE_KEY); return r ? JSON.parse(r) : {} } catch { return {} }
}
function saveCachedMinMax(data: MinMax) {
  try { localStorage.setItem(MINMAX_CACHE_KEY, JSON.stringify(data)) } catch {}
}

// ── Shared card shell ──────────────────────────────────────────────────────
function Card({ children, highlight = false }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <div style={{
      background: T.surf,
      border: `1px solid ${highlight ? T.borderHi : T.border}`,
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      {children}
    </div>
  )
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: T.muted,
      marginBottom: 8,
    }}>
      {children}
    </div>
  )
}

// ── Progress bar ───────────────────────────────────────────────────────────
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0)
  return (
    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, height: 4, marginTop: 6, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ── Toggle button ──────────────────────────────────────────────────────────
function ToggleBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 12px',
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        border: `1px solid ${on ? T.ok + '55' : T.err + '55'}`,
        background: on ? T.okDim : T.errDim,
        color: on ? T.ok : T.err,
        letterSpacing: '0.04em',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      {on ? 'AN' : 'AUS'}
    </button>
  )
}

// ── MinMax label ───────────────────────────────────────────────────────────
function MinMaxRow({ min, max, unit }: { min: number; max: number; unit?: string }) {
  return (
    <div style={{ fontSize: 10, color: T.muted, marginTop: 3 }}>
      Min: {min?.toFixed(1)}{unit} | Max: {max?.toFixed(1)}{unit}
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────────
function App() {
  const [values, setValues]     = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax]     = useState<MinMax>(loadCachedMinMax)
  const histRef                 = useRef<Record<string, number[]>>({})
  const messageQueue            = useRef<Record<string, string>>({})
  const clientRef               = useRef<any>(null)

  useEffect(() => {
    const client = mqtt.connect(mqttConfig.host, {
      username: mqttConfig.username,
      password: mqttConfig.password,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
    })
    clientRef.current = client

    client.on('connect', () => {
      client.subscribe(EXPLICIT_SUBSCRIBES, { qos: 0 }, () => {
        client.publish(REQUEST_TOPIC, JSON.stringify({ ts: Date.now() }))
      })
      topics.forEach(({ publishTopic }) => {
        if (publishTopic?.includes('/POWER')) client.publish(publishTopic, '')
      })
    })

    client.on('error', (err) => console.error('MQTT:', err))

    client.on('message', (topic, message) => {
      const payload = message.toString()
      if (topic === MINMAX_TOPIC) {
        try { const d = JSON.parse(payload); setMinMax(d); saveCachedMinMax(d) } catch {}
        return
      }
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload; return
      }
      try {
        const json = JSON.parse(payload)
        const flatten = (obj: any, prefix = ''): Record<string, string> =>
          Object.entries(obj).reduce((acc: Record<string, string>, [key, val]) => {
            const k = prefix ? `${prefix}.${key}` : key
            if (typeof val === 'object' && val !== null) Object.assign(acc, flatten(val, k))
            else acc[k] = String(val)
            return acc
          }, {})
        const flat = flatten(json)
        for (const [k, v] of Object.entries(flat)) messageQueue.current[`${topic}.${k}`] = v
      } catch {
        messageQueue.current[topic] = payload
      }
    })

    const flush = () => {
      const updates = messageQueue.current
      if (Object.keys(updates).length === 0) return
      messageQueue.current = {}
      const h = histRef.current
      for (const [key, val] of Object.entries(updates)) {
        const n = parseFloat(val)
        if (isNaN(n)) continue
        if (!h[key])                     h[key] = [n]
        else if (h[key].length >= HISTORY_LENGTH) h[key] = [...h[key].slice(1), n]
        else                             h[key].push(n)
      }
      setValues(prev => ({ ...prev, ...updates }))
      setLastUpdate(new Date().toLocaleTimeString())
    }

    const interval = setInterval(flush, 150)
    return () => { clearInterval(interval); client.end(true) }
  }, [])

  const toggle = (publishTopic: string, current: string) => {
    const next = current?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({ ...prev, [publishTopic.replace('cmnd/', 'stat/')]: next }))
    clientRef.current?.publish(publishTopic, next)
  }

  const isOn = (val: string) => val?.toUpperCase() === 'ON'
  const hist = histRef.current

  // ── helpers ──────────────────────────────────────────────────────────────
  const powerColor = (w: number) => w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* ── Header ── */}
      <header style={{
        background: T.surf,
        borderBottom: `2px solid ${T.accent}`,
        padding: '10px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text, opacity: 0.7 }}>
            MQTT Dashboard
          </span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: lastUpdate ? T.ok : T.warn, display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: lastUpdate ? T.ok : T.warn }}>
            {lastUpdate ? 'verbunden' : 'verbinde…'}
          </span>
        </div>
        <span style={{ fontSize: 11, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
          {lastUpdate ? `Letztes Update: ${lastUpdate}` : ''}
        </span>
      </header>

      <main style={{ padding: '14px 20px 32px' }}>

        {/* ── Top cards grid ── */}
        <div className="grid-top">

          {/* 3D-Drucker */}
          <Card>
            <CardLabel>🧱 3D-Drucker</CardLabel>
            {['Sidewinder X1'].map(label => {
              const t = topics.find(x => x.label === label)
              if (!t) return null
              const val = values[t.statusTopic]
              return (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13 }}>{label}</span>
                  <ToggleBtn on={isOn(val)} onClick={() => toggle(t.publishTopic!, val)} />
                </div>
              )
            })}
          </Card>

          {/* Pool */}
          <Card>
            <CardLabel>🏊 Pool</CardLabel>
            {(() => {
              const pumpe   = topics.find(t => t.label === 'Poolpumpe')
              const tempKey = 'Pool_temp/temperatur'
              const raw     = values[tempKey]
              const val     = raw !== undefined ? parseFloat(raw) : NaN
              const range   = minMax[tempKey] ?? { min: val, max: val }
              const h       = hist[tempKey] ?? []
              const col     = val > 23 ? T.ok : val > 17 ? T.warn : T.spark.cyan
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13 }}>Pumpe</span>
                    {pumpe && <ToggleBtn on={isOn(values[pumpe.statusTopic])} onClick={() => toggle(pumpe.publishTopic!, values[pumpe.statusTopic])} />}
                  </div>
                  <div style={{ fontSize: 13, marginBottom: 2 }}>🌡️ {isNaN(val) ? '…' : `${val} °C`}</div>
                  <Bar value={val} max={40} color={col} />
                  <MinMaxRow min={range.min} max={range.max} unit=" °C" />
                  {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} height={26} /></div>}
                </>
              )
            })()}
          </Card>

          {/* Zähler */}
          <Card>
            <CardLabel>🎰 Zähler</CardLabel>
            <div style={{ fontSize: 13, lineHeight: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span><span style={{ color: T.muted }}>⚡</span> {values['tele/Stromzähler/SENSOR.grid.sml_v'] ?? '…'} kWh</span>
              <span><span style={{ color: T.muted }}>🔋</span> {(() => {
                const raw = values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0']
                const n   = parseFloat(raw)
                return !isNaN(n) ? (n + 178.779).toFixed(3) : '…'
              })()} kWh</span>
              <span><span style={{ color: T.muted }}>🔥</span> {values['Gaszaehler/stand'] ?? '…'} m³</span>
            </div>
          </Card>

          {/* Strom */}
          <Card>
            <CardLabel>🔋 Strom</CardLabel>
            {(() => {
              const key   = 'tele/Stromzähler/SENSOR.grid.sml_m'
              const num   = parseFloat(values[key])
              const range = minMax[key] ?? { min: num, max: num }
              const h     = hist[key] ?? []
              const col   = powerColor(num)
              return (
                <>
                  <div style={{ fontSize: 13, marginBottom: 2 }}>Verbrauch: <strong style={{ color: T.text }}>{isNaN(num) ? '…' : `${num} W`}</strong></div>
                  <Bar value={num} max={range.max > 0 ? range.max : 2000} color={col} />
                  <MinMaxRow min={range.min} max={range.max} unit=" W" />
                  {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} height={26} /></div>}
                </>
              )
            })()}
            {(() => {
              const key   = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
              const num   = parseFloat(values[key])
              const range = minMax[key] ?? { min: num, max: num }
              const h     = hist[key] ?? []
              const col   = num >= 500 ? T.ok : num >= 250 ? T.warn : T.err
              return (
                <>
                  <div style={{ fontSize: 13, marginTop: 10, marginBottom: 2 }}>Erzeugung: <strong style={{ color: T.text }}>{isNaN(num) ? '…' : `${num} W`}</strong></div>
                  <Bar value={num} max={range.max > 0 ? range.max : 1000} color={col} />
                  <MinMaxRow min={range.min} max={range.max} unit=" W" />
                  {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} height={26} /></div>}
                </>
              )
            })()}
          </Card>

          {/* Steckdosen 1 */}
          <Card>
            <CardLabel>🔌 Steckdosen 1</CardLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {['Steckdose 1', 'Steckdose 2'].map(label => {
                const t = topics.find(x => x.label === label)
                if (!t) return null
                const val = values[t.statusTopic]
                return (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13 }}>{label}</span>
                    <ToggleBtn on={isOn(val)} onClick={() => toggle(t.publishTopic!, val)} />
                  </div>
                )
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>Doppelsteckdose</span>
                <ToggleBtn
                  on={isOn(values['stat/Doppelsteckdose/POWER'])}
                  onClick={() => toggle('cmnd/Doppelsteckdose/POWER', values['stat/Doppelsteckdose/POWER'])}
                />
              </div>
            </div>
          </Card>

          {/* Steckdosen + Beleuchtung */}
          <Card>
            <CardLabel>🔌 Steckdosen + Beleuchtung</CardLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Teichpumpe',   pub: 'cmnd/Teichpumpe/POWER',   stat: 'stat/Teichpumpe/POWER' },
                { label: 'Beleuchtung',  pub: 'cmnd/Beleuchtung/POWER',  stat: 'stat/Beleuchtung/POWER' },
                { label: 'Carport-Licht',pub: 'cmnd/Carport-Licht/POWER',stat: 'stat/Carport-Licht/POWER' },
              ].map(({ label, pub, stat }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13 }}>{label}</span>
                  <ToggleBtn on={isOn(values[stat])} onClick={() => toggle(pub, values[stat])} />
                </div>
              ))}
            </div>
          </Card>

          {/* Dynamische Topics */}
          {topics.filter(t =>
            t.type !== 'group' &&
            !['Sidewinder X1', 'Poolpumpe', 'Steckdose 1', 'Steckdose 2'].includes(t.label)
          ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
            const key    = statusTopic ?? topic
            const raw    = values[key]
            const num    = parseFloat(raw)
            const isNum  = type === 'number' && !isNaN(num)
            const showMM = !label.includes('gesamt') && (key.includes('sml_L') || key.includes('sml_m') || key.includes('Balkonkraftwerk'))
            const range  = minMax[key] ?? { min: num, max: num }
            const h      = hist[key] ?? []
            return (
              <Card key={key} highlight={favorite}>
                <CardLabel>{label}</CardLabel>
                {type === 'boolean' && (
                  <ToggleBtn on={isOn(raw)} onClick={() => toggle(publishTopic ?? key, raw)} />
                )}
                {isNum && (
                  <>
                    <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {raw} <span style={{ fontSize: 13, fontWeight: 400, color: T.muted }}>{unit}</span>
                    </div>
                    {showMM && <Bar value={num} max={range.max > 0 ? range.max : 100} color={powerColor(num)} />}
                    {showMM && <MinMaxRow min={range.min} max={range.max} unit={unit ? ` ${unit}` : ''} />}
                    {h.length >= 2 && <div style={{ marginTop: 6 }}><Sparkline data={h} color={sparkColor(label, num)} height={26} /></div>}
                  </>
                )}
                {type === 'string' && <div style={{ fontSize: 15 }}>{raw ?? '…'}</div>}
              </Card>
            )
          })}
        </div>

        {/* ── Group cards (L1–L3) ── */}
        <div className="grid-groups">
          {topics.filter(t => t.type === 'group').map(group => (
            <Card key={group.label}>
              <CardLabel>{group.label}</CardLabel>
              {group.keys?.map(({ label, key }) => {
                const raw      = values[key]
                const num      = raw !== undefined ? parseFloat(raw) : NaN
                const range    = minMax[key] ?? { min: num, max: num }
                const h        = hist[key] ?? []
                const isSpan   = group.label.includes('Spannung')
                const isStrom  = group.label.includes('Strom L')
                const barColor = isSpan ? T.spark.purple : isStrom ? T.spark.orange : T.spark.power
                const barMax   = isSpan ? 250 : isStrom ? 20 : 1000
                const dp       = isSpan ? 0 : 1
                return (
                  <div key={key} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13 }}>
                      <span style={{ color: T.muted }}>{label}</span>
                      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{isNaN(num) ? '…' : `${num.toFixed(dp)} ${group.unit}`}</strong>
                    </div>
                    <Bar value={num} max={barMax} color={barColor} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginTop: 2 }}>
                      <span>Min: {range.min?.toFixed(dp)} {group.unit}</span>
                      <span>Max: {range.max?.toFixed(dp)} {group.unit}</span>
                    </div>
                    {h.length >= 2 && <div style={{ marginTop: 3, opacity: 0.65 }}><Sparkline data={h} color={barColor} height={24} /></div>}
                  </div>
                )
              })}
            </Card>
          ))}
        </div>

      </main>
    </div>
  )
}

export default App
