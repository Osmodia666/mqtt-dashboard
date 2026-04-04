// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics } from './config'
import { T } from './theme'

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

function loadCachedMinMax(): MinMax {
  try { const r = localStorage.getItem(MINMAX_CACHE_KEY); return r ? JSON.parse(r) : {} } catch { return {} }
}
function saveCachedMinMax(data: MinMax) {
  try { localStorage.setItem(MINMAX_CACHE_KEY, JSON.stringify(data)) } catch {}
}

// ── Sparkline ──────────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 30 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1
  const w = 200, h = height, pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height, display: 'block' }} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function sparkColor(label: string, value: number): string {
  if (label.includes('Verbrauch'))  return value >= 1000 ? T.err : value >= 300 ? T.warn : T.ok
  if (label.includes('Balkon') || label.includes('Erzeugung')) return value >= 500 ? T.ok : value >= 250 ? T.warn : T.err
  if (label.includes('Pool') || label.includes('Temperatur'))  return value > 23 ? T.ok : value > 17 ? T.warn : T.spark.cyan
  if (label.includes('Spannung')) return T.spark.purple
  if (label.includes('Strom'))    return T.spark.orange
  if (label.includes('Leistung')) return T.spark.power
  return T.spark.power
}

// ── Card ──────────────────────────────────────────────────────────────────
function Card({ children, accentColor, highlight = false }: { children: React.ReactNode; accentColor?: string; highlight?: boolean }) {
  const color = accentColor ?? T.accent
  return (
    <div style={{
      background: T.surf,
      border: `1px solid ${highlight ? color + '40' : T.border}`,
      borderRadius: T.radius,
      padding: '13px 15px',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }} />
      {children}
    </div>
  )
}

// ── Card Label ────────────────────────────────────────────────────────────
// Emoji is isolated from text-transform to avoid Chromium glyph rendering bug
function CardLabel({ icon, children, color }: { icon: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
      <span style={{ fontSize: 15, lineHeight: 1, fontStyle: 'normal', textTransform: 'none', letterSpacing: 0 }}>
        {icon}
      </span>
      <span style={{
        fontFamily: T.fontLabel,
        fontSize: T.labelSize,
        fontWeight: 700,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: color ?? T.accent,
      }}>
        {children}
      </span>
    </div>
  )
}

// ── Bar ───────────────────────────────────────────────────────────────────
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : 0)
  return (
    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, height: 4, marginTop: 7, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ── MinMax ────────────────────────────────────────────────────────────────
function MinMaxRow({ min, max, unit }: { min: number; max: number; unit?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.muted, marginTop: 4, fontFamily: T.fontMono }}>
      <span>Min: {min?.toFixed(1)}{unit}</span>
      <span>Max: {max?.toFixed(1)}{unit}</span>
    </div>
  )
}

// ── Toggle Button ─────────────────────────────────────────────────────────
function ToggleBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 13px',
      borderRadius: T.btnRadius,
      fontSize: 12,
      fontWeight: 700,
      fontFamily: T.fontLabel,
      cursor: 'pointer',
      border: `1px solid ${on ? T.ok + '55' : T.err + '55'}`,
      background: on ? T.ok + '22' : T.err + '22',
      color: on ? T.ok : T.err,
      letterSpacing: '0.05em',
      transition: 'all 0.15s',
      whiteSpace: 'nowrap',
    }}>
      {on ? 'AN' : 'AUS'}
    </button>
  )
}

// ── Switch Row ────────────────────────────────────────────────────────────
function SwitchRow({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <span style={{ fontSize: 14, fontFamily: T.fontBody, color: T.text }}>{label}</span>
      <ToggleBtn on={on} onClick={onClick} />
    </div>
  )
}

// ── Value Display ─────────────────────────────────────────────────────────
function BigVal({ value, unit, size = 20 }: { value: string; unit?: string; size?: number }) {
  return (
    <div style={{ fontFamily: T.fontMono, fontSize: size, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15, color: T.text }}>
      {value}
      {unit && <span style={{ fontSize: size * 0.62, fontWeight: 400, color: T.muted, marginLeft: 3 }}>{unit}</span>}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
function App() {
  const [values, setValues]         = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax]         = useState<MinMax>(loadCachedMinMax)
  const histRef                     = useRef<Record<string, number[]>>({})
  const messageQueue                = useRef<Record<string, string>>({})
  const clientRef                   = useRef<any>(null)

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

    client.on('error', err => console.error('MQTT:', err))

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
          Object.entries(obj).reduce((acc: Record<string, string>, [k, v]) => {
            const key = prefix ? `${prefix}.${k}` : k
            if (typeof v === 'object' && v !== null) Object.assign(acc, flatten(v, key))
            else acc[key] = String(v)
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
      if (!Object.keys(updates).length) return
      messageQueue.current = {}
      const h = histRef.current
      for (const [key, val] of Object.entries(updates)) {
        const n = parseFloat(val)
        if (isNaN(n)) continue
        if (!h[key])                              h[key] = [n]
        else if (h[key].length >= HISTORY_LENGTH) h[key] = [...h[key].slice(1), n]
        else                                      h[key].push(n)
      }
      setValues(prev => ({ ...prev, ...updates }))
      setLastUpdate(new Date().toLocaleTimeString())
    }

    const iv = setInterval(flush, 150)
    return () => { clearInterval(iv); client.end(true) }
  }, [])

  const toggle = (pub: string, cur: string) => {
    const next = cur?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({ ...prev, [pub.replace('cmnd/', 'stat/')]: next }))
    clientRef.current?.publish(pub, next)
  }

  const isOn       = (v: string) => v?.toUpperCase() === 'ON'
  const hist       = histRef.current
  const powerColor = (w: number) => w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: T.fontBody }}>

      {/* ── Header ── */}
      <header style={{
        background: T.surf,
        borderBottom: `2px solid ${T.accent}`,
        padding: '11px 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: T.fontLabel, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text, opacity: 0.75 }}>
            MQTT Dashboard
          </span>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: lastUpdate ? T.ok : T.warn, display: 'inline-block' }} />
          <span style={{ fontFamily: T.fontLabel, fontSize: 12, color: lastUpdate ? T.ok : T.warn }}>
            {lastUpdate ? 'verbunden' : 'verbinde…'}
          </span>
        </div>
        <span style={{ fontFamily: T.fontMono, fontSize: 12, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>
          {lastUpdate ? `Letztes Update: ${lastUpdate}` : ''}
        </span>
      </header>

      <main style={{ padding: '14px 18px 32px' }}>

        {/* ── Top grid ── */}
        <div className="grid-top">

          {/* 3D-Drucker */}
          <Card accentColor={T.accent}>
            <CardLabel icon="🖨️" color={T.accent}>3D-Drucker</CardLabel>
            {['Sidewinder X1'].map(label => {
              const t = topics.find(x => x.label === label)
              if (!t) return null
              return <SwitchRow key={label} label={label} on={isOn(values[t.statusTopic])} onClick={() => toggle(t.publishTopic!, values[t.statusTopic])} />
            })}
          </Card>

          {/* Pool */}
          <Card accentColor={T.spark.energy}>
            <CardLabel icon="🏊" color={T.spark.energy}>Pool</CardLabel>
            {(() => {
              const pumpe   = topics.find(x => x.label === 'Poolpumpe')
              const tempKey = 'Pool_temp/temperatur'
              const raw     = values[tempKey]
              const val     = raw !== undefined ? parseFloat(raw) : NaN
              const range   = minMax[tempKey] ?? { min: val, max: val }
              const h       = hist[tempKey] ?? []
              const col     = val > 23 ? T.ok : val > 17 ? T.warn : T.spark.cyan
              return <>
                <SwitchRow label="Pumpe" on={isOn(values[pumpe?.statusTopic ?? ''])}
                  onClick={() => pumpe && toggle(pumpe.publishTopic!, values[pumpe.statusTopic])} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginTop: 4 }}>
                  <span style={{ fontSize: 16 }}>🌡️</span>
                  <BigVal value={isNaN(val) ? '…' : `${val}`} unit="°C" size={18} />
                </div>
                <Bar value={val} max={40} color={col} />
                <MinMaxRow min={range.min} max={range.max} unit=" °C" />
                {h.length >= 2 && <div style={{ marginTop: 5 }}><Sparkline data={h} color={col} /></div>}
              </>
            })()}
          </Card>

          {/* Zähler */}
          <Card accentColor={T.spark.cyan}>
            <CardLabel icon="📊" color={T.spark.cyan}>Zähler</CardLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                { icon: '⚡', val: values['tele/Stromzähler/SENSOR.grid.sml_v'], unit: 'kWh' },
                { icon: '🔋', val: (() => { const n = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0']); return !isNaN(n) ? (n + 178.779).toFixed(3) : '…' })(), unit: 'kWh' },
                { icon: '🔥', val: values['Gaszaehler/stand'], unit: 'm³' },
              ].map(({ icon, val, unit }, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontSize: 16 }}>{icon}</span>
                  <BigVal value={val ?? '…'} unit={unit} size={15} />
                </div>
              ))}
            </div>
          </Card>

          {/* Strom */}
          <Card accentColor={T.err}>
            <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
            {(() => {
              const key   = 'tele/Stromzähler/SENSOR.grid.sml_m'
              const num   = parseFloat(values[key])
              const range = minMax[key] ?? { min: num, max: num }
              const h     = hist[key] ?? []
              const col   = powerColor(num)
              return <>
                <div style={{ fontSize: 13, color: T.muted, marginBottom: 3 }}>Verbrauch</div>
                <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={22} />
                <Bar value={num} max={range.max > 0 ? range.max : 2000} color={col} />
                <MinMaxRow min={range.min} max={range.max} unit=" W" />
                {h.length >= 2 && <div style={{ marginTop: 5 }}><Sparkline data={h} color={col} /></div>}
              </>
            })()}
            {(() => {
              const key   = 'tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'
              const num   = parseFloat(values[key])
              const range = minMax[key] ?? { min: num, max: num }
              const h     = hist[key] ?? []
              const col   = num >= 500 ? T.ok : num >= 250 ? T.warn : T.err
              return <>
                <div style={{ fontSize: 13, color: T.muted, marginTop: 12, marginBottom: 3 }}>Erzeugung</div>
                <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={22} />
                <Bar value={num} max={range.max > 0 ? range.max : 1000} color={col} />
                <MinMaxRow min={range.min} max={range.max} unit=" W" />
                {h.length >= 2 && <div style={{ marginTop: 5 }}><Sparkline data={h} color={col} /></div>}
              </>
            })()}
          </Card>

          {/* Steckdosen 1 */}
          <Card accentColor={T.spark.power}>
            <CardLabel icon="🔌" color={T.spark.power}>Steckdosen 1</CardLabel>
            {['Steckdose 1', 'Steckdose 2'].map(label => {
              const t = topics.find(x => x.label === label)
              if (!t) return null
              return <SwitchRow key={label} label={label} on={isOn(values[t.statusTopic])} onClick={() => toggle(t.publishTopic!, values[t.statusTopic])} />
            })}
            <SwitchRow label="Doppelsteckdose"
              on={isOn(values['stat/Doppelsteckdose/POWER'])}
              onClick={() => toggle('cmnd/Doppelsteckdose/POWER', values['stat/Doppelsteckdose/POWER'])} />
          </Card>

          {/* Beleuchtung */}
          <Card accentColor={T.spark.purple}>
            <CardLabel icon="💡" color={T.spark.purple}>Steckdosen + Beleuchtung</CardLabel>
            {[
              { label: 'Teichpumpe',    pub: 'cmnd/Teichpumpe/POWER',    stat: 'stat/Teichpumpe/POWER' },
              { label: 'Beleuchtung',   pub: 'cmnd/Beleuchtung/POWER',   stat: 'stat/Beleuchtung/POWER' },
              { label: 'Carport-Licht', pub: 'cmnd/Carport-Licht/POWER', stat: 'stat/Carport-Licht/POWER' },
            ].map(({ label, pub, stat }) => (
              <SwitchRow key={label} label={label} on={isOn(values[stat])} onClick={() => toggle(pub, values[stat])} />
            ))}
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
            const col    = sparkColor(label, num)
            return (
              <Card key={key} accentColor={col} highlight={favorite}>
                <CardLabel icon="" color={col}>{label}</CardLabel>
                {type === 'boolean' && <ToggleBtn on={isOn(raw)} onClick={() => toggle(publishTopic ?? key, raw)} />}
                {isNum && <>
                  <BigVal value={raw} unit={unit} size={22} />
                  {showMM && <Bar value={num} max={range.max > 0 ? range.max : 100} color={powerColor(num)} />}
                  {showMM && <MinMaxRow min={range.min} max={range.max} unit={unit ? ` ${unit}` : ''} />}
                  {h.length >= 2 && <div style={{ marginTop: 6 }}><Sparkline data={h} color={col} /></div>}
                </>}
                {type === 'string' && <div style={{ fontSize: 15 }}>{raw ?? '…'}</div>}
              </Card>
            )
          })}
        </div>

        {/* ── Group cards L1–L3 ── */}
        <div className="grid-groups">
          {topics.filter(t => t.type === 'group').map(group => {
            const isSpan  = group.label.includes('Spannung')
            const isStrom = group.label.includes('Strom L')
            const groupColor = isSpan ? T.spark.purple : isStrom ? T.spark.orange : T.spark.power
            const barMax  = isSpan ? 250 : isStrom ? 20 : 1000
            const dp      = isSpan ? 0 : 1
            return (
              <Card key={group.label} accentColor={groupColor}>
                <CardLabel icon="" color={groupColor}>{group.label}</CardLabel>
                {group.keys?.map(({ label, key }) => {
                  const raw   = values[key]
                  const num   = raw !== undefined ? parseFloat(raw) : NaN
                  const range = minMax[key] ?? { min: num, max: num }
                  const h     = hist[key] ?? []
                  return (
                    <div key={key} style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontFamily: T.fontLabel, fontSize: 12, fontWeight: 700, letterSpacing: '0.07em', color: T.muted }}>{label}</span>
                        <BigVal value={isNaN(num) ? '…' : num.toFixed(dp)} unit={group.unit} size={20} />
                      </div>
                      <Bar value={num} max={barMax} color={groupColor} />
                      <MinMaxRow min={range.min} max={range.max} unit={` ${group.unit}`} />
                      {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={groupColor} height={28} /></div>}
                    </div>
                  )
                })}
              </Card>
            )
          })}
        </div>

      </main>
    </div>
  )
}

export default App
