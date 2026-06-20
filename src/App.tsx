// src/App.tsx - OPTIMIERT & REFAKTORIERT
import { useEffect, useState, useRef } from 'react'
import mqtt from 'mqtt'
import { mqttConfig, topics, VICTRON_PORTAL_ID, ESS_MODES, INVERTER_MODES } from './config'
import { T } from './theme'

// ============================================================================
// TYPES
// ============================================================================
type MinMax = Record<string, { min: number; max: number }>
type Tab = 'uebersicht' | 'energie' | 'victron' | 'steuerung' | 'verlauf'
type EnergyTabType = 'ueberblick' | 'phasen' | 'details'
type VerlaufZeitraum = 'heute' | 'woche' | 'monat' | 'jahr' | 'gesamt'
type VerlaufAnsicht = 'strom' | 'gas'
type HoveredBar = { d: StatDay; x: number; y: number } | null

type StatDay = {
  date: string
  verbrauch_kwh: number | null
  erzeugung_kwh: number | null
  solar_kwh: number | null
  bkw_kwh: number | null
  gas_m3: number | null
  soc_min: number | null
  soc_max: number | null
  soc_avg: number | null
}

type StatPeriod = {
  verbrauch_kwh: number | null
  erzeugung_kwh: number | null
  solar_kwh: number | null
  bkw_kwh: number | null
  gas_m3: number | null
  tage: StatDay[]
}

// ============================================================================
// CONSTANTS & CONFIG
// ============================================================================
const MINMAX_CACHE_KEY = 'mqtt_minmax_cache'
const MINMAX_TOPIC = 'dashboard/minmax/update'
const REQUEST_TOPIC = 'dashboard/minmax/request'
const HISTORY_LENGTH = 60

const V = (path: string) => `N/${VICTRON_PORTAL_ID}/${path}`
const VW = (path: string) => `W/${VICTRON_PORTAL_ID}/${path}`

const VICTRON_TOPICS = {
  soc: V('system/0/Dc/Battery/Soc'),
  batVoltage: V('system/0/Dc/Battery/Voltage'),
  batCurrent: V('system/0/Dc/Battery/Current'),
  batPower: V('system/0/Dc/Battery/Power'),
  batTemp: V('system/0/Dc/Battery/Temperature'),
  batState: V('system/0/Dc/Battery/State'),
  pvPower: V('solarcharger/288/Yield/Power'),
  pvVoltage: V('solarcharger/288/Pv/V'),
  pvCurrent: V('solarcharger/288/Pv/I'),
  mpptState: V('solarcharger/288/State'),
  acOutPower: V('vebus/288/Ac/Out/P'),
  acOutVoltage: V('vebus/288/Ac/Out/L1/V'),
  acOutFreq: V('vebus/288/Ac/Out/L1/F'),
  vebusState: V('vebus/288/VebusStatus'),
  vebusMode: V('vebus/288/Mode'),
  essMode: V('settings/0/Settings/CGwacs/BatteryLife/State'),
  gridL1: V('grid/30/Ac/L1/Power'),
  gridL2: V('grid/30/Ac/L2/Power'),
  gridL3: V('grid/30/Ac/L3/Power'),
  gridTotal: V('grid/30/Ac/Power'),
  consL1: V('system/0/Ac/Consumption/L1/Power'),
  consL2: V('system/0/Ac/Consumption/L2/Power'),
  consL3: V('system/0/Ac/Consumption/L3/Power'),
  dcSystem: V('system/0/Dc/System/Power'),
} as const

const EXPLICIT_SUBSCRIBES = [
  'tele/Stromzähler/SENSOR',
  'tele/Balkonkraftwerk/SENSOR',
  'pool/temperatur',
  'Gaszaehler/stand',
  'stat/+/POWER',
  'stat/+/POWER1',
  'stat/+/RESULT',
  MINMAX_TOPIC,
  'Stromzähler/#',
  'stats/#',
  `N/${VICTRON_PORTAL_ID}/#`,
]

const BATTERY_CONFIG = { CAPACITY_KWH: 3.5, DOD: 0.8, CYCLES_MAX: 6000 }
const PRICE_CONFIG = { KWH: 0.311, GRUNDPREIS: 165.0, GAS: 0.11, GAS_KWH_M3: 10.0 }

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: '⚡' },
  { id: 'energie', label: 'Energie', icon: '🌿' },
  { id: 'victron', label: 'Victron', icon: '🔋' },
  { id: 'steuerung', label: 'Steuerung', icon: '🔌' },
  { id: 'verlauf', label: 'Verlauf', icon: '📈' },
]

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
const mpptStateLabel = (s: number): string => {
  const labels: Record<number, string> = {
    0: 'Aus', 2: 'Fehler', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 7: 'Manuell',
    11: 'Laden', 245: 'Starten', 247: 'Laden', 252: 'Ext. Steuerung',
  }
  return labels[s] ?? `Status ${s}`
}

const batStateLabel = (s: number): string => {
  const labels: Record<number, string> = { 0: 'Bereit', 1: 'Laden', 2: 'Entladen' }
  return labels[s] ?? `Status ${s}`
}

const leistungColor = (w: number): string => {
  if (w < 0) return T.ok
  return w >= 1000 ? T.err : w >= 300 ? T.warn : T.ok
}

const phasenColor = (w: number): string => {
  if (isNaN(w)) return T.muted
  if (w < 0) return T.ok
  if (w >= 1500) return T.err
  if (w >= 500) return T.warn
  return T.spark.power
}

// Formatter Functions
const fw = (n: number, d = 0) => (isNaN(n) ? '…' : n.toFixed(d))
const fr = (n: number) => (isNaN(n) ? '…' : String(Math.round(n)))
const fkwh = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} kWh`)
const fEur = (v: number) => (v >= 0 ? `+${v.toFixed(2)} €` : `${v.toFixed(2)} €`)

// Storage
const loadCachedMinMax = (): MinMax => {
  try {
    const r = localStorage.getItem(MINMAX_CACHE_KEY)
    return r ? JSON.parse(r) : {}
  } catch { return {} }
}

const saveCachedMinMax = (data: MinMax) => {
  try { localStorage.setItem(MINMAX_CACHE_KEY, JSON.stringify(data)) } catch {}
}

// Calculations
const calcEuro = (verbrauch: number | null, erzeugung: number | null, days: number) => {
  const v = verbrauch ?? 0
  const e = erzeugung ?? 0
  const gp = (PRICE_CONFIG.GRUNDPREIS / 365) * days
  const cost = v * PRICE_CONFIG.KWH + gp
  const save = e * PRICE_CONFIG.KWH
  return { cost, save, net: save - cost, gp }
}

interface BatteryLifeStats {
  cyclesUsed: number
  cyclesRemaining: number
  pctUsed: number
  daysRemaining: number | null
  yearsRemaining: number | null
  dailyAvgKwh: number
  daysTracked: number
}

const calcBatteryLife = (statTage: StatDay[]): BatteryLifeStats | null => {
  const { CAPACITY_KWH, DOD, CYCLES_MAX } = BATTERY_CONFIG
  const totalDischarge = statTage.reduce((sum, d) => {
    const v = d.verbrauch_kwh ?? 0
    const e = d.erzeugung_kwh ?? 0
    return sum + Math.min(v, e) * 0.5
  }, 0)

  const daysTracked = statTage.filter((d) => d.verbrauch_kwh !== null).length
  if (daysTracked < 3) return null

  const dailyAvg = totalDischarge / daysTracked
  const cyclesUsed = totalDischarge / (CAPACITY_KWH * DOD)
  const cyclesRemaining = Math.max(0, CYCLES_MAX - cyclesUsed)
  const daysRemaining = dailyAvg > 0 ? (cyclesRemaining * (CAPACITY_KWH * DOD)) / dailyAvg : null
  const yearsRemaining = daysRemaining ? daysRemaining / 365 : null
  const pctUsed = (cyclesUsed / CYCLES_MAX) * 100

  return {
    cyclesUsed: Math.round(cyclesUsed),
    cyclesRemaining: Math.round(cyclesRemaining),
    pctUsed: Math.round(pctUsed * 10) / 10,
    daysRemaining: daysRemaining ? Math.round(daysRemaining) : null,
    yearsRemaining: yearsRemaining ? Math.round(yearsRemaining * 10) / 10 : null,
    dailyAvgKwh: Math.round(dailyAvg * 100) / 100,
    daysTracked,
  }
}

// ============================================================================
// UI COMPONENTS
// ============================================================================
function Sparkline({ data, color, height = 28 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const w = 200, h = height, pad = 2
  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2)
      const y = h - pad - ((v - min) / range) * (h - pad * 2)
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height, display: 'block' }} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function Card({ children, accentColor, style }: { children: React.ReactNode; accentColor?: string; style?: React.CSSProperties }) {
  const color = accentColor ?? T.accent
  return (
    <div style={{ background: T.surf, border: `1px solid ${color}28`, borderRadius: T.radius, padding: '11px 13px', height: '100%', ...style }}>
      {children}
    </div>
  )
}

function CardLabel({ icon, children, color }: { icon: string; children: React.ReactNode; color?: string }) {
  const c = color ?? T.accent
  return (
    <div className="pill-label" style={{ background: c + '18', color: c }}>
      {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
      <span className="card-label-text">{children}</span>
    </div>
  )
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, max > 0 ? (Math.abs(value) / max) * 100 : 0)
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 2, height: 3, marginTop: 6, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  )
}

function MinMaxRow({ min, max, unit }: { min: number; max: number; unit?: string }) {
  return <div className="minmax-compact">Min: {min?.toFixed(1)}{unit} · Max: {max?.toFixed(1)}{unit}</div>
}

function ToggleBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 11px', borderRadius: T.btnRadius, fontSize: 11, fontWeight: 700, fontFamily: T.fontLabel,
        cursor: 'pointer', border: `1px solid ${on ? T.ok + '55' : T.err + '55'}`,
        background: on ? T.ok + '20' : T.err + '20', color: on ? T.ok : T.err,
        letterSpacing: '0.05em', transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
    >
      {on ? 'AN' : 'AUS'}
    </button>
  )
}

function SwitchRow({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 13, fontFamily: T.fontBody, color: T.text, minWidth: 0, wordBreak: 'break-word' }}>{label}</span>
      <div style={{ flexShrink: 0 }}>
        <ToggleBtn on={on} onClick={onClick} />
      </div>
    </div>
  )
}

function BigVal({ value, unit, size = 20, color }: { value: string; unit?: string; size?: number; color?: string }) {
  return (
    <div style={{ fontFamily: T.fontMono, fontSize: size, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15, color: color ?? T.text }}>
      {value}
      {unit && <span style={{ fontSize: size * 0.6, fontWeight: 400, color: T.muted, marginLeft: 2 }}>{unit}</span>}
    </div>
  )
}

function Badge({ children, color = T.ok }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, fontFamily: T.fontLabel, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: color + '20', border: `1px solid ${color}44`, color }}>
      {children}
    </span>
  )
}

function SocRing({ soc, size = 52 }: { soc: number; size?: number }) {
  const r = size / 2 - 5
  const circ = 2 * Math.PI * r
  const filled = isNaN(soc) ? 0 : Math.min(100, soc)
  const offset = circ - (filled / 100) * circ
  const color = soc >= 60 ? T.ok : soc >= 30 ? T.warn : T.err
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x={size / 2} y={size / 2 + 4} textAnchor="middle" fontSize={11} fill={T.text} fontWeight={700} fontFamily={T.fontMono}>
        {isNaN(soc) ? '…' : `${Math.round(soc)}%`}
      </text>
    </svg>
  )
}

function Div() { return <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '8px 0' }} /> }
function Sub({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 11, color: T.muted, marginBottom: 3, fontFamily: T.fontMono }}>{children}</div> }
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 5, fontFamily: T.fontMono }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ color: T.text, fontWeight: 700 }}>{value}</span>
    </div>
  )
}

function PhasenCard({
  group,
  values,
  minMax,
  hist,
}: {
  group: typeof topics[0]
  values: Record<string, string>
  minMax: MinMax
  hist: Record<string, number[]>
}) {
  const isSpan = group.label.includes('Spannung')
  const isStromG = group.label.includes('Strom L')
  const isLeist = group.label.includes('Leistung')
  const groupColor = isSpan ? T.spark.purple : isStromG ? T.spark.orange : T.spark.power
  const barMax = isSpan ? 250 : isStromG ? 20 : 3000
  const dp = isSpan ? 0 : 1

  return (
    <Card accentColor={groupColor}>
      <CardLabel icon="" color={groupColor}>{group.label}</CardLabel>
      {group.keys?.map(({ label, key }) => {
        const raw = values[key]
        const num = raw !== undefined ? parseFloat(raw) : NaN
        const range = minMax[key] ?? { min: num, max: num }
        const h = hist[key] ?? []
        const valColor = isLeist ? phasenColor(num) : groupColor
        return (
          <div key={key} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <span style={{ fontFamily: T.fontLabel, fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', color: groupColor, minWidth: 28 }}>{label}</span>
              <span style={{ fontFamily: T.fontMono, fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1, color: valColor }}>
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
    <div className="ess-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
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
          {ESS_MODES.map((m) => {
            const isActive = (m.value === 1 && currentEssMode >= 1 && currentEssMode <= 8) || (m.value === 10 && currentEssMode >= 10 && currentEssMode <= 12) || (m.value === 9 && currentEssMode === 9) || (m.value === 3 && currentEssMode === 3)
            return (
              <button key={m.value} className={`ess-mode-btn${isActive ? ' active' : ''}`} onClick={() => onSetEss(m.value)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontFamily: T.fontMono, fontSize: 12, color: T.text, fontWeight: 700 }}>{m.label}</span>
                    <span style={{ fontFamily: T.fontMono, fontSize: 10, color: T.muted, marginLeft: 7 }}>{m.sub}</span>
                  </div>
                  {isActive && <span style={{ color: T.accent, fontSize: 13 }}>●</span>}
                </div>
              </button>
            )
          })}
        </div>
        <Div />
        <div style={{ fontFamily: T.fontLabel, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T.muted, marginBottom: 7, marginTop: 12 }}>Wechselrichter-Modus</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {INVERTER_MODES.map((m) => (
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

// ============================================================================
// MAIN APP
// ============================================================================
function App() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax] = useState<MinMax>(loadCachedMinMax)
  const [essOpen, setEssOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('uebersicht')
  const [winW, setWinW] = useState(window.innerWidth)
  const [statTage, setStatTage] = useState<StatDay[]>([])
  const [statHeute, setStatHeute] = useState<StatDay | null>(null)
  const [statWoche, setStatWoche] = useState<StatPeriod | null>(null)
  const [statMonat, setStatMonat] = useState<StatPeriod | null>(null)
  const [statJahr, setStatJahr] = useState<StatPeriod | null>(null)

  const histRef = useRef<Record<string, number[]>>({})
  const messageQueue = useRef<Record<string, string>>({})
  const clientRef = useRef<any>(null)
  const toggleLock = useRef<Record<string, number>>({})

  const batLife = calcBatteryLife(statTage)

  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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
      const sendKeepalive = () => {
        client.publish(`R/${VICTRON_PORTAL_ID}/system/0/Serial`, '')
        client.publish(`R/${VICTRON_PORTAL_ID}/settings/0/Settings/CGwacs/BatteryLife/State`, '')
        client.publish(`R/${VICTRON_PORTAL_ID}/vebus/288/Mode`, '')
      }
      sendKeepalive()

      const tasmotaDevices = ['Steckdose_1', 'Steckdose_2', 'Doppelsteckdose', 'Teichpumpe', 'Beleuchtung', 'Carport-Licht', 'Poolpumpe', 'Sidewinder_X1']
      tasmotaDevices.forEach((d) => client.publish(`cmnd/${d}/State`, ''))
      setTimeout(() => { client.publish(REQUEST_TOPIC, JSON.stringify({ ts: Date.now() })) }, 500)
      const keepalive = setInterval(sendKeepalive, 30_000)
      ;(client as any)._keepalive = keepalive
    })

    client.on('error', (err) => console.error('MQTT:', err))

    client.on('message', (topic: string, message: Buffer) => {
      const payload = message.toString().trim()
      if (topic === MINMAX_TOPIC) {
        try { const d = JSON.parse(payload); setMinMax(d); saveCachedMinMax(d) } catch {}
        return
      }
      if (topic === 'pool/temperatur' || topic === 'Gaszaehler/stand') { messageQueue.current[topic] = payload; return }
      if (topic.startsWith('stat/') && (topic.endsWith('/POWER') || topic.endsWith('/POWER1'))) {
        const lock = toggleLock.current[topic]
        if (lock && Date.now() < lock) return
        messageQueue.current[topic] = payload
        return
      }
      if (topic.startsWith('stat/') && (topic.endsWith('/RESULT') || topic.endsWith('/STATE') || topic.endsWith('/STATUS11'))) {
        try {
          const parsed = JSON.parse(payload)
          const device = topic.split('/')[1]
          const statBase = `stat/${device}/`
          if (parsed.POWER !== undefined) {
            const lockKey = `${statBase}POWER`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey]) messageQueue.current[lockKey] = parsed.POWER
          }
          if (parsed.POWER1 !== undefined) {
            const lockKey = `${statBase}POWER1`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey]) messageQueue.current[lockKey] = parsed.POWER1
          }
          if (parsed.StatusSTS?.POWER !== undefined) {
            const lockKey = `${statBase}POWER`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey]) messageQueue.current[lockKey] = parsed.StatusSTS.POWER
          }
        } catch {}
        return
      }
      if (topic.startsWith('Stromzähler/')) { messageQueue.current[topic] = payload; return }
      if (topic.startsWith('stats/')) {
        try {
          const parsed = JSON.parse(payload)
          if (topic === 'stats/tage') setStatTage(parsed)
          if (topic === 'stats/heute') setStatHeute(parsed)
          if (topic === 'stats/woche') setStatWoche(parsed)
          if (topic === 'stats/monat') setStatMonat(parsed)
          if (topic === 'stats/jahr') setStatJahr(parsed)
        } catch {}
        return
      }
      if (topic.startsWith(`N/${VICTRON_PORTAL_ID}/`)) {
        try { const parsed = JSON.parse(payload); if (parsed && 'value' in parsed) messageQueue.current[topic] = String(parsed.value) } catch {}
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
      } catch { messageQueue.current[topic] = payload }
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
      setValues((prev) => ({ ...prev, ...updates }))
      setLastUpdate(new Date().toLocaleTimeString())
    }

    const iv = setInterval(flush, 150)
    return () => {
      clearInterval(iv)
      clearInterval((client as any)._keepalive)
      client.end(true)
    }
  }, [])

  const toggle = (pub: string, cur: string) => {
    const next = cur?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    const statTopic = pub.replace('cmnd/', 'stat/')
    setValues((prev) => ({ ...prev, [statTopic]: next }))
    toggleLock.current[statTopic] = Date.now() + 2000
    clientRef.current?.publish(pub, next)
  }

  const victronWrite = (path: string, value: number) => {
    const topic = VW(path.replace(`N/${VICTRON_PORTAL_ID}/`, ''))
    clientRef.current?.publish(topic, JSON.stringify({ value }))
    setValues((prev) => ({ ...prev, [`N/${VICTRON_PORTAL_ID}/${path.replace(`N/${VICTRON_PORTAL_ID}/`, '')}`]: String(value) }))
  }

  const setEssMode = (v: number) => victronWrite('settings/0/Settings/CGwacs/BatteryLife/State', v)
  const setInverterMode = (v: number) => victronWrite('vebus/288/Mode', v)
  const isOn = (v: string) => v?.toUpperCase() === 'ON'
  const hist = histRef.current

  // Parse Victron values
  const V_SOC = parseFloat(values[VICTRON_TOPICS.soc] ?? 'NaN')
  const V_BAT_V = parseFloat(values[VICTRON_TOPICS.batVoltage] ?? 'NaN')
  const V_BAT_A = parseFloat(values[VICTRON_TOPICS.batCurrent] ?? 'NaN')
  const V_BAT_W = parseFloat(values[VICTRON_TOPICS.batPower] ?? 'NaN')
  const V_BAT_T = parseFloat(values[VICTRON_TOPICS.batTemp] ?? 'NaN')
  const V_BAT_STATE = parseFloat(values[VICTRON_TOPICS.batState] ?? 'NaN')
  const V_PV_W = parseFloat(values[VICTRON_TOPICS.pvPower] ?? 'NaN')
  const V_PV_V = parseFloat(values[VICTRON_TOPICS.pvVoltage] ?? 'NaN')
  const V_PV_A = parseFloat(values[VICTRON_TOPICS.pvCurrent] ?? 'NaN')
  const V_MPPT_STATE = parseFloat(values[VICTRON_TOPICS.mpptState] ?? 'NaN')
  const V_AC_W = parseFloat(values[VICTRON_TOPICS.acOutPower] ?? 'NaN')
  const V_AC_V = parseFloat(values[VICTRON_TOPICS.acOutVoltage] ?? 'NaN')
  const V_AC_F = parseFloat(values[VICTRON_TOPICS.acOutFreq] ?? 'NaN')
  const V_VEBUS_STATE = parseFloat(values[VICTRON_TOPICS.vebusState] ?? 'NaN')
  const V_INV_MODE = parseFloat(values[VICTRON_TOPICS.vebusMode] ?? 'NaN')
  const V_ESS_MODE = parseFloat(values[VICTRON_TOPICS.essMode] ?? 'NaN')
  const V_GRID_L1 = parseFloat(values[VICTRON_TOPICS.gridL1] ?? 'NaN')
  const V_GRID_L2 = parseFloat(values[VICTRON_TOPICS.gridL2] ?? 'NaN')
  const V_GRID_L3 = parseFloat(values[VICTRON_TOPICS.gridL3] ?? 'NaN')
  const V_GRID_TOT = parseFloat(values[VICTRON_TOPICS.gridTotal] ?? 'NaN')
  const V_CONS_L1 = parseFloat(values[VICTRON_TOPICS.consL1] ?? 'NaN')
  const V_CONS_L2 = parseFloat(values[VICTRON_TOPICS.consL2] ?? 'NaN')
  const V_CONS_L3 = parseFloat(values[VICTRON_TOPICS.consL3] ?? 'NaN')
  const V_CONS_TOT = (!isNaN(V_CONS_L1) ? V_CONS_L1 : 0) + (!isNaN(V_CONS_L2) ? V_CONS_L2 : 0) + (!isNaN(V_CONS_L3) ? V_CONS_L3 : 0)
  const V_DC_SYS = parseFloat(values[VICTRON_TOPICS.dcSystem] ?? 'NaN')

  const BKW_W = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'] ?? 'NaN')
  const totalGen = (!isNaN(BKW_W) ? BKW_W : 0) + (!isNaN(V_PV_W) ? V_PV_W : 0)
  const netzAustausch = parseFloat(values['Stromzähler/Verbrauch_aktuell'] ?? 'NaN')
  const consL1 = parseFloat(values[V('system/0/Ac/Consumption/L1/Power')] ?? '0')
  const consL2 = parseFloat(values[V('system/0/Ac/Consumption/L2/Power')] ?? '0')
  const consL3 = parseFloat(values[V('system/0/Ac/Consumption/L3/Power')] ?? '0')
  const hausverbrauch = (!isNaN(consL1) ? consL1 : 0) + (!isNaN(consL2) ? consL2 : 0) + (!isNaN(consL3) ? consL3 : 0)
  const verbrauch = netzAustausch
  const ueberschuss = totalGen - hausverbrauch

  const socColor = V_SOC >= 60 ? T.ok : V_SOC >= 30 ? T.warn : T.err
  const pvColor = V_PV_W >= 800 ? T.ok : V_PV_W >= 300 ? T.warn : T.muted
  const tealAcc = '#2dd4bf'
  const amberAcc = '#fbbf24'
  const purpleAcc = '#c084fc'
  const genColor = totalGen >= 500 ? T.ok : totalGen >= 200 ? T.warn : T.muted
  const uebColor = ueberschuss >= 0 ? T.ok : T.err

  const groupTopics = topics.filter((t) => t.type === 'group')

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: T.fontBody }}>
      <header className="dash-header" style={{ background: T.surf, borderBottom: `1px solid ${T.accent}33`, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text, opacity: 0.7 }}>MQTT Dashboard</span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: lastUpdate ? T.ok : T.warn, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontFamily: T.fontLabel, color: lastUpdate ? T.ok : T.warn, whiteSpace: 'nowrap', fontSize: 11 }}>{lastUpdate ? 'verbunden' : 'verbinde…'}</span>
        </div>
        <span style={{ fontFamily: T.fontMono, color: T.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: 11 }}>{lastUpdate ? `Letztes Update: ${lastUpdate}` : ''}</span>
      </header>

      <nav style={{ display: 'flex', gap: 6, padding: '9px 14px', flexWrap: 'wrap', background: T.bg, borderBottom: `1px solid rgba(255,255,255,0.05)`, position: 'sticky', top: 37, zIndex: 9 }}>
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ padding: '5px 14px', borderRadius: 20, fontSize: 11, letterSpacing: '0.07em', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: T.fontLabel, fontWeight: 700, transition: 'all 0.15s', border: activeTab === tab.id ? `1px solid ${T.accent}88` : '1px solid rgba(255,255,255,0.1)', background: activeTab === tab.id ? T.accent + '20' : 'transparent', color: activeTab === tab.id ? T.accent : T.muted }}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </nav>

      <main style={{ padding: '10px 14px 40px' }}>
        {activeTab === 'uebersicht' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }}>
            <Card accentColor={socColor}>
              <CardLabel icon="🔋" color={socColor}>Batterie · Pylontech</CardLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <SocRing soc={V_SOC} size={50} />
                <div>
                  <BigVal value={isNaN(V_BAT_V) ? '…' : V_BAT_V.toFixed(1)} unit="V" size={18} />
                  <div style={{ marginTop: 3 }}>{!isNaN(V_BAT_STATE) && <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>{batStateLabel(V_BAT_STATE)}</Badge>}</div>
                </div>
              </div>
              <StatRow label="Temp" value={isNaN(V_BAT_T) ? '…' : `${V_BAT_T.toFixed(1)} °C`} />
            </Card>

            <Card accentColor={T.err}>
              <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
              <Sub>Netzbezug/-einspeisung</Sub>
              <BigVal value={isNaN(netzAustausch) ? '…' : `${netzAustausch}`} unit="W" size={21} color={leistungColor(netzAustausch)} />
              <Bar value={netzAustausch} max={Math.abs(minMax['Stromzähler/Verbrauch_aktuell']?.max ?? 2000)} color={leistungColor(netzAustausch)} />
              <Div />
              <Sub>Erzeugung gesamt</Sub>
              <BigVal value={totalGen > 0 || !isNaN(BKW_W) ? `${Math.round(totalGen)}` : '…'} unit="W" size={21} color={genColor} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, marginTop: 3, fontFamily: T.fontMono }}>
                <span>Balkon: {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}</span>
                <span>PV: {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`}</span>
              </div>
              {!isNaN(verbrauch) && !isNaN(totalGen) && <div style={{ marginTop: 5, fontSize: 11, color: uebColor, fontFamily: T.fontMono, fontWeight: 700 }}>{ueberschuss >= 0 ? `+${Math.round(ueberschuss)} W Überschuss` : `${Math.round(ueberschuss)} W Defizit`}</div>}
            </Card>

            {batLife && (
              <Card accentColor={batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err}>
                <CardLabel icon="⏳" color={batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err}>Batterie · Lebensdauer</CardLabel>
                <Sub>Restlaufzeit (geschätzt)</Sub>
                <div style={{ fontSize: 21, fontWeight: 700, fontFamily: T.fontMono, color: batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err }}>~{batLife.yearsRemaining} <span style={{ fontSize: 12, fontWeight: 400, color: T.muted }}>Jahre</span></div>
                <StatRow label="Zyklen (est.)" value={`${batLife.cyclesUsed} / ${BATTERY_CONFIG.CYCLES_MAX}`} />
                <StatRow label="Verbrauch" value={`${batLife.pctUsed}%`} />
              </Card>
            )}

            <Card accentColor={T.spark.power}>
              <CardLabel icon="🔌" color={T.spark.power}>Steckdosen & Beleuchtung</CardLabel>
              {['Steckdose 1', 'Steckdose 2'].map((label) => {
                const t = topics.find((x) => x.label === label)
                if (!t) return null
                return <SwitchRow key={label} label={label} on={isOn(values[t.statusTopic])} onClick={() => toggle(t.publishTopic!, values[t.statusTopic])} />
              })}
            </Card>
          </div>
        )}

        {activeTab === 'energie' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }}>
              <Card accentColor={T.err}>
                <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
                <Sub>Verbrauch gesamt</Sub>
                <BigVal value={values['Stromzähler/Verbrauch_gesamt'] ?? '…'} unit="kWh" size={18} />
              </Card>
              <Card accentColor={T.ok}>
                <CardLabel icon="🌿" color={T.ok}>Solar</CardLabel>
                <Sub>Erzeugung gesamt</Sub>
                <BigVal value={values[V('solarcharger/288/Yield/System')] ?? '…'} unit="kWh" size={18} color={T.ok} />
              </Card>
            </div>
          </div>
        )}

        {activeTab === 'victron' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }}>
            <Card accentColor={amberAcc}>
              <CardLabel icon="☀️" color={amberAcc}>MPPT · Solarladeregler</CardLabel>
              <BigVal value={isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)}`} unit="W" size={21} color={isNaN(V_PV_W) ? T.muted : amberAcc} />
              <Sub>PV-Eingangsleistung</Sub>
              <StatRow label="PV Spannung" value={isNaN(V_PV_V) ? '…' : `${V_PV_V.toFixed(0)} V`} />
              <StatRow label="Status" value={isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)} />
            </Card>

            <Card accentColor={purpleAcc}>
              <CardLabel icon="🔋" color={purpleAcc}>Wechselrichter</CardLabel>
              <BigVal value={fr(V_AC_W)} unit="W" size={21} color={leistungColor(V_AC_W)} />
              <Sub>AC Out</Sub>
              <StatRow label="Modus" value={isNaN(V_INV_MODE) ? '…' : `Mode ${V_INV_MODE}`} />
              <StatRow label="Spannung" value={fw(V_AC_V)} />
            </Card>
          </div>
        )}

        {activeTab === 'steuerung' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }}>
            <Card accentColor={T.spark.power}>
              <CardLabel icon="🔌" color={T.spark.power}>Steckdosen</CardLabel>
              {[{ label: 'Steckdose 1', pub: 'cmnd/Steckdose_1/POWER', stat: 'stat/Steckdose_1/POWER' }, { label: 'Steckdose 2', pub: 'cmnd/Steckdose_2/POWER', stat: 'stat/Steckdose_2/POWER' }, { label: 'Doppelsteckdose', pub: 'cmnd/Doppelsteckdose/POWER', stat: 'stat/Doppelsteckdose/POWER' }].map(({ label, pub, stat }) => <SwitchRow key={label} label={label} on={isOn(values[stat])} onClick={() => toggle(pub, values[stat])} />)}
            </Card>

            <Card accentColor={T.spark.purple}>
              <CardLabel icon="💡" color={T.spark.purple}>Beleuchtung</CardLabel>
              {[{ label: 'Beleuchtung', pub: 'cmnd/Beleuchtung/POWER', stat: 'stat/Beleuchtung/POWER' }, { label: 'Carport-Licht', pub: 'cmnd/Carport-Licht/POWER', stat: 'stat/Carport-Licht/POWER' }].map(({ label, pub, stat }) => <SwitchRow key={label} label={label} on={isOn(values[stat])} onClick={() => toggle(pub, values[stat])} />)}
            </Card>
          </div>
        )}

        {activeTab === 'verlauf' && (
          <div>
            <Card accentColor={T.spark.cyan}>
              <CardLabel icon="📊" color={T.spark.cyan}>Verlaufsdaten</CardLabel>
              <div style={{ marginTop: 16 }}>
                <Sub>Tage erfasst: {statTage.length}</Sub>
                {statTage.length > 0 && <div style={{ fontSize: 12, color: T.muted, fontFamily: T.fontMono }}>Ø Verbrauch: {fkwh((statTage.reduce((s, d) => s + (d.verbrauch_kwh ?? 0), 0) / statTage.length))}</div>}
              </div>
            </Card>
          </div>
        )}
      </main>

      {essOpen && <EssModal currentEssMode={isNaN(V_ESS_MODE) ? -1 : V_ESS_MODE} currentInvMode={isNaN(V_INV_MODE) ? -1 : V_INV_MODE} onSetEss={(v) => setEssMode(v)} onSetInv={(v) => setInverterMode(v)} onClose={() => setEssOpen(false)} />}
    </div>
  )
}

export default App
