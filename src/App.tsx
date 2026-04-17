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

const V  = (path: string) => `N/${VICTRON_PORTAL_ID}/${path}`
const VW = (path: string) => `W/${VICTRON_PORTAL_ID}/${path}`

const VICTRON_TOPICS = {
  soc:         V('system/0/Dc/Battery/Soc'),
  batVoltage:  V('system/0/Dc/Battery/Voltage'),
  batCurrent:  V('system/0/Dc/Battery/Current'),
  batPower:    V('system/0/Dc/Battery/Power'),
  batTemp:     V('system/0/Dc/Battery/Temperature'),
  batState:    V('system/0/Dc/Battery/State'),
  pvPower:     V('solarcharger/288/Yield/Power'),
  pvVoltage:   V('solarcharger/288/Pv/V'),
  pvCurrent:   V('solarcharger/288/Pv/I'),
  mpptState:   V('solarcharger/288/State'),
  acOutPower:  V('vebus/288/Ac/Out/P'),
  acOutVoltage:V('vebus/288/Ac/Out/L1/V'),
  acOutFreq:   V('vebus/288/Ac/Out/L1/F'),
  vebusState:  V('vebus/288/VebusStatus'),
  vebusMode:   V('vebus/288/Mode'),
  essMode:     V('settings/0/Settings/CGwacs/BatteryLife/State'),
}

const mpptStateLabel = (s: number) => {
  switch (s) {
    case 0:   return 'Aus'
    case 2:   return 'Fehler'
    case 3:   return 'Bulk'
    case 4:   return 'Absorption'
    case 5:   return 'Float'
    case 7:   return 'Manuell'
    case 11:  return 'Laden'
    case 245: return 'Starten'
    case 247: return 'Laden'
    case 252: return 'Ext. Steuerung'
    default:  return `Status ${s}`
  }
}
const batStateLabel = (s: number) => {
  switch (s) {
    case 0: return 'Bereit'; case 1: return 'Laden'; case 2: return 'Entladen'
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
  'Stromzähler/#',
  `N/${VICTRON_PORTAL_ID}/#`,
]

function loadCachedMinMax(): MinMax {
  try { const r = localStorage.getItem(MINMAX_CACHE_KEY); return r ? JSON.parse(r) : {} } catch { return {} }
}
function saveCachedMinMax(data: MinMax) {
  try { localStorage.setItem(MINMAX_CACHE_KEY, JSON.stringify(data)) } catch {}
}

// ── Sparkline ────────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 28 }: { data: number[]; color: string; height?: number }) {
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

// ── Card ─────────────────────────────────────────────────────────────────
function Card({ children, accentColor, style }: {
  children: React.ReactNode; accentColor?: string; style?: React.CSSProperties
}) {
  const color = accentColor ?? T.accent
  return (
    <div style={{
      background: T.surf, border: `1px solid ${color}28`,
      borderRadius: T.radius, padding: '11px 13px', height: '100%', ...style,
    }}>
      {children}
    </div>
  )
}

// ── Pill Label ───────────────────────────────────────────────────────────
function CardLabel({ icon, children, color }: { icon: string; children: React.ReactNode; color?: string }) {
  const c = color ?? T.accent
  return (
    <div className="pill-label" style={{ background: c + '18', color: c }}>
      {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
      <span className="card-label-text">{children}</span>
    </div>
  )
}

// ── Bar ──────────────────────────────────────────────────────────────────
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, max > 0 ? (Math.abs(value) / max) * 100 : 0)
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 2, height: 3, marginTop: 6, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ── MinMax kompakt ───────────────────────────────────────────────────────
function MinMaxRow({ min, max, unit }: { min: number; max: number; unit?: string }) {
  return (
    <div className="minmax-compact">
      Min: {min?.toFixed(1)}{unit} · Max: {max?.toFixed(1)}{unit}
    </div>
  )
}

// ── Toggle Button ────────────────────────────────────────────────────────
function ToggleBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '3px 11px', borderRadius: T.btnRadius, fontSize: 11, fontWeight: 700,
      fontFamily: T.fontLabel, cursor: 'pointer',
      border: `1px solid ${on ? T.ok + '55' : T.err + '55'}`,
      background: on ? T.ok + '20' : T.err + '20',
      color: on ? T.ok : T.err,
      letterSpacing: '0.05em', transition: 'all 0.15s', whiteSpace: 'nowrap',
    }}>
      {on ? 'AN' : 'AUS'}
    </button>
  )
}

// ── Switch Row ───────────────────────────────────────────────────────────
function SwitchRow({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 13, fontFamily: T.fontBody, color: T.text, minWidth: 0, wordBreak: 'break-word' }}>{label}</span>
      <div style={{ flexShrink: 0 }}><ToggleBtn on={on} onClick={onClick} /></div>
    </div>
  )
}

// ── BigVal ───────────────────────────────────────────────────────────────
function BigVal({ value, unit, size = 20, color }: { value: string; unit?: string; size?: number; color?: string }) {
  return (
    <div style={{ fontFamily: T.fontMono, fontSize: size, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15, color: color ?? T.text }}>
      {value}
      {unit && <span style={{ fontSize: size * 0.6, fontWeight: 400, color: T.muted, marginLeft: 2 }}>{unit}</span>}
    </div>
  )
}

// ── Badge ────────────────────────────────────────────────────────────────
function Badge({ children, color = T.ok }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, fontWeight: 700, fontFamily: T.fontLabel,
      letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3,
      background: color + '20', border: `1px solid ${color}44`, color,
    }}>
      {children}
    </span>
  )
}

// ── SOC Ring ─────────────────────────────────────────────────────────────
function SocRing({ soc, size = 52 }: { soc: number; size?: number }) {
  const r = (size / 2) - 5
  const circ = 2 * Math.PI * r
  const filled = isNaN(soc) ? 0 : Math.min(100, soc)
  const offset = circ - (filled / 100) * circ
  const color = soc >= 60 ? T.ok : soc >= 30 ? T.warn : T.err
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={4}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x={size/2} y={size/2 + 4} textAnchor="middle" fontSize={11} fill={T.text} fontWeight={700} fontFamily={T.fontMono}>
        {isNaN(soc) ? '…' : `${Math.round(soc)}%`}
      </text>
    </svg>
  )
}

function Div() { return <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '8px 0' }} /> }
function Sub({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: T.muted, marginBottom: 2, fontFamily: T.fontMono }}>{children}</div>
}
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11, marginBottom: 4, fontFamily: T.fontMono }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ color: T.text, fontWeight: 700 }}>{value}</span>
    </div>
  )
}

// ── Farben ───────────────────────────────────────────────────────────────
function leistungColor(w: number): string {
  if (w < 0) return T.ok
  return w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok
}
function phasenColor(w: number): string {
  if (isNaN(w))  return T.muted
  if (w < 0)     return T.ok
  if (w >= 1500) return T.err
  if (w >= 500)  return T.warn
  return T.spark.power
}

// ── Phasen-Card (wiederverwendbar) ───────────────────────────────────────
function PhasenCard({ group, values, minMax, hist }: {
  group: typeof topics[0]; values: Record<string, string>
  minMax: MinMax; hist: Record<string, number[]>
}) {
  const isSpan   = group.label.includes('Spannung')
  const isStromG = group.label.includes('Strom L')
  const isLeist  = group.label.includes('Leistung')
  const groupColor = isSpan ? T.spark.purple : isStromG ? T.spark.orange : T.spark.power
  const barMax   = isSpan ? 250 : isStromG ? 20 : 3000
  const dp       = isSpan ? 0 : 1
  return (
    <Card accentColor={groupColor}>
      <CardLabel icon="" color={groupColor}>{group.label}</CardLabel>
      {group.keys?.map(({ label, key }) => {
        const raw      = values[key]
        const num      = raw !== undefined ? parseFloat(raw) : NaN
        const range    = minMax[key] ?? { min: num, max: num }
        const h        = hist[key] ?? []
        const valColor = isLeist ? phasenColor(num) : groupColor
        return (
          <div key={key} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <span style={{ fontFamily: T.fontLabel, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: groupColor, minWidth: 28 }}>{label}</span>
              <span style={{ fontFamily: T.fontMono, fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1, color: valColor }}>
                {isNaN(num) ? '…' : num.toFixed(dp)}
                <span style={{ fontSize: 13, fontWeight: 400, color: T.muted, marginLeft: 3 }}>{group.unit}</span>
              </span>
            </div>
            <Bar value={num} max={barMax} color={valColor} />
            <MinMaxRow min={range.min} max={range.max} unit={` ${group.unit}`} />
            {h.length >= 2 && <div style={{ marginTop: 5 }}><Sparkline data={h} color={valColor} height={30} /></div>}
          </div>
        )
      })}
    </Card>
  )
}

// ── ESS-Modal ────────────────────────────────────────────────────────────
function EssModal({ currentEssMode, currentInvMode, onSetEss, onSetInv, onClose }: {
  currentEssMode: number; currentInvMode: number
  onSetEss: (v: number) => void; onSetInv: (v: number) => void; onClose: () => void
}) {
  const tealC = '#2dd4bf'
  return (
    <div className="ess-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ess-modal">
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: tealC, borderRadius: '12px 12px 0 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15 }}>⚙️</span>
            <span style={{ fontFamily: T.fontLabel, fontSize: 12, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: tealC }}>ESS-Steuerung</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 18, lineHeight: 1, padding: '2px 6px' }}>✕</button>
        </div>
        <div style={{ fontFamily: T.fontLabel, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 7 }}>ESS-Betriebsmodus</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
          {ESS_MODES.map(m => (
            <button key={m.value} className={`ess-mode-btn${currentEssMode === m.value ? ' active' : ''}`} onClick={() => onSetEss(m.value)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontFamily: T.fontMono, fontSize: 12, color: T.text, fontWeight: 700 }}>{m.label}</span>
                  <span style={{ fontFamily: T.fontMono, fontSize: 10, color: T.muted, marginLeft: 7 }}>{m.sub}</span>
                </div>
                {currentEssMode === m.value && <span style={{ color: T.accent, fontSize: 13 }}>●</span>}
              </div>
            </button>
          ))}
        </div>
        <Div />
        <div style={{ fontFamily: T.fontLabel, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 7, marginTop: 12 }}>Wechselrichter-Modus</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {INVERTER_MODES.map(m => (
            <button key={m.value} className={`ess-mode-btn${currentInvMode === m.value ? ' active' : ''}`} onClick={() => onSetInv(m.value)}>
              <div style={{ fontFamily: T.fontMono, fontSize: 12, color: T.text, fontWeight: 700 }}>{m.label}</div>
              <div style={{ fontFamily: T.fontMono, fontSize: 10, color: T.muted }}>{m.sub}</div>
              {currentInvMode === m.value && <div style={{ marginTop: 3 }}><Badge color={T.accent}>aktiv</Badge></div>}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 14, fontSize: 10, color: T.muted, fontFamily: T.fontMono, lineHeight: 1.5 }}>Änderungen werden sofort per MQTT an Venus OS gesendet.</div>
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
type Tab = 'uebersicht' | 'energie' | 'victron' | 'steuerung'

function App() {
  const [values, setValues]         = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax]         = useState<MinMax>(loadCachedMinMax)
  const [essOpen, setEssOpen]       = useState(false)
  const [activeTab, setActiveTab]   = useState<Tab>('uebersicht')
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
      const sendKeepalive = () => { client.publish(`R/${VICTRON_PORTAL_ID}/system/0/Serial`, '') }
      sendKeepalive()
      setTimeout(() => { client.publish(REQUEST_TOPIC, JSON.stringify({ ts: Date.now() })) }, 500)
      const keepalive = setInterval(sendKeepalive, 30_000)
      ;(client as any)._keepalive = keepalive
    })

    client.on('error', err => console.error('MQTT:', err))

    client.on('message', (topic: string, message: Buffer) => {
      const payload = message.toString().trim()
      if (topic === MINMAX_TOPIC) {
        try { const d = JSON.parse(payload); setMinMax(d); saveCachedMinMax(d) } catch {} ; return
      }
      if (topic === 'Pool_temp/temperatur' || topic === 'Gaszaehler/stand') {
        messageQueue.current[topic] = payload; return
      }
      if (topic.startsWith('Stromzähler/')) {
        messageQueue.current[topic] = payload; return
      }
      if (topic.startsWith(`N/${VICTRON_PORTAL_ID}/`)) {
        try {
          const parsed = JSON.parse(payload)
          if (parsed && 'value' in parsed) messageQueue.current[topic] = String(parsed.value)
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
        if (!h[key]) h[key] = Array(Math.min(HISTORY_LENGTH, 10)).fill(n)
        else if (h[key].length >= HISTORY_LENGTH) h[key] = [...h[key].slice(1), n]
        else h[key].push(n)
      }
      setValues(prev => ({ ...prev, ...updates }))
      setLastUpdate(new Date().toLocaleTimeString())
    }

    const iv = setInterval(flush, 150)
    return () => { clearInterval(iv); clearInterval((client as any)._keepalive); client.end(true) }
  }, [])

  const toggle = (pub: string, cur: string) => {
    const next = cur?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    setValues(prev => ({ ...prev, [pub.replace('cmnd/', 'stat/')]: next }))
    clientRef.current?.publish(pub, next)
  }
  const victronWrite = (path: string, value: number) => {
    const topic = VW(path.replace(`N/${VICTRON_PORTAL_ID}/`, ''))
    clientRef.current?.publish(topic, JSON.stringify({ value }))
    setValues(prev => ({ ...prev, [`N/${VICTRON_PORTAL_ID}/${path.replace(`N/${VICTRON_PORTAL_ID}/`, '')}`]: String(value) }))
  }
  const setEssMode      = (v: number) => victronWrite('settings/0/Settings/CGwacs/BatteryLife/State', v)
  const setInverterMode = (v: number) => victronWrite('vebus/288/Mode', v)

  const isOn = (v: string) => v?.toUpperCase() === 'ON'
  const hist = histRef.current

  const V_SOC         = parseFloat(values[VICTRON_TOPICS.soc]        ?? 'NaN')
  const V_BAT_V       = parseFloat(values[VICTRON_TOPICS.batVoltage]  ?? 'NaN')
  const V_BAT_A       = parseFloat(values[VICTRON_TOPICS.batCurrent]  ?? 'NaN')
  const V_BAT_W       = parseFloat(values[VICTRON_TOPICS.batPower]    ?? 'NaN')
  const V_BAT_T       = parseFloat(values[VICTRON_TOPICS.batTemp]     ?? 'NaN')
  const V_BAT_STATE   = parseFloat(values[VICTRON_TOPICS.batState]    ?? 'NaN')
  const V_PV_W        = parseFloat(values[VICTRON_TOPICS.pvPower]     ?? 'NaN')
  const V_PV_V        = parseFloat(values[VICTRON_TOPICS.pvVoltage]   ?? 'NaN')
  const V_PV_A        = parseFloat(values[VICTRON_TOPICS.pvCurrent]   ?? 'NaN')
  const V_MPPT_STATE  = parseFloat(values[VICTRON_TOPICS.mpptState]   ?? 'NaN')
  const V_AC_W        = parseFloat(values[VICTRON_TOPICS.acOutPower]  ?? 'NaN')
  const V_AC_V        = parseFloat(values[VICTRON_TOPICS.acOutVoltage]?? 'NaN')
  const V_AC_F        = parseFloat(values[VICTRON_TOPICS.acOutFreq]   ?? 'NaN')
  const V_VEBUS_STATE = parseFloat(values[VICTRON_TOPICS.vebusState]  ?? 'NaN')
  const V_INV_MODE    = parseFloat(values[VICTRON_TOPICS.vebusMode]   ?? 'NaN')
  const V_ESS_MODE    = parseFloat(values[VICTRON_TOPICS.essMode]     ?? 'NaN')

  const BKW_W         = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'] ?? 'NaN')
  const totalGen      = (!isNaN(BKW_W) ? BKW_W : 0) + (!isNaN(V_PV_W) ? V_PV_W : 0)
  const netzAustausch = parseFloat(values['Stromzähler/Verbrauch_aktuell'] ?? 'NaN')
  const consL1        = parseFloat(values[V('system/0/Ac/Consumption/L1/Power')] ?? '0')
  const consL2        = parseFloat(values[V('system/0/Ac/Consumption/L2/Power')] ?? '0')
  const consL3        = parseFloat(values[V('system/0/Ac/Consumption/L3/Power')] ?? '0')
  const hausverbrauch = (!isNaN(consL1) ? consL1 : 0) + (!isNaN(consL2) ? consL2 : 0) + (!isNaN(consL3) ? consL3 : 0)
  const verbrauch     = netzAustausch
  const ueberschuss   = totalGen - hausverbrauch

  const socColor  = V_SOC >= 60 ? T.ok : V_SOC >= 30 ? T.warn : T.err
  const pvColor   = V_PV_W >= 800 ? T.ok : V_PV_W >= 300 ? T.warn : T.muted
  const tealAcc   = '#2dd4bf'
  const amberAcc  = '#fbbf24'
  const purpleAcc = '#c084fc'
  const genColor  = totalGen >= 500 ? T.ok : totalGen >= 200 ? T.warn : T.muted
  const uebColor  = ueberschuss >= 0 ? T.ok : T.err

  const groupTopics = topics.filter(t => t.type === 'group')

  // ── Tab-Definitionen ────────────────────────────────────────────────────
  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'uebersicht', label: 'Übersicht',  icon: '⚡' },
    { id: 'energie',    label: 'Energie',    icon: '🌿' },
    { id: 'victron',    label: 'Victron',    icon: '🔋' },
    { id: 'steuerung',  label: 'Steuerung',  icon: '🔌' },
  ]

  // ── Energiefluss-Banner (geteilt zwischen Übersicht + Energie) ──────────
  const FlowBanner = () => (
    <div className="victron-flow-banner">
      <Card accentColor={tealAcc}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 0 }}>
          <CardLabel icon="⚡" color={tealAcc}>Energiefluss · Victron</CardLabel>
          <button onClick={() => setEssOpen(true)} style={{
            padding: '4px 12px', borderRadius: T.btnRadius, fontSize: 10, fontWeight: 700,
            fontFamily: T.fontLabel, letterSpacing: '0.06em', textTransform: 'uppercase',
            cursor: 'pointer', border: `1px solid ${tealAcc}44`, background: tealAcc + '15',
            color: tealAcc, transition: 'all 0.15s', whiteSpace: 'nowrap',
          }}>⚙️ ESS-Steuerung</button>
        </div>
        <div className="flow-row">
          <div className="flow-node">
            <span style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>PV · Victron</span>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: T.fontMono, color: isNaN(V_PV_W) ? T.muted : pvColor }}>
              {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`}
            </span>
            {!isNaN(V_MPPT_STATE) && <span style={{ marginTop: 2 }}><Badge color={V_PV_W > 0 ? T.ok : T.muted}>{mpptStateLabel(V_MPPT_STATE)}</Badge></span>}
          </div>
          <div className="flow-arrow">+</div>
          <div className="flow-node">
            <span style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>Balkonkraftwerk</span>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: T.fontMono, color: isNaN(BKW_W) ? T.muted : (BKW_W >= 200 ? T.ok : T.warn) }}>
              {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}
            </span>
          </div>
          <div className="flow-arrow">=</div>
          <div className="flow-node" style={{ border: `1px solid ${genColor}33`, borderRadius: 5 }}>
            <span style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>Erzeugung</span>
            <span style={{ fontSize: 18, fontWeight: 700, fontFamily: T.fontMono, color: genColor }}>{`${Math.round(totalGen)} W`}</span>
          </div>
          <div className="flow-arrow">→</div>
          <div className="flow-node">
            <span style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>Verbrauch</span>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: T.fontMono, color: leistungColor(hausverbrauch) }}>
              {hausverbrauch === 0 && isNaN(consL1) ? '…' : `${Math.round(hausverbrauch)} W`}
            </span>
          </div>
          <div className="flow-arrow">→</div>
          {(() => {
            const netzColor = isNaN(netzAustausch) ? T.muted : netzAustausch > 0 ? T.err : T.ok
            return (
              <div className="flow-node" style={{ border: `1px solid ${netzColor}33`, borderRadius: 5 }}>
                <span style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>
                  {isNaN(netzAustausch) ? 'Netz' : netzAustausch > 0 ? 'Netzbezug' : 'Einspeisung'}
                </span>
                <span style={{ fontSize: 16, fontWeight: 700, fontFamily: T.fontMono, color: netzColor }}>
                  {isNaN(netzAustausch) ? '…' : `${netzAustausch > 0 ? '+' : ''}${Math.round(netzAustausch)} W`}
                </span>
              </div>
            )
          })()}
        </div>
      </Card>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: T.fontBody }}>

      {/* Header */}
      <header className="dash-header" style={{ background: T.surf, borderBottom: `1px solid ${T.accent}33`, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text, opacity: 0.7 }}>MQTT Dashboard</span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: lastUpdate ? T.ok : T.warn, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontFamily: T.fontLabel, color: lastUpdate ? T.ok : T.warn, whiteSpace: 'nowrap', fontSize: 11 }}>
            {lastUpdate ? 'verbunden' : 'verbinde…'}
          </span>
        </div>
        <span style={{ fontFamily: T.fontMono, color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: 11 }}>
          {lastUpdate ? `Letztes Update: ${lastUpdate}` : ''}
        </span>
      </header>

      {/* Pill Navigation */}
      <nav style={{
        display: 'flex', gap: 6, padding: '9px 14px', flexWrap: 'wrap',
        background: T.bg, borderBottom: `1px solid rgba(255,255,255,0.05)`,
        position: 'sticky', top: 37, zIndex: 9,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '5px 14px', borderRadius: 20, fontSize: 11,
              letterSpacing: '0.07em', cursor: 'pointer', whiteSpace: 'nowrap',
              fontFamily: T.fontLabel, fontWeight: 700, transition: 'all 0.15s',
              border: activeTab === tab.id
                ? `1px solid ${T.accent}88`
                : '1px solid rgba(255,255,255,0.1)',
              background: activeTab === tab.id ? T.accent + '20' : 'transparent',
              color: activeTab === tab.id ? T.accent : T.muted,
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>

      <main style={{ padding: '10px 14px 40px' }}>

        {/* ══ TAB: ÜBERSICHT ══════════════════════════════════════════════ */}
        {activeTab === 'uebersicht' && (
          <>
            <FlowBanner />
            <div className="grid-top" style={{ marginBottom: 8 }}>

              {/* Batterie (Kurzform) */}
              <Card accentColor={socColor}>
                <CardLabel icon="🔋" color={socColor}>Batterie · Pylontech</CardLabel>
                <div className="soc-wrap" style={{ marginBottom: 6 }}>
                  <SocRing soc={V_SOC} size={50} />
                  <div>
                    <BigVal value={isNaN(V_BAT_V) ? '…' : V_BAT_V.toFixed(1)} unit="V" size={18} />
                    <div style={{ marginTop: 3 }}>
                      {!isNaN(V_BAT_STATE) && (
                        <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>
                          {batStateLabel(V_BAT_STATE)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <StatRow label="Temp" value={isNaN(V_BAT_T) ? '…' : `${V_BAT_T.toFixed(1)} °C`} />
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <span style={{ fontSize: 14 }}>🌡️</span>
                      <BigVal value={isNaN(val) ? '…' : `${val}`} unit="°C" size={17} color={col} />
                    </div>
                    <Bar value={val} max={40} color={col} />
                    <MinMaxRow min={range.min} max={range.max} unit=" °C" />
                    {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} /></div>}
                  </>
                })()}
              </Card>

              {/* Strom */}
              <Card accentColor={T.err}>
                <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
                {(() => {
                  const key   = 'Stromzähler/Verbrauch_aktuell'
                  const num   = parseFloat(values[key])
                  const range = minMax[key] ?? { min: num, max: num }
                  const h     = hist[key] ?? []
                  const col   = leistungColor(num)
                  return <>
                    <Sub>Netzbezug/-einspeisung</Sub>
                    <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={21} color={col} />
                    <Bar value={num} max={Math.abs(range.max) > 0 ? Math.abs(range.max) : 2000} color={col} />
                    <MinMaxRow min={range.min} max={range.max} unit=" W" />
                    {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} /></div>}
                  </>
                })()}
                <Div />
                <Sub>Erzeugung gesamt</Sub>
                <BigVal value={totalGen > 0 || !isNaN(BKW_W) ? `${Math.round(totalGen)}` : '…'} unit="W" size={21} color={genColor} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginTop: 3, fontFamily: T.fontMono }}>
                  <span>Balkon: {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}</span>
                  <span>PV: {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`}</span>
                </div>
                {!isNaN(verbrauch) && !isNaN(totalGen) && (
                  <div style={{ marginTop: 5, fontSize: 11, color: uebColor, fontFamily: T.fontMono, fontWeight: 700 }}>
                    {ueberschuss >= 0 ? `+${Math.round(ueberschuss)} W Überschuss` : `${Math.round(ueberschuss)} W Defizit`}
                  </div>
                )}
              </Card>

              {/* MPPT Kurzform */}
              <Card accentColor={amberAcc}>
                <CardLabel icon="☀️" color={amberAcc}>MPPT · SmartSolar</CardLabel>
                <BigVal value={isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)}`} unit="W" size={21} color={isNaN(V_PV_W) ? T.muted : amberAcc} />
                <Sub>PV-Eingangsleistung</Sub>
                <Div />
                <StatRow label="PV Spannung" value={isNaN(V_PV_V) ? '…' : `${V_PV_V.toFixed(0)} V`} />
                <StatRow label="Status" value={isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)} />
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

            </div>
          </>
        )}

        {/* ══ TAB: ENERGIE ════════════════════════════════════════════════ */}
        {activeTab === 'energie' && (
          <>
            <FlowBanner />

            {/* Zähler */}
            {(() => {
              const bkwRaw    = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'])
              const bkwKwh    = !isNaN(bkwRaw) ? bkwRaw + 178.779 : NaN
              const victronKwh = parseFloat(values[V('solarcharger/288/Yield/System')] ?? 'NaN')
              const solarTotal = (!isNaN(bkwKwh) ? bkwKwh : 0) + (!isNaN(victronKwh) ? victronKwh : 0)
              const hasSolar   = !isNaN(bkwKwh) || !isNaN(victronKwh)
              return (
                <div style={{ marginBottom: 8 }}>
                  <Card accentColor={T.spark.cyan}>
                    <CardLabel icon="📊" color={T.spark.cyan}>Zähler</CardLabel>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>

                      {/* Strom gesamt */}
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>⚡ Strom gesamt</div>
                        <BigVal value={values['Stromzähler/Verbrauch_gesamt'] ?? '…'} unit="kWh" size={15} />
                      </div>

                      {/* Solar gesamt: BKW + Victron */}
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>🔋 Solar gesamt</div>
                        <BigVal
                          value={hasSolar ? solarTotal.toFixed(2) : '…'}
                          unit="kWh"
                          size={15}
                          color={hasSolar ? T.ok : T.muted}
                        />
                        {hasSolar && (
                          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.fontMono, marginTop: 3, lineHeight: 1.6 }}>
                            {!isNaN(bkwKwh)    && <span>{bkwKwh.toFixed(2)} BKW</span>}
                            {!isNaN(bkwKwh) && !isNaN(victronKwh) && <span style={{ margin: '0 3px' }}>+</span>}
                            {!isNaN(victronKwh) && <span>{victronKwh.toFixed(2)} Victron</span>}
                          </div>
                        )}
                      </div>

                      {/* Gas */}
                      <div>
                        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>🔥 Gas</div>
                        <BigVal value={values['Gaszaehler/stand'] ?? '…'} unit="m³" size={15} />
                      </div>

                    </div>
                  </Card>
                </div>
              )
            })()}

            {/* Phasen L1–L3 */}
            <div className="grid-groups" style={{ marginBottom: 8 }}>
              {groupTopics.map(group => (
                <PhasenCard key={group.label} group={group} values={values} minMax={minMax} hist={hist} />
              ))}
            </div>

            {/* Erzeugung */}
            <div className="grid-victron">
              <Card accentColor={amberAcc}>
                <CardLabel icon="☀️" color={amberAcc}>MPPT · Solarladeregler</CardLabel>
                <BigVal value={isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)}`} unit="W" size={21} color={isNaN(V_PV_W) ? T.muted : amberAcc} />
                <Sub>PV-Eingangsleistung</Sub>
                {!isNaN(V_PV_W) && <>
                  <Bar value={V_PV_W} max={Math.max(minMax[VICTRON_TOPICS.pvPower]?.max ?? 0, 1500)} color={amberAcc} />
                  <MinMaxRow min={minMax[VICTRON_TOPICS.pvPower]?.min ?? V_PV_W} max={minMax[VICTRON_TOPICS.pvPower]?.max ?? V_PV_W} unit=" W" />
                </>}
                {(hist[VICTRON_TOPICS.pvPower] ?? []).length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={hist[VICTRON_TOPICS.pvPower]} color={amberAcc} /></div>}
                <Div />
                <StatRow label="PV Spannung" value={isNaN(V_PV_V) ? '…' : `${V_PV_V.toFixed(0)} V`} />
                <StatRow label="PV Strom"    value={isNaN(V_PV_A) ? '…' : `${V_PV_A.toFixed(1)} A`} />
                <StatRow label="Status"      value={isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)} />
              </Card>

              <Card accentColor={T.spark.cyan}>
                <CardLabel icon="🌿" color={T.spark.cyan}>Balkonkraftwerk</CardLabel>
                <BigVal value={isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)}`} unit="W" size={21} color={isNaN(BKW_W) ? T.muted : (BKW_W >= 200 ? T.ok : T.warn)} />
                <Sub>Aktuelle Erzeugung</Sub>
                {!isNaN(BKW_W) && <>
                  <Bar value={BKW_W} max={800} color={BKW_W >= 200 ? T.ok : T.warn} />
                </>}
                {(hist['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'] ?? []).length >= 2 && (
                  <div style={{ marginTop: 4 }}>
                    <Sparkline data={hist['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0']} color={T.ok} />
                  </div>
                )}
                <Div />
                <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Erzeugung gesamt (heute + gestern)</div>
                <BigVal value={totalGen > 0 || !isNaN(BKW_W) ? `${Math.round(totalGen)}` : '…'} unit="W" size={17} color={genColor} />
              </Card>

              <Card accentColor={T.err}>
                <CardLabel icon="⚡" color={T.err}>Strom · Netzbezug</CardLabel>
                {(() => {
                  const key   = 'Stromzähler/Verbrauch_aktuell'
                  const num   = parseFloat(values[key])
                  const range = minMax[key] ?? { min: num, max: num }
                  const h     = hist[key] ?? []
                  const col   = leistungColor(num)
                  return <>
                    <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={21} color={col} />
                    <Bar value={num} max={Math.abs(range.max) > 0 ? Math.abs(range.max) : 2000} color={col} />
                    <MinMaxRow min={range.min} max={range.max} unit=" W" />
                    {h.length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={h} color={col} /></div>}
                  </>
                })()}
                <Div />
                <Sub>Hausverbrauch (Venus OS)</Sub>
                <BigVal value={hausverbrauch === 0 && isNaN(consL1) ? '…' : `${Math.round(hausverbrauch)}`} unit="W" size={17} color={leistungColor(hausverbrauch)} />
                {!isNaN(verbrauch) && !isNaN(totalGen) && (
                  <div style={{ marginTop: 5, fontSize: 11, color: uebColor, fontFamily: T.fontMono, fontWeight: 700 }}>
                    {ueberschuss >= 0 ? `+${Math.round(ueberschuss)} W Überschuss` : `${Math.round(ueberschuss)} W Defizit`}
                  </div>
                )}
              </Card>
            </div>
          </>
        )}

        {/* ══ TAB: VICTRON ════════════════════════════════════════════════ */}
        {activeTab === 'victron' && (
          <>
            <FlowBanner />
            <div className="grid-victron">

              <Card accentColor={socColor}>
                <CardLabel icon="🔋" color={socColor}>Batterie · Pylontech</CardLabel>
                <div className="soc-wrap" style={{ marginBottom: 8 }}>
                  <SocRing soc={V_SOC} size={54} />
                  <div>
                    <BigVal value={isNaN(V_BAT_V) ? '…' : V_BAT_V.toFixed(1)} unit="V" size={19} />
                    <div style={{ marginTop: 4 }}>
                      {!isNaN(V_BAT_STATE) && (
                        <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>
                          {batStateLabel(V_BAT_STATE)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <Div />
                <StatRow label="Strom"    value={isNaN(V_BAT_A) ? '…' : `${V_BAT_A.toFixed(1)} A`} />
                <StatRow label="Leistung" value={isNaN(V_BAT_W) ? '…' : `${Math.round(V_BAT_W)} W`} />
                <StatRow label="Temp"     value={isNaN(V_BAT_T) ? '…' : `${V_BAT_T.toFixed(1)} °C`} />
                {!isNaN(V_SOC) && <>
                  <Bar value={V_SOC} max={100} color={socColor} />
                  <MinMaxRow min={minMax[VICTRON_TOPICS.soc]?.min ?? V_SOC} max={minMax[VICTRON_TOPICS.soc]?.max ?? V_SOC} unit=" %" />
                </>}
                {(hist[VICTRON_TOPICS.soc] ?? []).length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={hist[VICTRON_TOPICS.soc]} color={socColor} /></div>}
              </Card>

              <Card accentColor={amberAcc}>
                <CardLabel icon="☀️" color={amberAcc}>MPPT · Solarladeregler</CardLabel>
                <BigVal value={isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)}`} unit="W" size={21} color={isNaN(V_PV_W) ? T.muted : amberAcc} />
                <Sub>PV-Eingangsleistung</Sub>
                {!isNaN(V_PV_W) && <>
                  <Bar value={V_PV_W} max={Math.max(minMax[VICTRON_TOPICS.pvPower]?.max ?? 0, 1500)} color={amberAcc} />
                  <MinMaxRow min={minMax[VICTRON_TOPICS.pvPower]?.min ?? V_PV_W} max={minMax[VICTRON_TOPICS.pvPower]?.max ?? V_PV_W} unit=" W" />
                </>}
                {(hist[VICTRON_TOPICS.pvPower] ?? []).length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={hist[VICTRON_TOPICS.pvPower]} color={amberAcc} /></div>}
                <Div />
                <StatRow label="PV Spannung" value={isNaN(V_PV_V) ? '…' : `${V_PV_V.toFixed(0)} V`} />
                <StatRow label="PV Strom"    value={isNaN(V_PV_A) ? '…' : `${V_PV_A.toFixed(1)} A`} />
                <StatRow label="Status"      value={isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)} />
              </Card>

              <Card accentColor={purpleAcc}>
                <CardLabel icon="🔌" color={purpleAcc}>Wechselrichter · MultiPlus</CardLabel>
                <BigVal value={isNaN(V_AC_W) ? '…' : `${Math.round(V_AC_W)}`} unit="W" size={21} color={isNaN(V_AC_W) ? T.muted : purpleAcc} />
                <Sub>AC-Ausgangsleistung</Sub>
                {!isNaN(V_AC_W) && <>
                  <Bar value={V_AC_W} max={Math.max(minMax[VICTRON_TOPICS.acOutPower]?.max ?? 0, 2000)} color={purpleAcc} />
                  <MinMaxRow min={minMax[VICTRON_TOPICS.acOutPower]?.min ?? V_AC_W} max={minMax[VICTRON_TOPICS.acOutPower]?.max ?? V_AC_W} unit=" W" />
                </>}
                {(hist[VICTRON_TOPICS.acOutPower] ?? []).length >= 2 && <div style={{ marginTop: 4 }}><Sparkline data={hist[VICTRON_TOPICS.acOutPower]} color={purpleAcc} /></div>}
                <Div />
                <StatRow label="Spannung"  value={isNaN(V_AC_V) ? '…' : `${V_AC_V.toFixed(0)} V`} />
                <StatRow label="Frequenz"  value={isNaN(V_AC_F) ? '…' : `${V_AC_F.toFixed(1)} Hz`} />
                <StatRow label="Modus"     value={isNaN(V_INV_MODE) ? '…' : (INVERTER_MODES.find(m => m.value === V_INV_MODE)?.label ?? `Mode ${V_INV_MODE}`)} />
                {!isNaN(V_VEBUS_STATE) && (
                  <div style={{ marginTop: 5 }}>
                    <Badge color={V_VEBUS_STATE === 9 ? T.ok : V_VEBUS_STATE === 2 ? T.err : amberAcc}>
                      {V_VEBUS_STATE === 9 ? 'Inverting' : V_VEBUS_STATE === 3 ? 'Bulk' : V_VEBUS_STATE === 4 ? 'Absorption' : V_VEBUS_STATE === 5 ? 'Float' : `Status ${V_VEBUS_STATE}`}
                    </Badge>
                  </div>
                )}
              </Card>

            </div>
          </>
        )}

        {/* ══ TAB: STEUERUNG ══════════════════════════════════════════════ */}
        {activeTab === 'steuerung' && (
          <div className="grid-top">

            <Card accentColor={T.accent}>
              <CardLabel icon="🖨️" color={T.accent}>3D-Drucker</CardLabel>
              {['Sidewinder X1'].map(label => {
                const t = topics.find(x => x.label === label)
                if (!t) return null
                return <SwitchRow key={label} label={label} on={isOn(values[t.statusTopic])} onClick={() => toggle(t.publishTopic!, values[t.statusTopic])} />
              })}
            </Card>

            <Card accentColor={T.spark.energy}>
              <CardLabel icon="🏊" color={T.spark.energy}>Pool</CardLabel>
              {(() => {
                const pumpe = topics.find(x => x.label === 'Poolpumpe')
                return <SwitchRow label="Pumpe" on={isOn(values[pumpe?.statusTopic ?? ''])}
                  onClick={() => pumpe && toggle(pumpe.publishTopic!, values[pumpe.statusTopic])} />
              })()}
            </Card>

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

            <Card accentColor={T.spark.purple}>
              <CardLabel icon="💡" color={T.spark.purple}>Beleuchtung</CardLabel>
              {[
                { label: 'Teichpumpe',    pub: 'cmnd/Teichpumpe/POWER',    stat: 'stat/Teichpumpe/POWER' },
                { label: 'Beleuchtung',   pub: 'cmnd/Beleuchtung/POWER',   stat: 'stat/Beleuchtung/POWER' },
                { label: 'Carport-Licht', pub: 'cmnd/Carport-Licht/POWER', stat: 'stat/Carport-Licht/POWER' },
              ].map(({ label, pub, stat }) => (
                <SwitchRow key={label} label={label} on={isOn(values[stat])} onClick={() => toggle(pub, values[stat])} />
              ))}
            </Card>

          </div>
        )}

      </main>

      {essOpen && (
        <EssModal
          currentEssMode={isNaN(V_ESS_MODE) ? -1 : V_ESS_MODE}
          currentInvMode={isNaN(V_INV_MODE) ? -1 : V_INV_MODE}
          onSetEss={v => setEssMode(v)}
          onSetInv={v => setInverterMode(v)}
          onClose={() => setEssOpen(false)}
        />
      )}
    </div>
  )
}

export default App
