// src/App.tsx
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics, VICTRON_PORTAL_ID, ESS_MODES, INVERTER_MODES } from './config'
import { T } from './theme'

type MinMax = Record<string, { min: number; max: number }>
const MINMAX_TOPIC  = 'dashboard/minmax/update'
const REQUEST_TOPIC = 'dashboard/minmax/request'
const HISTORY_LENGTH = 60
const MINMAX_CACHE_KEY = 'mqtt_minmax_cache'

// ── Victron MQTT-Pfade (Venus OS MQTT-Bridge) ─────────────────────────────
// Lesen:  N/<portal-id>/<service>/<device-id>/<path>
// Schreiben: W/<portal-id>/<service>/<device-id>/<path>   Payload: {"value": x}
const V = (path: string) => `N/${VICTRON_PORTAL_ID}/${path}`
const VW = (path: string) => `W/${VICTRON_PORTAL_ID}/${path}`

const VICTRON_TOPICS = {
  // Batterie (Pylontech via VE.Can / BMS)
  soc:         V('battery/0/Soc'),
  batVoltage:  V('battery/0/Voltage'),
  batCurrent:  V('battery/0/Current'),
  batPower:    V('battery/0/Power'),
  batTemp:     V('battery/0/Temperature'),
  batState:    V('battery/0/State'),          // 0=idle 1=charging 2=discharging

  // MPPT Solarladeregler
  pvPower:     V('solarcharger/0/Yield/Power'),
  pvVoltage:   V('solarcharger/0/Pv/V'),
  pvCurrent:   V('solarcharger/0/Pv/I'),
  mpptState:   V('solarcharger/0/State'),     // 0=Off 3=Bulk 4=Absorption 5=Float

  // Wechselrichter/Charger (MultiPlus / Quattro)
  acOutPower:  V('vebus/276/Ac/Out/P'),
  acOutVoltage:V('vebus/276/Ac/Out/L1/V'),
  acOutFreq:   V('vebus/276/Ac/Out/L1/F'),
  vebusState:  V('vebus/276/VebusStatus'),    // 2=Fault 3=Bulk 4=Absorption 5=Float 9=Inverting
  vebusMode:   V('vebus/276/Mode'),           // 1=Charger 2=Inverter 3=On 4=Off

  // ESS
  essMode:     V('settings/0/Settings/CGwacs/BatteryLife/State'),
}

// MPPT-Status-Text
const mpptStateLabel = (s: number) => {
  switch (s) {
    case 0:  return 'Aus'
    case 2:  return 'Fehler'
    case 3:  return 'Bulk'
    case 4:  return 'Absorption'
    case 5:  return 'Float'
    case 7:  return 'Manuell'
    case 11: return 'Laden'
    default: return `Status ${s}`
  }
}

// Batterie-Status-Text
const batStateLabel = (s: number) => {
  switch (s) {
    case 0: return 'Bereit'
    case 1: return 'Laden'
    case 2: return 'Entladen'
    default: return `Status ${s}`
  }
}

const EXPLICIT_SUBSCRIBES = [
  'tele/Stromzähler/SENSOR',
  'tele/Balkonkraftwerk/SENSOR',
  'Pool_temp/temperatur',
  'Gaszaehler/stand',
  'stat/+/POWER',
  'stat/+/POWER1',
  MINMAX_TOPIC,
  // Victron: alle N/<portal-id>/# abonnieren
  `N/${VICTRON_PORTAL_ID}/#`,
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
function Card({ children, accentColor, highlight = false, style }: {
  children: React.ReactNode; accentColor?: string; highlight?: boolean; style?: React.CSSProperties
}) {
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
      ...style,
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }} />
      {children}
    </div>
  )
}

// ── Card Label ────────────────────────────────────────────────────────────
function CardLabel({ icon, children, color }: { icon: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
      <span style={{ fontSize: 15, lineHeight: 1, fontStyle: 'normal', textTransform: 'none', letterSpacing: 0 }}>
        {icon}
      </span>
      <span className="card-label-text" style={{
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 14, fontFamily: T.fontBody, color: T.text, minWidth: 0, wordBreak: 'break-word' }}>{label}</span>
      <div style={{ flexShrink: 0 }}>
        <ToggleBtn on={on} onClick={onClick} />
      </div>
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

// ── Badge ─────────────────────────────────────────────────────────────────
function Badge({ children, color = T.ok }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 700,
      fontFamily: T.fontLabel,
      letterSpacing: '0.05em',
      padding: '2px 7px',
      borderRadius: 3,
      background: color + '22',
      border: `1px solid ${color}55`,
      color,
    }}>
      {children}
    </span>
  )
}

// ── SOC Ring ──────────────────────────────────────────────────────────────
function SocRing({ soc, size = 52 }: { soc: number; size?: number }) {
  const r       = (size / 2) - 5
  const circ    = 2 * Math.PI * r
  const filled  = isNaN(soc) ? 0 : Math.min(100, soc)
  const offset  = circ - (filled / 100) * circ
  const color   = soc >= 60 ? T.ok : soc >= 30 ? T.warn : T.err
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={4} />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth={4}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text x={size/2} y={size/2 + 4} textAnchor="middle" fontSize={11} fill={T.text} fontWeight={700} fontFamily={T.fontMono}>
        {isNaN(soc) ? '…' : `${Math.round(soc)}%`}
      </text>
    </svg>
  )
}

// ── Divider ───────────────────────────────────────────────────────────────
function Div() {
  return <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '9px 0' }} />
}

// ── Subdim Label ─────────────────────────────────────────────────────────
function Sub({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: T.muted, marginBottom: 3, fontFamily: T.fontMono }}>{children}</div>
}

// ── Stat Row ─────────────────────────────────────────────────────────────
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 4, fontFamily: T.fontMono }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ color: T.text, fontWeight: 700 }}>{value}</span>
    </div>
  )
}

// ── ESS-Modal ─────────────────────────────────────────────────────────────
function EssModal({
  currentEssMode,
  currentInvMode,
  onSetEss,
  onSetInv,
  onClose,
}: {
  currentEssMode: number
  currentInvMode: number
  onSetEss: (v: number) => void
  onSetInv: (v: number) => void
  onClose: () => void
}) {
  const tealC = '#2dd4bf'
  return (
    <div className="ess-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ess-modal">
        {/* Accent bar */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: tealC, borderRadius: '12px 12px 0 0' }} />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚙️</span>
            <span style={{ fontFamily: T.fontLabel, fontSize: 13, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: tealC }}>
              ESS-Steuerung
            </span>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: T.muted,
            fontSize: 18, lineHeight: 1, padding: '2px 6px', borderRadius: 4,
          }}>✕</button>
        </div>

        {/* ESS-Modus */}
        <div style={{ fontFamily: T.fontLabel, fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
          ESS-Betriebsmodus
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {ESS_MODES.map(m => (
            <button
              key={m.value}
              className={`ess-mode-btn${currentEssMode === m.value ? ' active' : ''}`}
              onClick={() => onSetEss(m.value)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontFamily: T.fontMono, fontSize: 13, color: T.text, fontWeight: 700 }}>{m.label}</span>
                  <span style={{ fontFamily: T.fontMono, fontSize: 11, color: T.muted, marginLeft: 8 }}>{m.sub}</span>
                </div>
                {currentEssMode === m.value && (
                  <span style={{ color: T.accent, fontSize: 14 }}>●</span>
                )}
              </div>
            </button>
          ))}
        </div>

        <Div />

        {/* Wechselrichter-Modus */}
        <div style={{ fontFamily: T.fontLabel, fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 8, marginTop: 14 }}>
          Wechselrichter-Modus
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {INVERTER_MODES.map(m => (
            <button
              key={m.value}
              className={`ess-mode-btn${currentInvMode === m.value ? ' active' : ''}`}
              onClick={() => onSetInv(m.value)}
            >
              <div style={{ fontFamily: T.fontMono, fontSize: 12, color: T.text, fontWeight: 700 }}>{m.label}</div>
              <div style={{ fontFamily: T.fontMono, fontSize: 10, color: T.muted }}>{m.sub}</div>
              {currentInvMode === m.value && (
                <div style={{ marginTop: 4 }}><Badge color={T.accent}>aktiv</Badge></div>
              )}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: T.muted, fontFamily: T.fontMono, lineHeight: 1.5 }}>
          Änderungen werden sofort per MQTT an Venus OS gesendet.
        </div>
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
function App() {
  const [values, setValues]         = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax]         = useState<MinMax>(loadCachedMinMax)
  const [essOpen, setEssOpen]       = useState(false)
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
  client.subscribe(EXPLICIT_SUBSCRIBES, { qos: 0 })

  // WICHTIG: retained Messages erst ankommen lassen
  setTimeout(() => {
    client.publish(REQUEST_TOPIC, JSON.stringify({ ts: Date.now() }))
  }, 300)

  const keepalive = setInterval(() => {
    client.publish(`R/${VICTRON_PORTAL_ID}/system/0/Serial`, '')
  }, 30_000)

  ;(client as any)._keepalive = keepalive
})

    client.on('error', err => console.error('MQTT:', err))

    client.on('message', (topic: string, message: Buffer) => {
      const payload = message.toString()
      console.log("MQTT:", topic, payload)

      if (topic === MINMAX_TOPIC) {
        try { const d = JSON.parse(payload); setMinMax(d); saveCachedMinMax(d) } catch {}
        return
      }
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload; return
      }

      // Venus OS liefert JSON: {"value": x}
      if (topic.startsWith(`N/${VICTRON_PORTAL_ID}/`)) {
        try {
          const parsed = JSON.parse(payload)
          if (parsed && 'value' in parsed) {
            messageQueue.current[topic] = String(parsed.value)
          }
        } catch {}
        return
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
    return () => {
      clearInterval(iv)
      clearInterval((client as any)._keepalive)
      client.end(true)
    }
  }, [])

  // ── MQTT publish helper ──────────────────────────────────────────────────
  const toggle = (pub: string, cur: string) => {
    const next = cur?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({ ...prev, [pub.replace('cmnd/', 'stat/')]: next }))
    clientRef.current?.publish(pub, next)
  }

  // Venus OS Write: Payload muss JSON {"value": x} sein
  const victronWrite = (path: string, value: number) => {
    const topic = VW(path.replace(`N/${VICTRON_PORTAL_ID}/`, ''))
    clientRef.current?.publish(topic, JSON.stringify({ value }))
    // Optimistisch lokalen State aktualisieren
    setValues(prev => ({ ...prev, [`N/${VICTRON_PORTAL_ID}/${path.replace(`N/${VICTRON_PORTAL_ID}/`, '')}`]: String(value) }))
  }

  const setEssMode = (v: number) => {
    victronWrite('settings/0/Settings/CGwacs/BatteryLife/State', v)
  }
  const setInverterMode = (v: number) => {
    victronWrite('vebus/276/Mode', v)
  }

  const isOn       = (v: string) => v?.toUpperCase() === 'ON'
  const hist       = histRef.current
  const powerColor = (w: number) => w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok

  // ── Victron-Werte auslesen ───────────────────────────────────────────────
  const V_SOC         = parseFloat(values[VICTRON_TOPICS.soc]       ?? 'NaN')
  const V_BAT_V       = parseFloat(values[VICTRON_TOPICS.batVoltage] ?? 'NaN')
  const V_BAT_A       = parseFloat(values[VICTRON_TOPICS.batCurrent] ?? 'NaN')
  const V_BAT_W       = parseFloat(values[VICTRON_TOPICS.batPower]   ?? 'NaN')
  const V_BAT_T       = parseFloat(values[VICTRON_TOPICS.batTemp]    ?? 'NaN')
  const V_BAT_STATE   = parseFloat(values[VICTRON_TOPICS.batState]   ?? 'NaN')
  const V_PV_W        = parseFloat(values[VICTRON_TOPICS.pvPower]    ?? 'NaN')
  const V_PV_V        = parseFloat(values[VICTRON_TOPICS.pvVoltage]  ?? 'NaN')
  const V_PV_A        = parseFloat(values[VICTRON_TOPICS.pvCurrent]  ?? 'NaN')
  const V_MPPT_STATE  = parseFloat(values[VICTRON_TOPICS.mpptState]  ?? 'NaN')
  const V_AC_W        = parseFloat(values[VICTRON_TOPICS.acOutPower] ?? 'NaN')
  const V_AC_V        = parseFloat(values[VICTRON_TOPICS.acOutVoltage]?? 'NaN')
  const V_AC_F        = parseFloat(values[VICTRON_TOPICS.acOutFreq]  ?? 'NaN')
  const V_VEBUS_STATE = parseFloat(values[VICTRON_TOPICS.vebusState] ?? 'NaN')
  const V_INV_MODE    = parseFloat(values[VICTRON_TOPICS.vebusMode]  ?? 'NaN')
  const V_ESS_MODE    = parseFloat(values[VICTRON_TOPICS.essMode]    ?? 'NaN')

  // Balkon-BKW Erzeugung
  const BKW_W = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'] ?? 'NaN')

  // Kombinierte Gesamterzeugung = Balkon + Victron-PV
  const totalGen = (!isNaN(BKW_W) ? BKW_W : 0) + (!isNaN(V_PV_W) ? V_PV_W : 0)

  // Verbrauch
  const verbrauch = parseFloat(values['tele/Stromzähler/SENSOR.grid.sml_m'] ?? 'NaN')

  // Überschuss (positiv = Einspeisung / Überschuss)
  const ueberschuss = totalGen - verbrauch

  // Farben
  const socColor       = V_SOC >= 60 ? T.ok : V_SOC >= 30 ? T.warn : T.err
  const pvColor        = V_PV_W >= 800 ? T.ok : V_PV_W >= 300 ? T.warn : T.muted
  const tealAcc        = '#2dd4bf'
  const amberAcc       = '#fbbf24'
  const purpleAcc      = '#c084fc'
  const genColor       = totalGen >= 500 ? T.ok : totalGen >= 200 ? T.warn : T.muted
  const uebColor       = ueberschuss >= 0 ? T.ok : T.err

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: T.fontBody }}>

      {/* ── Header ── */}
      <header className="dash-header" style={{
        background: T.surf,
        borderBottom: `2px solid ${T.accent}`,
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text, opacity: 0.75 }}>
            MQTT Dashboard
          </span>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: lastUpdate ? T.ok : T.warn, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontFamily: T.fontLabel, color: lastUpdate ? T.ok : T.warn, whiteSpace: 'nowrap' }}>
            {lastUpdate ? 'verbunden' : 'verbinde…'}
          </span>
        </div>
        <span style={{ fontFamily: T.fontMono, color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
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

          {/* Strom — Verbrauch + kombinierte Erzeugung */}
          <Card accentColor={T.err}>
            <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
            {/* Verbrauch */}
            {(() => {
              const key   = 'tele/Stromzähler/SENSOR.grid.sml_m'
              const num   = parseFloat(values[key])
              const range = minMax[key] ?? { min: num, max: num }
              const h     = hist[key] ?? []
              const col   = powerColor(num)
              return <>
                <Sub>Verbrauch</Sub>
                <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={22} />
                <Bar value={num} max={range.max > 0 ? range.max : 2000} color={col} />
                <MinMaxRow min={range.min} max={range.max} unit=" W" />
                {h.length >= 2 && <div style={{ marginTop: 5 }}><Sparkline data={h} color={col} /></div>}
              </>
            })()}
            <Div />
            {/* Kombinierte Erzeugung */}
            <Sub>Erzeugung gesamt</Sub>
            <BigVal value={totalGen > 0 || !isNaN(BKW_W) ? `${Math.round(totalGen)}` : '…'} unit="W" size={22} />
            <Bar value={totalGen} max={2000} color={genColor} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginTop: 3, fontFamily: T.fontMono }}>
              <span>Balkon: {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}</span>
              <span>PV: {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`}</span>
            </div>
            {/* Überschuss */}
            {!isNaN(verbrauch) && !isNaN(totalGen) && (
              <div style={{ marginTop: 6, fontSize: 12, color: uebColor, fontFamily: T.fontMono, fontWeight: 700 }}>
                {ueberschuss >= 0 ? `+${Math.round(ueberschuss)} W Überschuss` : `${Math.round(ueberschuss)} W Defizit`}
              </div>
            )}
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

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* ── Victron-Sektion ──────────────────────────────────────────── */}
        {/* ════════════════════════════════════════════════════════════════ */}
        <div className="victron-section">

          {/* ── Energiefluss-Banner ── */}
          <div className="victron-flow-banner">
            <Card accentColor={tealAcc}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <CardLabel icon="⚡" color={tealAcc}>Energiefluss · Victron</CardLabel>
                {/* ESS-Steuerung Button */}
                <button
                  onClick={() => setEssOpen(true)}
                  style={{
                    padding: '5px 14px',
                    borderRadius: T.btnRadius,
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: T.fontLabel,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    border: `1px solid ${tealAcc}55`,
                    background: tealAcc + '18',
                    color: tealAcc,
                    transition: 'all 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  ⚙️ ESS-Steuerung
                </button>
              </div>

              <div className="flow-row">
                {/* PV Victron */}
                <div className="flow-node">
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>PV · Victron</span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: T.fontMono, color: isNaN(V_PV_W) ? T.muted : pvColor }}>
                    {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`}
                  </span>
                  {!isNaN(V_MPPT_STATE) && (
                    <span style={{ marginTop: 3 }}><Badge color={V_PV_W > 0 ? T.ok : T.muted}>{mpptStateLabel(V_MPPT_STATE)}</Badge></span>
                  )}
                </div>

                <div className="flow-arrow">+</div>

                {/* Balkon BKW */}
                <div className="flow-node">
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Balkonkraftwerk</span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: T.fontMono, color: isNaN(BKW_W) ? T.muted : (BKW_W >= 200 ? T.ok : T.warn) }}>
                    {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}
                  </span>
                </div>

                <div className="flow-arrow">=</div>

                {/* Gesamterzeugung */}
                <div className="flow-node" style={{ border: `1px solid ${genColor}44`, borderRadius: 6 }}>
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Erzeugung gesamt</span>
                  <span style={{ fontSize: 20, fontWeight: 700, fontFamily: T.fontMono, color: genColor }}>
                    {`${Math.round(totalGen)} W`}
                  </span>
                </div>

                <div className="flow-arrow">→</div>

                {/* Verbrauch */}
                <div className="flow-node">
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Verbrauch</span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: T.fontMono, color: powerColor(verbrauch) }}>
                    {isNaN(verbrauch) ? '…' : `${Math.round(verbrauch)} W`}
                  </span>
                </div>

                <div className="flow-arrow">→</div>

                {/* Überschuss / Defizit */}
                <div className="flow-node" style={{ border: `1px solid ${uebColor}44`, borderRadius: 6 }}>
                  <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>
                    {ueberschuss >= 0 ? 'Überschuss' : 'Defizit'}
                  </span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: T.fontMono, color: uebColor }}>
                    {isNaN(verbrauch) || isNaN(totalGen) ? '…' : `${ueberschuss >= 0 ? '+' : ''}${Math.round(ueberschuss)} W`}
                  </span>
                </div>
              </div>
            </Card>
          </div>

          {/* ── Victron-Grid: Batterie · MPPT · Wechselrichter ── */}
          <div className="grid-victron">

            {/* Batterie */}
            <Card accentColor={socColor}>
              <CardLabel icon="🔋" color={socColor}>Batterie · Pylontech</CardLabel>
              <div className="soc-wrap" style={{ marginBottom: 10 }}>
                <SocRing soc={V_SOC} size={56} />
                <div>
                  <BigVal value={isNaN(V_BAT_V) ? '…' : V_BAT_V.toFixed(1)} unit="V" size={20} />
                  <div style={{ marginTop: 4, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {!isNaN(V_BAT_STATE) && (
                      <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>
                        {batStateLabel(V_BAT_STATE)}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              <Div />
              <StatRow label="Strom"   value={isNaN(V_BAT_A) ? '…' : `${V_BAT_A.toFixed(1)} A`} />
              <StatRow label="Leistung" value={isNaN(V_BAT_W) ? '…' : `${Math.round(V_BAT_W)} W`} />
              <StatRow label="Temp"    value={isNaN(V_BAT_T) ? '…' : `${V_BAT_T.toFixed(1)} °C`} />
              {!isNaN(V_SOC) && (
                <>
                  <Bar value={V_SOC} max={100} color={socColor} />
                  <MinMaxRow
                    min={minMax[VICTRON_TOPICS.soc]?.min ?? V_SOC}
                    max={minMax[VICTRON_TOPICS.soc]?.max ?? V_SOC}
                    unit=" %"
                  />
                </>
              )}
              {(hist[VICTRON_TOPICS.soc] ?? []).length >= 2 && (
                <div style={{ marginTop: 5 }}>
                  <Sparkline data={hist[VICTRON_TOPICS.soc]} color={socColor} />
                </div>
              )}
            </Card>

            {/* MPPT */}
            <Card accentColor={amberAcc}>
              <CardLabel icon="☀️" color={amberAcc}>MPPT · Solarladeregler</CardLabel>
              <BigVal value={isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)}`} unit="W" size={22} />
              <Sub>PV-Eingangsleistung</Sub>
              {!isNaN(V_PV_W) && (
                <>
                  <Bar value={V_PV_W} max={Math.max(minMax[VICTRON_TOPICS.pvPower]?.max ?? 0, 1500)} color={amberAcc} />
                  <MinMaxRow
                    min={minMax[VICTRON_TOPICS.pvPower]?.min ?? V_PV_W}
                    max={minMax[VICTRON_TOPICS.pvPower]?.max ?? V_PV_W}
                    unit=" W"
                  />
                </>
              )}
              {(hist[VICTRON_TOPICS.pvPower] ?? []).length >= 2 && (
                <div style={{ marginTop: 5 }}>
                  <Sparkline data={hist[VICTRON_TOPICS.pvPower]} color={amberAcc} />
                </div>
              )}
              <Div />
              <StatRow label="PV Spannung" value={isNaN(V_PV_V) ? '…' : `${V_PV_V.toFixed(0)} V`} />
              <StatRow label="PV Strom"    value={isNaN(V_PV_A) ? '…' : `${V_PV_A.toFixed(1)} A`} />
              <StatRow label="Status"      value={isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)} />
            </Card>

            {/* Wechselrichter */}
            <Card accentColor={purpleAcc}>
              <CardLabel icon="🔌" color={purpleAcc}>Wechselrichter · MultiPlus</CardLabel>
              <BigVal value={isNaN(V_AC_W) ? '…' : `${Math.round(V_AC_W)}`} unit="W" size={22} />
              <Sub>AC-Ausgangsleistung</Sub>
              {!isNaN(V_AC_W) && (
                <>
                  <Bar value={V_AC_W} max={Math.max(minMax[VICTRON_TOPICS.acOutPower]?.max ?? 0, 2000)} color={purpleAcc} />
                  <MinMaxRow
                    min={minMax[VICTRON_TOPICS.acOutPower]?.min ?? V_AC_W}
                    max={minMax[VICTRON_TOPICS.acOutPower]?.max ?? V_AC_W}
                    unit=" W"
                  />
                </>
              )}
              {(hist[VICTRON_TOPICS.acOutPower] ?? []).length >= 2 && (
                <div style={{ marginTop: 5 }}>
                  <Sparkline data={hist[VICTRON_TOPICS.acOutPower]} color={purpleAcc} />
                </div>
              )}
              <Div />
              <StatRow label="Spannung"  value={isNaN(V_AC_V) ? '…' : `${V_AC_V.toFixed(0)} V`} />
              <StatRow label="Frequenz"  value={isNaN(V_AC_F) ? '…' : `${V_AC_F.toFixed(1)} Hz`} />
              <StatRow label="Modus"     value={
                isNaN(V_INV_MODE) ? '…' : (INVERTER_MODES.find(m => m.value === V_INV_MODE)?.label ?? `Mode ${V_INV_MODE}`)
              } />
              {!isNaN(V_VEBUS_STATE) && (
                <div style={{ marginTop: 6 }}>
                  <Badge color={V_VEBUS_STATE === 9 ? T.ok : V_VEBUS_STATE === 2 ? T.err : amberAcc}>
                    {V_VEBUS_STATE === 9 ? 'Inverting' : V_VEBUS_STATE === 3 ? 'Bulk' : V_VEBUS_STATE === 4 ? 'Absorption' : V_VEBUS_STATE === 5 ? 'Float' : `Status ${V_VEBUS_STATE}`}
                  </Badge>
                </div>
              )}
            </Card>

          </div>
        </div>
        {/* ════════════════════════════════════════════════════════════════ */}

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

      {/* ── ESS-Modal ── */}
      {essOpen && (
        <EssModal
          currentEssMode={isNaN(V_ESS_MODE) ? -1 : V_ESS_MODE}
          currentInvMode={isNaN(V_INV_MODE) ? -1 : V_INV_MODE}
          onSetEss={v => { setEssMode(v); }}
          onSetInv={v => { setInverterMode(v); }}
          onClose={() => setEssOpen(false)}
        />
      )}
    </div>
  )
}

export default App
