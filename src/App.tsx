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
  // Netz per Phase (für Fluss-Layouts)
  gridL1:      V('grid/30/Ac/L1/Power'),
  gridL2:      V('grid/30/Ac/L2/Power'),
  gridL3:      V('grid/30/Ac/L3/Power'),
  gridTotal:   V('grid/30/Ac/Power'),
  // AC-Lasten per Phase
  consL1:      V('system/0/Ac/Consumption/L1/Power'),
  consL2:      V('system/0/Ac/Consumption/L2/Power'),
  consL3:      V('system/0/Ac/Consumption/L3/Power'),
  // DC-System
  dcSystem:    V('system/0/Dc/System/Power'),
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
  'stat/+/RESULT',
  MINMAX_TOPIC,
  'Stromzähler/#',
  'stats/#',
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
  return <div style={{ fontSize: 11, color: T.muted, marginBottom: 3, fontFamily: T.fontMono }}>{children}</div>
}
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 5, fontFamily: T.fontMono }}>
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
          {ESS_MODES.map(m => {
            // EssState liefert Unter-Zustände: 1-8 = mit BatteryLife, 10-12 = ohne BatteryLife, 9 = Keep charged, 3 = Extern
            const isActive =
              m.value === 1  ? (currentEssMode >= 1 && currentEssMode <= 8) :
              m.value === 10 ? (currentEssMode >= 10 && currentEssMode <= 12) :
              m.value === 9  ? currentEssMode === 9 :
              m.value === 3  ? currentEssMode === 3 : false
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
type Tab = 'uebersicht' | 'energie' | 'victron' | 'steuerung' | 'verlauf'

function App() {
  const [values, setValues]         = useState<Record<string, string>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [minMax, setMinMax]         = useState<MinMax>(loadCachedMinMax)
  const [essOpen, setEssOpen]       = useState(false)
  const [activeTab, setActiveTab]     = useState<Tab>('uebersicht')
  const [winW, setWinW]               = useState(window.innerWidth)
  // Statistik-Daten von ioBroker stats_service
  type StatDay = {
    date: string; verbrauch_kwh: number|null; erzeugung_kwh: number|null
    solar_kwh: number|null; bkw_kwh: number|null; gas_m3: number|null
    soc_min: number|null; soc_max: number|null; soc_avg: number|null
  }
  type StatPeriod = { verbrauch_kwh: number|null; erzeugung_kwh: number|null; solar_kwh: number|null; bkw_kwh: number|null; gas_m3: number|null; tage: StatDay[] }
  const [statTage,   setStatTage]   = useState<StatDay[]>([])
  const [statHeute,  setStatHeute]  = useState<StatDay|null>(null)
  const [statWoche,  setStatWoche]  = useState<StatPeriod|null>(null)
  const [statMonat,  setStatMonat]  = useState<StatPeriod|null>(null)
  const [statJahr,   setStatJahr]   = useState<StatPeriod|null>(null)
  const [verlaufZr,  setVerlaufZr]  = useState<'heute'|'woche'|'monat'|'jahr'|'gesamt'>('woche')
  const [verlaufAnsicht, setVerlaufAnsicht] = useState<'strom'|'gas'>('strom')
  const [energieTab, setEnergieTab] = useState<'ueberblick'|'phasen'|'details'>('ueberblick')
  const [verlaufDetail, setVerlaufDetail] = useState<StatDay|null>(null)
  const [drillData,     setDrillData]     = useState<StatDay[]|null>(null)
  const [drillLabel,    setDrillLabel]    = useState<string>('')
  const [hoveredBar,    setHoveredBar]    = useState<{d: StatDay; x: number; y: number}|null>(null)

  // Strompreise
  const PREIS_KWH    = 0.3110  // €/kWh Bezug
  const GRUNDPREIS   = 165.00  // €/Jahr
  const fEur = (v: number) => v >= 0 ? `+${v.toFixed(2)} €` : `${v.toFixed(2)} €`
  const calcEuro = (verbrauch: number|null, erzeugung: number|null, days: number) => {
    const v    = verbrauch  ?? 0
    const e    = erzeugung  ?? 0
    const gp   = GRUNDPREIS / 365 * days
    const cost = v * PREIS_KWH + gp
    const save = e * PREIS_KWH
    return { cost, save, net: save - cost, gp }
  }

  // Batterie-Lebensdauer-Schätzung (Pylontech US3000C)
  const BAT_CAPACITY_KWH = 3.5    // nutzbare Kapazität kWh
  const BAT_DOD          = 0.80   // Depth of Discharge laut Datenblatt
  const BAT_CYCLES_MAX   = 6000   // Zyklen bei 80% DoD laut Pylontech-Datenblatt
  const BAT_KWH_TOTAL    = BAT_CYCLES_MAX * BAT_CAPACITY_KWH * BAT_DOD  // ~16800 kWh Gesamtdurchsatz

  const calcBatteryLife = () => {
    // Gesamtentladung aus stats_service (kWh Verbrauch ≈ Entladung wenn keine Einspeisung)
    // Bessere Schätzung: Summe aller erzeugten kWh die durch die Batterie geflossen sind
    // Als Proxy: alle Tage mit verfügbaren Daten summieren
    const totalDischarge = statTage.reduce((sum, d) => {
      // Tagesverbrauch der Batterie ≈ erzeugung die nachts genutzt wurde
      // Vereinfachung: wir nehmen verbrauch_kwh als Proxy für Durchsatz
      const v = d.verbrauch_kwh ?? 0
      const e = d.erzeugung_kwh ?? 0
      // Batterie-Durchsatz = min(verbrauch, erzeugung) (was durch Batterie geflossen)
      return sum + Math.min(v, e) * 0.5 // konservative Schätzung: 50% durch Batterie
    }, 0)

    const daysTracked = statTage.filter(d => d.verbrauch_kwh !== null).length
    if (daysTracked < 3) return null // zu wenig Daten

    const dailyAvg        = totalDischarge / daysTracked     // kWh/Tag Durchsatz
    const cyclesUsed      = totalDischarge / (BAT_CAPACITY_KWH * BAT_DOD)
    const cyclesRemaining = Math.max(0, BAT_CYCLES_MAX - cyclesUsed)
    const daysRemaining   = dailyAvg > 0 ? cyclesRemaining * (BAT_CAPACITY_KWH * BAT_DOD) / dailyAvg : null
    const yearsRemaining  = daysRemaining ? daysRemaining / 365 : null
    const pctUsed         = (cyclesUsed / BAT_CYCLES_MAX) * 100

    return {
      cyclesUsed:      Math.round(cyclesUsed),
      cyclesRemaining: Math.round(cyclesRemaining),
      pctUsed:         Math.round(pctUsed * 10) / 10,
      daysRemaining:   daysRemaining ? Math.round(daysRemaining) : null,
      yearsRemaining:  yearsRemaining ? Math.round(yearsRemaining * 10) / 10 : null,
      dailyAvgKwh:     Math.round(dailyAvg * 100) / 100,
      daysTracked,
    }
  }
  const batLife = calcBatteryLife()
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
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
      const sendKeepalive = () => {
        client.publish(`R/${VICTRON_PORTAL_ID}/system/0/Serial`, '')
        client.publish(`R/${VICTRON_PORTAL_ID}/settings/0/Settings/CGwacs/BatteryLife/State`, '')
        client.publish(`R/${VICTRON_PORTAL_ID}/vebus/288/Mode`, '')
      }
      sendKeepalive()
      // Tasmota 15.x: initialen Status aller Geräte abfragen (STATE statt leerem POWER)
      const tasmotaDevices = [
        'Steckdose_1','Steckdose_2','Doppelsteckdose',
        'Teichpumpe','Beleuchtung','Carport-Licht','Poolpumpe','Sidewinder_X1'
      ]
      tasmotaDevices.forEach(d => client.publish(`cmnd/${d}/State`, ''))
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
      // Toggle-Sperre: stat/POWER Topics 2s nach Toggle ignorieren
      if (topic.startsWith('stat/') && (topic.endsWith('/POWER') || topic.endsWith('/POWER1'))) {
        const lock = toggleLock.current[topic]
        if (lock && Date.now() < lock) return
        messageQueue.current[topic] = payload; return
      }
      // Tasmota 15.x: stat/+/RESULT enthält {"POWER":"ON"} oder {"POWER1":"OFF"}
      // und stat/+/STATE enthält den vollen Status-JSON
      if (topic.startsWith('stat/') && (topic.endsWith('/RESULT') || topic.endsWith('/STATE') || topic.endsWith('/STATUS11'))) {
        try {
          const parsed = JSON.parse(payload)
          // RESULT direkt: {"POWER":"ON"}
          const device = topic.split('/')[1]
          const statBase = `stat/${device}/`
          if (parsed.POWER  !== undefined) {
            const lockKey = `${statBase}POWER`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey])
              messageQueue.current[lockKey] = parsed.POWER
          }
          if (parsed.POWER1 !== undefined) {
            const lockKey = `${statBase}POWER1`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey])
              messageQueue.current[lockKey] = parsed.POWER1
          }
          // STATUS11: {"StatusSTS":{"POWER":"OFF"}}
          if (parsed.StatusSTS?.POWER !== undefined) {
            const lockKey = `${statBase}POWER`
            if (!toggleLock.current[lockKey] || Date.now() >= toggleLock.current[lockKey])
              messageQueue.current[lockKey] = parsed.StatusSTS.POWER
          }
        } catch {}
        return
      }
      if (topic.startsWith('Stromzähler/')) {
        messageQueue.current[topic] = payload; return
      }
      // Statistik-Topics von ioBroker stats_service
      if (topic.startsWith('stats/')) {
        try {
          const parsed = JSON.parse(payload)
          if (topic === 'stats/tage')    setStatTage(parsed)
          if (topic === 'stats/heute')   setStatHeute(parsed)
          if (topic === 'stats/woche')   setStatWoche(parsed)
          if (topic === 'stats/monat')   setStatMonat(parsed)
          if (topic === 'stats/jahr')    setStatJahr(parsed)
        } catch {}
        return
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

  // Sperre: nach Toggle 2s lang keine MQTT-Updates für dieses Topic akzeptieren
  const toggleLock = useRef<Record<string, number>>({})

  const toggle = (pub: string, cur: string) => {
    const next = cur?.toUpperCase() === 'ON' ? 'OFF' : 'ON'
    const statTopic = pub.replace('cmnd/', 'stat/')
    setValues(prev => ({ ...prev, [statTopic]: next }))
    toggleLock.current[statTopic] = Date.now() + 2000
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

  // Netz per Phase
  const V_GRID_L1     = parseFloat(values[VICTRON_TOPICS.gridL1]   ?? 'NaN')
  const V_GRID_L2     = parseFloat(values[VICTRON_TOPICS.gridL2]   ?? 'NaN')
  const V_GRID_L3     = parseFloat(values[VICTRON_TOPICS.gridL3]   ?? 'NaN')
  const V_GRID_TOT    = parseFloat(values[VICTRON_TOPICS.gridTotal] ?? 'NaN')
  // AC-Lasten per Phase
  const V_CONS_L1     = parseFloat(values[VICTRON_TOPICS.consL1]   ?? 'NaN')
  const V_CONS_L2     = parseFloat(values[VICTRON_TOPICS.consL2]   ?? 'NaN')
  const V_CONS_L3     = parseFloat(values[VICTRON_TOPICS.consL3]   ?? 'NaN')
  const V_CONS_TOT    = (!isNaN(V_CONS_L1)?V_CONS_L1:0) + (!isNaN(V_CONS_L2)?V_CONS_L2:0) + (!isNaN(V_CONS_L3)?V_CONS_L3:0)
  // DC-System
  const V_DC_SYS      = parseFloat(values[VICTRON_TOPICS.dcSystem] ?? 'NaN')

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
    { id: 'verlauf',    label: 'Verlauf',    icon: '📈' },
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
            <span style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginBottom: 2 }}>PV · Victron</span>
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

  // ── Victron Fluss-Diagramme ──────────────────────────────────────────
  //
  // Alle drei Layouts verwenden eine SVG-Leinwand mit foreignObject-Kacheln
  // damit Verbindungslinien pixel-genau zwischen Kacheln gezeichnet werden.

  // Hilfsfunktion: Kachel-Stil
  const fc = (accent: string, highlight = false): React.CSSProperties => ({
    background: highlight ? (accent + '12') : T.surf,
    border: `1px solid ${accent}${highlight ? '55' : '30'}`,
    borderRadius: 7,
    padding: '10px 12px',
    fontFamily: T.fontMono,
    overflow: 'hidden',
  })

  // Animierte Fluss-Linie als inline SVG path
  const FlowLine = ({
    x1, y1, x2, y2, active, color, reverse = false
  }: {
    x1: number; y1: number; x2: number; y2: number
    active: boolean; color: string; reverse?: boolean
  }) => {
    const id = `fl-${x1}-${y1}-${x2}-${y2}`.replace(/\./g,'-')
    const animDir = reverse ? 'flow-rev' : 'flow-fwd'
    const markColor = active ? color : 'rgba(255,255,255,0.12)'
    // Bei reverse: Pfeil am Start (zeigt von x2→x1), sonst am Ende (zeigt von x1→x2)
    return (
      <g>
        <defs>
          <marker id={`arr-e-${id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill={markColor} />
          </marker>
          <marker id={`arr-s-${id}`} markerWidth="6" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 Z" fill={markColor} />
          </marker>
        </defs>
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={active ? color : 'rgba(255,255,255,0.1)'}
          strokeWidth={active ? 2 : 1.5}
          strokeDasharray={active ? '6 4' : undefined}
          markerEnd={reverse ? undefined : `url(#arr-e-${id})`}
          markerStart={reverse ? `url(#arr-s-${id})` : undefined}
          style={active ? { animation: `${animDir} 0.7s linear infinite` } : {}}
        />
      </g>
    )
  }

  // Gemeinsame Werte für alle Layouts
  const netzColor   = !isNaN(V_GRID_TOT) && V_GRID_TOT <= 0 ? T.ok : T.err
  const netActive   = !isNaN(V_GRID_TOT) && Math.abs(V_GRID_TOT) > 5
  const pvActive    = !isNaN(V_PV_W) && V_PV_W > 5
  const batActive   = !isNaN(V_BAT_W) && Math.abs(V_BAT_W) > 5
  const batIn       = !isNaN(V_BAT_W) && V_BAT_W > 0
  const netIn       = !isNaN(V_GRID_TOT) && V_GRID_TOT > 0
  const consActive  = V_CONS_TOT > 5
  const dcActive    = !isNaN(V_DC_SYS) && Math.abs(V_DC_SYS) > 5
  const dcColor     = !isNaN(V_DC_SYS) && V_DC_SYS < 0 ? T.ok : T.spark.cyan

  // SOC-Ring (inline SVG, kein extra Komponenten-Overhead)
  const socRingSvg = (size: number) => {
    const r = size/2 - 3
    const circ = 2 * Math.PI * r
    const filled = isNaN(V_SOC) ? 0 : Math.min(100, V_SOC)
    const offset = circ - (filled/100) * circ
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={socColor} strokeWidth={3}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 0.6s' }}/>
        <text x={size/2} y={size/2+4} textAnchor="middle" fontSize={10}
          fill={T.text} fontWeight={700} fontFamily={T.fontMono}>
          {isNaN(V_SOC) ? '…' : `${Math.round(V_SOC)}%`}
        </text>
      </svg>
    )
  }

  // Formatierungs-Helfer
  const fw = (n: number, d = 0) => isNaN(n) ? '…' : n.toFixed(d)
  const fr = (n: number) => isNaN(n) ? '…' : String(Math.round(n))

  // Phasenzeilen
  const PhaseRows = ({ l1, l2, l3 }: { l1: number; l2: number; l3: number }) => (
    <div style={{ marginTop: 6 }}>
      {([['L1', l1], ['L2', l2], ['L3', l3]] as [string, number][]).map(([l, v]) => (
        <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 1 }}>
          <span style={{ color: T.muted }}>{l}</span>
          <span style={{ color: v < 0 ? T.ok : T.text, fontWeight: 700 }}>
            {isNaN(v) ? '…' : `${Math.round(v)} W`}
          </span>
        </div>
      ))}
    </div>
  )

  // ── Mobil: einfache Card-Liste mit Pfeil-Divider ────────────────────
  const MobileFlowCard = ({ accent, highlight=false, children }: {
    accent: string; highlight?: boolean; children: React.ReactNode
  }) => (
    <div style={{ ...fc(accent, highlight), marginBottom: 0 }}>{children}</div>
  )

  const MobileArrow = ({ active, color, reverse=false }: { active: boolean; color: string; reverse?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
      <svg width="24" height="28" viewBox="0 0 24 28">
        <line x1="12" y1={reverse?22:6} x2="12" y2={reverse?6:22}
          stroke={active ? color : 'rgba(255,255,255,0.15)'}
          strokeWidth={active ? 2 : 1.5}
          strokeDasharray={active ? '5 3' : undefined}
          style={active ? { animation: (reverse?'flow-rev':'flow-fwd') + ' 0.7s linear infinite' } : {}}
        />
        <polygon
          points={reverse ? '12,2 7,12 17,12' : '12,26 7,16 17,16'}
          fill={active ? color : 'rgba(255,255,255,0.15)'}
        />
      </svg>
    </div>
  )

  // ── LAYOUT A: Victron-Klon ────────────────────────────────────────────
  // Desktop: SVG mit foreignObject (pixel-genaue Verbindungslinien)
  // Mobil:   vertikale Card-Liste mit Pfeil-Divider
  const LayoutA = () => {
    const isMobile = winW < 700

    // ── Mobil-Layout ───────────────────────────────────────────────────
    if (isMobile) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <style>{`
            @keyframes flow-fwd { from{stroke-dashoffset:10} to{stroke-dashoffset:0} }
            @keyframes flow-rev { from{stroke-dashoffset:0}  to{stroke-dashoffset:10} }
          `}</style>

          {/* Zeile 1: Netz + WR nebeneinander */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <MobileFlowCard accent={netzColor}>
              <div style={{ fontSize: 9, color: netzColor, letterSpacing: '0.1em', marginBottom: 4 }}>NETZ</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: netzColor, lineHeight: 1 }}>
                {fr(Math.abs(V_GRID_TOT ?? 0))}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> W</span>
              </div>
              {[['L1', V_GRID_L1], ['L2', V_GRID_L2], ['L3', V_GRID_L3]].map(([l, v]) => (
                <div key={String(l)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 3 }}>
                  <span style={{ color: T.muted }}>{l}</span>
                  <span style={{ color: (v as number) < 0 ? T.ok : T.text, fontWeight: 700 }}>{isNaN(v as number) ? '…' : `${Math.round(v as number)} W`}</span>
                </div>
              ))}
            </MobileFlowCard>
            <MobileFlowCard accent={purpleAcc}>
              <div style={{ fontSize: 9, color: purpleAcc, letterSpacing: '0.1em', marginBottom: 4 }}>WECHSELRICHTER</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: purpleAcc, marginBottom: 6 }}>
                {isNaN(V_INV_MODE) ? '…' : (INVERTER_MODES.find(m => m.value === V_INV_MODE)?.label ?? `Mode ${V_INV_MODE}`)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 2 }}>
                <span style={{ color: T.muted }}>AC Out</span><span style={{ color: T.text, fontWeight: 700 }}>{fr(V_AC_W)} W</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 2 }}>
                <span style={{ color: T.muted }}>Spannung</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_AC_V)} V</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
                <span style={{ color: T.muted }}>Frequenz</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_AC_F, 1)} Hz</span>
              </div>
            </MobileFlowCard>
          </div>

          {/* Pfeil WR ↔ Batterie */}
          <MobileArrow active={batActive} color={batIn ? amberAcc : T.ok} reverse={!batIn} />

          {/* Batterie */}
          <MobileFlowCard accent={socColor} highlight>
            <div style={{ fontSize: 9, color: socColor, letterSpacing: '0.1em', marginBottom: 6 }}>🔋 BATTERIE · PYLONTECH</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              {socRingSvg(46)}
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: socColor }}>
                  {fw(V_BAT_V, 1)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> V</span>
                </div>
                <div style={{ marginTop: 3 }}>
                  <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>
                    {isNaN(V_BAT_STATE) ? '…' : batStateLabel(V_BAT_STATE)}
                  </Badge>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
              <span style={{ color: T.muted }}>Strom</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_BAT_A, 1)} A</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
              <span style={{ color: T.muted }}>Leistung</span><span style={{ color: T.text, fontWeight: 700 }}>{fr(V_BAT_W)} W</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
              <span style={{ color: T.muted }}>Temp</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_BAT_T, 1)} °C</span>
            </div>
          </MobileFlowCard>

          {/* Pfeile Solar + DC */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 0 }}>
            <MobileArrow active={pvActive} color={amberAcc} />
            <MobileArrow active={dcActive} color={dcColor} />
          </div>

          {/* Zeile 3: Solar + DC-Lasten + AC-Lasten */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <MobileFlowCard accent={amberAcc}>
              <div style={{ fontSize: 9, color: amberAcc, letterSpacing: '0.1em', marginBottom: 4 }}>☀ SOLAR · MPPT</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: isNaN(V_PV_W) ? T.muted : amberAcc }}>
                {fr(V_PV_W ?? 0)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> W</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 4 }}>
                <span style={{ color: T.muted }}>Status</span>
                <span style={{ color: T.text, fontWeight: 700 }}>{isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)}</span>
              </div>
            </MobileFlowCard>
            <MobileFlowCard accent={dcColor}>
              <div style={{ fontSize: 9, color: dcColor, letterSpacing: '0.1em', marginBottom: 4 }}>DC-LASTEN</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: dcColor }}>
                {fr(V_DC_SYS ?? 0)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> W</span>
              </div>
              <div style={{ fontSize: 9, color: T.muted, marginTop: 4 }}>
                {isNaN(V_DC_SYS) ? '' : V_DC_SYS < 0 ? 'DC nimmt Energie auf' : 'DC gibt Energie ab'}
              </div>
            </MobileFlowCard>
          </div>

          {/* Pfeil → AC-Lasten */}
          <MobileArrow active={consActive} color={amberAcc} />

          {/* AC-Lasten */}
          <MobileFlowCard accent={amberAcc}>
            <div style={{ fontSize: 9, color: amberAcc, letterSpacing: '0.1em', marginBottom: 4 }}>🏠 AC-LASTEN</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: amberAcc }}>
              {V_CONS_TOT === 0 && isNaN(V_CONS_L1) ? '…' : fr(V_CONS_TOT)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> W</span>
            </div>
            {[['L1', V_CONS_L1], ['L2', V_CONS_L2], ['L3', V_CONS_L3]].map(([l, v]) => (
              <div key={String(l)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 3 }}>
                <span style={{ color: T.muted }}>{l}</span>
                <span style={{ color: T.text, fontWeight: 700 }}>{isNaN(v as number) ? '…' : `${Math.round(v as number)} W`}</span>
              </div>
            ))}
          </MobileFlowCard>
        </div>
      )
    }

    // ── Desktop-Layout (SVG) ───────────────────────────────────────────
    const pos = {
      netz:    [0,   0,   270, 140],
      wr:      [315, 0,   270, 140],
      acLast:  [630, 0,   270, 140],
      solar:   [0,   200, 270, 140],
      batt:    [315, 200, 270, 140],
      dcLast:  [630, 200, 270, 140],
    } as Record<string, [number,number,number,number]>
    const mid = (p: [number,number,number,number]) => [p[0]+p[2]/2, p[1]+p[3]/2] as [number,number]
    const right = (p: [number,number,number,number]) => [p[0]+p[2], p[1]+p[3]/2] as [number,number]
    const left  = (p: [number,number,number,number]) => [p[0],      p[1]+p[3]/2] as [number,number]
    const bot   = (p: [number,number,number,number]) => [p[0]+p[2]/2, p[1]+p[3]] as [number,number]
    const top   = (p: [number,number,number,number]) => [p[0]+p[2]/2, p[1]]      as [number,number]

    return (
      <div style={{ position: 'relative', width: '100%' }}>
        <svg viewBox="0 0 900 360" style={{ width: '100%', display: 'block', overflow: 'visible' }} preserveAspectRatio="xMidYMid meet">
          <defs>
            <style>{`
              @keyframes flow-fwd { from{stroke-dashoffset:10} to{stroke-dashoffset:0} }
              @keyframes flow-rev { from{stroke-dashoffset:0}  to{stroke-dashoffset:10} }
            `}</style>
          </defs>

          {/* Verbindungslinien */}
          <FlowLine x1={right(pos.netz)[0]+10} y1={right(pos.netz)[1]} x2={left(pos.wr)[0]-10} y2={left(pos.wr)[1]}
            active={netActive} color={netzColor} reverse={!netIn} />
          <FlowLine x1={right(pos.wr)[0]+10} y1={right(pos.wr)[1]} x2={left(pos.acLast)[0]-10} y2={left(pos.acLast)[1]}
            active={consActive} color={amberAcc} />
          <FlowLine x1={right(pos.solar)[0]+10} y1={right(pos.solar)[1]} x2={left(pos.batt)[0]-10} y2={left(pos.batt)[1]}
            active={pvActive} color={amberAcc} />
          <FlowLine x1={bot(pos.wr)[0]} y1={bot(pos.wr)[1]+10} x2={top(pos.batt)[0]} y2={top(pos.batt)[1]-10}
            active={batActive} color={batIn ? amberAcc : T.ok} reverse={!batIn} />
          <FlowLine x1={right(pos.batt)[0]+10} y1={right(pos.batt)[1]} x2={left(pos.dcLast)[0]-10} y2={left(pos.dcLast)[1]}
            active={dcActive} color={dcColor} />

          {/* Kacheln als foreignObject */}
          {Object.entries(pos).map(([key, [x, y, w, h]]) => (
            <foreignObject key={key} x={x} y={y} width={w} height={h}>
              <div style={{ width: '100%', height: '100%', ...fc(
                key==='netz'  ? netzColor :
                key==='wr'    ? purpleAcc :
                key==='acLast'? amberAcc  :
                key==='solar' ? amberAcc  :
                key==='batt'  ? socColor  :
                dcColor,
                key === 'batt'
              ) }}>

                {key === 'netz' && <>
                  <div style={{ fontSize: 9, color: netzColor, letterSpacing: '0.1em', marginBottom: 4 }}>NETZ</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: isNaN(V_GRID_TOT) ? T.muted : netzColor, lineHeight: 1 }}>
                    {fr(Math.abs(V_GRID_TOT ?? 0))}<span style={{ fontSize: 11, color: T.muted, fontWeight: 400 }}> W</span>
                  </div>
                  <PhaseRows l1={V_GRID_L1} l2={V_GRID_L2} l3={V_GRID_L3} />
                </>}

                {key === 'wr' && <>
                  <div style={{ fontSize: 9, color: purpleAcc, letterSpacing: '0.1em', marginBottom: 4 }}>WECHSELRICHTER · MULTIPLUS</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: purpleAcc, marginBottom: 8 }}>
                    {isNaN(V_INV_MODE) ? '…' : (INVERTER_MODES.find(m => m.value === V_INV_MODE)?.label ?? `Mode ${V_INV_MODE}`)}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>AC Out</span><span style={{ color: T.text, fontWeight: 700 }}>{fr(V_AC_W)} W</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>Spannung</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_AC_V)} V</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                    <span style={{ color: T.muted }}>Frequenz</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_AC_F, 1)} Hz</span>
                  </div>
                </>}

                {key === 'acLast' && <>
                  <div style={{ fontSize: 9, color: amberAcc, letterSpacing: '0.1em', marginBottom: 4 }}>AC-LASTEN</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: amberAcc, lineHeight: 1 }}>
                    {V_CONS_TOT === 0 && isNaN(V_CONS_L1) ? '…' : fr(V_CONS_TOT)}<span style={{ fontSize: 11, color: T.muted, fontWeight: 400 }}> W</span>
                  </div>
                  <PhaseRows l1={V_CONS_L1} l2={V_CONS_L2} l3={V_CONS_L3} />
                </>}

                {key === 'solar' && <>
                  <div style={{ fontSize: 9, color: amberAcc, letterSpacing: '0.1em', marginBottom: 4 }}>SOLARERTRAG · MPPT</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: isNaN(V_PV_W) ? T.muted : amberAcc, lineHeight: 1 }}>
                    {fr(V_PV_W ?? 0)}<span style={{ fontSize: 11, color: T.muted, fontWeight: 400 }}> W</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 6, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>PV Spannung</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_PV_V)} V</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                    <span style={{ color: T.muted }}>Status</span><span style={{ color: T.text, fontWeight: 700 }}>{isNaN(V_MPPT_STATE) ? '…' : mpptStateLabel(V_MPPT_STATE)}</span>
                  </div>
                </>}

                {key === 'batt' && <>
                  <div style={{ fontSize: 9, color: socColor, letterSpacing: '0.1em', marginBottom: 6 }}>BATTERIE · PYLONTECH</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    {socRingSvg(46)}
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: socColor }}>
                        {fw(V_BAT_V, 1)}<span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}> V</span>
                      </div>
                      <div style={{ marginTop: 3 }}>
                        <Badge color={V_BAT_STATE === 1 ? T.ok : V_BAT_STATE === 2 ? amberAcc : T.muted}>
                          {isNaN(V_BAT_STATE) ? '…' : batStateLabel(V_BAT_STATE)}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>Strom</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_BAT_A, 1)} A</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>Leistung</span><span style={{ color: T.text, fontWeight: 700 }}>{fr(V_BAT_W)} W</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                    <span style={{ color: T.muted }}>Temp</span><span style={{ color: T.text, fontWeight: 700 }}>{fw(V_BAT_T, 1)} °C</span>
                  </div>
                  {batLife && <>
                    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 5, paddingTop: 5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 2 }}>
                        <span style={{ color: T.muted }}>Zyklen (est.)</span>
                        <span style={{ color: T.text, fontWeight: 700 }}>{batLife.cyclesUsed} / {BAT_CYCLES_MAX}</span>
                      </div>
                      <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, margin: '3px 0' }}>
                        <div style={{ width: `${Math.min(batLife.pctUsed, 100)}%`, height: '100%', borderRadius: 2,
                          background: batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                        <span style={{ color: T.muted }}>Restlaufzeit (est.)</span>
                        <span style={{ color: batLife.pctUsed < 50 ? T.ok : T.warn, fontWeight: 700 }}>
                          ~{batLife.yearsRemaining} Jahre
                        </span>
                      </div>
                    </div>
                  </>}
                </>}

                {key === 'dcLast' && <>
                  <div style={{ fontSize: 9, color: dcColor, letterSpacing: '0.1em', marginBottom: 4 }}>DC-LASTEN · SYSTEM</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: dcColor, lineHeight: 1 }}>
                    {fr(V_DC_SYS ?? 0)}<span style={{ fontSize: 11, color: T.muted, fontWeight: 400 }}> W</span>
                  </div>
                  <div style={{ fontSize: 10, color: T.muted, marginTop: 6 }}>
                    {isNaN(V_DC_SYS) ? '' : V_DC_SYS < 0 ? 'DC nimmt Energie auf' : 'DC gibt Energie ab'}
                  </div>
                </>}

              </div>
            </foreignObject>
          ))}
        </svg>
      </div>
    )
  }

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

              {/* Batterie-Lebensdauer */}
              {batLife && (
                <Card accentColor={batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err}>
                  <CardLabel icon="⏳" color={batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err}>Batterie · Lebensdauer</CardLabel>
                  <div style={{ marginBottom: 6 }}>
                    <Sub>Restlaufzeit (geschätzt)</Sub>
                    <div style={{ fontSize: 21, fontWeight: 700, fontFamily: T.fontMono,
                      color: batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err }}>
                      ~{batLife.yearsRemaining} <span style={{ fontSize: 12, fontWeight: 400, color: T.muted }}>Jahre</span>
                    </div>
                  </div>
                  <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, marginBottom: 6 }}>
                    <div style={{ width: `${Math.min(batLife.pctUsed, 100)}%`, height: '100%', borderRadius: 2, transition: 'width 0.5s',
                      background: batLife.pctUsed < 50 ? T.ok : batLife.pctUsed < 80 ? T.warn : T.err }} />
                  </div>
                  <StatRow label="Zyklen (est.)"   value={`${batLife.cyclesUsed} / ${BAT_CYCLES_MAX}`} />
                  <StatRow label="Verbrauch"       value={`${batLife.pctUsed}%`} />
                  <StatRow label="Ø Durchsatz/Tag" value={`${batLife.dailyAvgKwh} kWh`} />
                  <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 5, lineHeight: 1.5 }}>
                    Pylontech US3000C · {BAT_CYCLES_MAX} Zyklen bei {BAT_DOD*100}% DoD<br/>
                    Basis: {batLife.daysTracked} Tage Messdaten (wird genauer mit der Zeit)
                  </div>
                </Card>
              )}

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
        {activeTab === 'energie' && (() => {
          const bkwRaw     = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'])
          const bkwKwh     = !isNaN(bkwRaw) ? bkwRaw + 178.779 : NaN
          const victronKwh = parseFloat(values[V('solarcharger/288/Yield/System')] ?? 'NaN')
          const solarTotal = (!isNaN(bkwKwh) ? bkwKwh : 0) + (!isNaN(victronKwh) ? victronKwh : 0)
          const hasSolar   = !isNaN(bkwKwh) || !isNaN(victronKwh)

          // BKW heute/gestern aus SENSOR-Payload
          const bkwToday     = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPToday.0'] ?? 'NaN')
          const bkwYesterday = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPYesterday.0'] ?? 'NaN')
          const pvToday      = parseFloat(values[V('solarcharger/288/History/Daily/0/Yield')] ?? 'NaN')
          const pvYesterday  = parseFloat(values[V('solarcharger/288/History/Daily/1/Yield')] ?? 'NaN')

          return (
            <>
              {/* Sub-Navigation */}
              <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
                {([
                  ['ueberblick', 'Überblick'],
                  ['phasen',     'Phasen L1–L3'],
                  ['details',    'Erzeugung & Netz'],
                ] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setEnergieTab(id)} style={{
                    padding: '4px 13px', borderRadius: 20, fontSize: 11,
                    fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.06em',
                    cursor: 'pointer', transition: 'all 0.15s',
                    border: energieTab === id ? `1px solid ${T.spark.cyan}88` : '1px solid rgba(255,255,255,0.1)',
                    background: energieTab === id ? T.spark.cyan + '20' : 'transparent',
                    color: energieTab === id ? T.spark.cyan : T.muted,
                  }}>{label}</button>
                ))}
              </div>

              {/* ── ÜBERBLICK ── */}
              {energieTab === 'ueberblick' && (
                <>
                  <FlowBanner />

                  {/* Zähler-Kacheln: 3 nebeneinander */}
                  <div className="grid-groups" style={{ marginBottom: 8 }}>

                    {/* Strom-Zähler */}
                    <Card accentColor={T.err}>
                      <CardLabel icon="⚡" color={T.err}>Strom</CardLabel>
                      <div style={{ marginBottom: 8 }}>
                        <Sub>Verbrauch gesamt</Sub>
                        <BigVal value={values['Stromzähler/Verbrauch_gesamt'] ?? '…'} unit="kWh" size={18} />
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <Sub>Eingespeist gesamt</Sub>
                        <BigVal value={values['Stromzähler/Eingespeist_gesamt'] ?? '…'} unit="kWh" size={18} color={T.ok} />
                      </div>
                      <Div />
                      <Sub>Aktuell</Sub>
                      {(() => {
                        const num = parseFloat(values['Stromzähler/Verbrauch_aktuell'])
                        const col = leistungColor(num)
                        const range = minMax['Stromzähler/Verbrauch_aktuell'] ?? { min: num, max: num }
                        return <>
                          <BigVal value={isNaN(num) ? '…' : `${num}`} unit="W" size={18} color={col} />
                          <MinMaxRow min={range.min} max={range.max} unit=" W" />
                        </>
                      })()}
                    </Card>

                    {/* Solar-Zähler */}
                    <Card accentColor={T.ok}>
                      <CardLabel icon="🌿" color={T.ok}>Solar & Erzeugung</CardLabel>
                      <div style={{ marginBottom: 8 }}>
                        <Sub>Solar gesamt (BKW + Victron)</Sub>
                        <BigVal value={hasSolar ? solarTotal.toFixed(2) : '…'} unit="kWh" size={18} color={T.ok} />
                        {hasSolar && (
                          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>
                            {!isNaN(bkwKwh) && `${bkwKwh.toFixed(1)} BKW`}
                            {!isNaN(bkwKwh) && !isNaN(victronKwh) && ' + '}
                            {!isNaN(victronKwh) && `${victronKwh.toFixed(1)} Victron`}
                          </div>
                        )}
                      </div>
                      <Div />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 5 }}>
                        <div>
                          <Sub>BKW heute</Sub>
                          <BigVal value={isNaN(bkwToday) ? '…' : bkwToday.toFixed(2)} unit="kWh" size={15} color={T.ok} />
                        </div>
                        <div>
                          <Sub>BKW gestern</Sub>
                          <BigVal value={isNaN(bkwYesterday) ? '…' : bkwYesterday.toFixed(2)} unit="kWh" size={15} />
                        </div>
                        <div>
                          <Sub>Victron heute</Sub>
                          <BigVal value={isNaN(pvToday) ? '…' : pvToday.toFixed(2)} unit="kWh" size={15} color={amberAcc} />
                        </div>
                        <div>
                          <Sub>Victron gestern</Sub>
                          <BigVal value={isNaN(pvYesterday) ? '…' : pvYesterday.toFixed(2)} unit="kWh" size={15} />
                        </div>
                      </div>
                      <Div />
                      <Sub>Aktuell erzeugt</Sub>
                      <BigVal value={totalGen > 0 || !isNaN(BKW_W) ? `${Math.round(totalGen)}` : '…'} unit="W" size={18} color={genColor} />
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>
                        PV: {isNaN(V_PV_W) ? '…' : `${Math.round(V_PV_W)} W`} · Balkon: {isNaN(BKW_W) ? '…' : `${Math.round(BKW_W)} W`}
                      </div>
                    </Card>

                    {/* Gas */}
                    <Card accentColor={T.warn}>
                      <CardLabel icon="🔥" color={T.warn}>Gas & Sonstiges</CardLabel>
                      <div style={{ marginBottom: 8 }}>
                        <Sub>Gasverbrauch gesamt</Sub>
                        <BigVal value={values['Gaszaehler/stand'] ?? '…'} unit="m³" size={18} color={T.warn} />
                      </div>
                      <Div />
                      <Sub>Hausverbrauch aktuell (Venus OS)</Sub>
                      <BigVal value={hausverbrauch === 0 && isNaN(consL1) ? '…' : `${Math.round(hausverbrauch)}`} unit="W" size={18} />
                      {!isNaN(verbrauch) && !isNaN(totalGen) && (
                        <div style={{ marginTop: 5, fontSize: 11, color: uebColor, fontFamily: T.fontMono, fontWeight: 700 }}>
                          {ueberschuss >= 0 ? `+${Math.round(ueberschuss)} W Überschuss` : `${Math.round(ueberschuss)} W Defizit`}
                        </div>
                      )}
                    </Card>

                  </div>
                </>
              )}

              {/* ── PHASEN ── */}
              {energieTab === 'phasen' && (
                <div className="grid-groups">
                  {groupTopics.map(group => (
                    <PhasenCard key={group.label} group={group} values={values} minMax={minMax} hist={hist} />
                  ))}
                </div>
              )}

              {/* ── ERZEUGUNG & NETZ ── */}
              {energieTab === 'details' && (
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
                    {!isNaN(BKW_W) && <Bar value={BKW_W} max={800} color={BKW_W >= 200 ? T.ok : T.warn} />}
                    {(hist['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0'] ?? []).length >= 2 && (
                      <div style={{ marginTop: 4 }}><Sparkline data={hist['tele/Balkonkraftwerk/SENSOR.ENERGY.Power.0']} color={T.ok} /></div>
                    )}
                    <Div />
                    <StatRow label="Heute"   value={isNaN(bkwToday)     ? '…' : `${bkwToday.toFixed(2)} kWh`} />
                    <StatRow label="Gestern" value={isNaN(bkwYesterday) ? '…' : `${bkwYesterday.toFixed(2)} kWh`} />
                    <StatRow label="Gesamt"  value={hasSolar ? `${solarTotal.toFixed(2)} kWh` : '…'} />
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
              )}
            </>
          )
        })()}

        {/* ══ TAB: VICTRON ════════════════════════════════════════════════ */}
        {activeTab === 'victron' && <LayoutA />}


        {/* ══ TAB: VERLAUF ════════════════════════════════════════════════ */}
        {activeTab === 'verlauf' && (() => {
          // Aktiver Datensatz je nach Zeitraum
          const periodData: StatDay[] = verlaufZr === 'heute'
            ? (statHeute ? [statHeute] : [])
            : verlaufZr === 'woche'  ? (statWoche?.tage  ?? [])
            : verlaufZr === 'monat'  ? (statMonat?.tage  ?? [])
            :                          (statJahr?.tage   ?? [])

          const periodSum = verlaufZr === 'woche' ? statWoche
                          : verlaufZr === 'monat' ? statMonat
                          : verlaufZr === 'jahr'  ? statJahr : null

          const hasData = periodData.length > 0

          // Balken-Chart: SVG, normiert auf max-Wert
          const maxV = Math.max(...periodData.map(d => d.verbrauch_kwh  ?? 0), 1)
          const maxE = Math.max(...periodData.map(d => d.erzeugung_kwh ?? 0), 1)
          const maxAll = Math.max(maxV, maxE, 1)

          const barW  = verlaufZr === 'jahr' ? 8 : verlaufZr === 'monat' ? 14 : verlaufZr === 'woche' ? 28 : 60
          const barGap = 4
          const chartH = 120
          const totalW = Math.max(periodData.length * (barW * 2 + barGap + 4), 300)

          // SOC-Linienchart
          const socData = periodData.filter(d => d.soc_avg !== null)

          const formatDate = (s: string) => {
            const d = new Date(s + 'T12:00:00')
            return verlaufZr === 'jahr'
              ? `${d.getDate()}.${d.getMonth()+1}.`
              : verlaufZr === 'monat'
              ? `${d.getDate()}.`
              : verlaufZr === 'woche'
              ? ['So','Mo','Di','Mi','Do','Fr','Sa'][d.getDay()]
              : s
          }

          const fkwh = (v: number|null) => v === null ? '–' : `${v.toFixed(1)} kWh`

          return (
            <div>
              {/* Navigation: Zeitraum + Ansicht */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                {([
                  ['heute',  'Heute'],
                  ['woche',  '7 Tage'],
                  ['monat',  'Monat'],
                  ['jahr',   'Jahr'],
                  ['gesamt', 'Gesamt'],
                ] as const).map(([zr, label]) => (
                  <button key={zr} onClick={() => { setVerlaufZr(zr); setVerlaufDetail(null); setDrillData(null); setDrillLabel(''); }} style={{
                    padding: '5px 16px', borderRadius: 20, fontSize: 11,
                    fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.07em',
                    cursor: 'pointer', transition: 'all 0.15s', textTransform: 'uppercase',
                    border: verlaufZr === zr ? `1px solid ${T.ok}88` : '1px solid rgba(255,255,255,0.1)',
                    background: verlaufZr === zr ? T.ok + '20' : 'transparent',
                    color: verlaufZr === zr ? T.ok : T.muted,
                  }}>{label}</button>
                ))}
              </div>
              {/* Ansicht-Umschalter: Strom / Gas */}
              {verlaufZr !== 'gesamt' && (
                <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
                  {([['strom', '⚡ Strom & Solar'], ['gas', '🔥 Gas']] as const).map(([a, label]) => (
                    <button key={a} onClick={() => { setVerlaufAnsicht(a); setVerlaufDetail(null); setDrillData(null); setDrillLabel(''); }} style={{
                      padding: '3px 13px', borderRadius: 20, fontSize: 11,
                      fontFamily: T.fontLabel, fontWeight: 700, letterSpacing: '0.06em',
                      cursor: 'pointer', transition: 'all 0.15s',
                      border: verlaufAnsicht === a
                        ? `1px solid ${a === 'gas' ? T.warn : T.spark.cyan}88`
                        : '1px solid rgba(255,255,255,0.08)',
                      background: verlaufAnsicht === a ? (a === 'gas' ? T.warn : T.spark.cyan) + '18' : 'transparent',
                      color: verlaufAnsicht === a ? (a === 'gas' ? T.warn : T.spark.cyan) : T.muted,
                    }}>{label}</button>
                  ))}
                </div>
              )}

              {/* Zusammenfassung-Kacheln – nur Strom */}
              {verlaufAnsicht === 'strom' && periodSum && (() => {
                const days = verlaufZr === 'woche' ? 7 : verlaufZr === 'monat' ? 30 : 365
                const euro = calcEuro(periodSum.verbrauch_kwh, periodSum.erzeugung_kwh, days)
                const bilanz = (periodSum.erzeugung_kwh ?? 0) - (periodSum.verbrauch_kwh ?? 0)
                const bilCol = bilanz >= 0 ? T.ok : T.err
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                    <Card accentColor={T.err}>
                      <CardLabel icon="⚡" color={T.err}>Verbrauch</CardLabel>
                      <BigVal value={fkwh(periodSum.verbrauch_kwh)} size={18} color={T.err} />
                      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>
                        Kosten: {euro.cost.toFixed(2)} €
                      </div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono }}>
                        inkl. {euro.gp.toFixed(2)} € Grundpreis
                      </div>
                    </Card>
                    <Card accentColor={T.ok}>
                      <CardLabel icon="🌿" color={T.ok}>Erzeugung</CardLabel>
                      <BigVal value={fkwh(periodSum.erzeugung_kwh)} size={18} color={T.ok} />
                      <div style={{ fontSize: 11, color: T.ok, fontFamily: T.fontMono, marginTop: 4 }}>
                        Ersparnis: {euro.save.toFixed(2)} €
                      </div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono }}>
                        BKW: {fkwh(periodSum.bkw_kwh)} · PV: {fkwh(periodSum.solar_kwh)}
                      </div>
                    </Card>
                    <Card accentColor={bilCol}>
                      <CardLabel icon="⚖️" color={bilCol}>Bilanz</CardLabel>
                      <BigVal value={`${bilanz >= 0 ? '+' : ''}${bilanz.toFixed(1)} kWh`} size={18} color={bilCol} />
                      <div style={{ fontSize: 12, color: euro.net >= 0 ? T.ok : T.err, fontFamily: T.fontMono, marginTop: 4, fontWeight: 700 }}>
                        {euro.net >= 0 ? `Gespart: +${euro.net.toFixed(2)} €` : `Kosten: ${euro.net.toFixed(2)} €`}
                      </div>
                    </Card>
                  </div>
                )
              })()}

              {/* Heute: einzelne Werte */}
              {/* Heute Gas */}
              {verlaufZr === 'heute' && verlaufAnsicht === 'gas' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 12 }}>
                  <Card accentColor={T.warn}>
                    <CardLabel icon="🔥" color={T.warn}>Gas heute</CardLabel>
                    {statHeute?.gas_m3 != null
                      ? <>
                          <BigVal value={statHeute.gas_m3.toFixed(3)} unit="m³" size={21} color={T.warn} />
                          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>
                            ≈ {(statHeute.gas_m3 * 10 * 0.11).toFixed(2)} € Kosten
                          </div>
                        </>
                      : <div style={{ fontSize: 12, color: T.muted, fontFamily: T.fontMono }}>Noch keine Gas-Daten heute</div>
                    }
                  </Card>
                  <Card accentColor={T.muted as string}>
                    <CardLabel icon="📊" color={T.spark.cyan}>Zählerstand</CardLabel>
                    <BigVal value={values['Gaszaehler/stand'] ?? '…'} unit="m³" size={21} />
                  </Card>
                </div>
              )}

              {verlaufZr === 'heute' && verlaufAnsicht === 'strom' && statHeute && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                    <Card accentColor={T.err}>
                      <CardLabel icon="⚡" color={T.err}>Verbrauch heute</CardLabel>
                      <BigVal value={fkwh(statHeute.verbrauch_kwh)} size={18} color={T.err} />
                    </Card>
                    <Card accentColor={T.ok}>
                      <CardLabel icon="🌿" color={T.ok}>Erzeugung heute</CardLabel>
                      <BigVal value={fkwh(statHeute.erzeugung_kwh)} size={18} color={T.ok} />
                      <div style={{ fontSize: 10, color: T.muted, marginTop: 3, fontFamily: T.fontMono }}>
                        BKW: {fkwh(statHeute.bkw_kwh)} · PV: {fkwh(statHeute.solar_kwh)}
                      </div>
                    </Card>
                    <Card accentColor={uebColor}>
                      <CardLabel icon="⚖️" color={uebColor}>Bilanz heute</CardLabel>
                      {(() => {
                        const b = (statHeute.erzeugung_kwh ?? 0) - (statHeute.verbrauch_kwh ?? 0)
                        const col = b >= 0 ? T.ok : T.err
                        return <BigVal value={`${b >= 0 ? '+' : ''}${b.toFixed(1)} kWh`} size={18} color={col} />
                      })()}
                    </Card>
                  </div>
                  {/* SOC-Tagesverlauf aus Live-Daten */}
                  {verlaufAnsicht === 'strom' && (hist[VICTRON_TOPICS.soc] ?? []).length >= 2 && (
                    <Card accentColor={T.spark.cyan} style={{ marginBottom: 12, padding: '12px 13px' }}>
                      <CardLabel icon="🔋" color={T.spark.cyan}>Batterie SOC – heute</CardLabel>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 4 }}>
                        <span>Min: {statHeute.soc_min ?? Math.min(...(hist[VICTRON_TOPICS.soc] ?? []).filter(v=>!isNaN(v))).toFixed(0)}%</span>
                        <span>Ø {statHeute.soc_avg ?? Math.round((hist[VICTRON_TOPICS.soc] ?? []).reduce((a,b)=>a+b,0)/Math.max((hist[VICTRON_TOPICS.soc]??[]).length,1))}%</span>
                        <span>Max: {statHeute.soc_max ?? Math.max(...(hist[VICTRON_TOPICS.soc] ?? []).filter(v=>!isNaN(v))).toFixed(0)}%</span>
                      </div>
                      <Sparkline data={hist[VICTRON_TOPICS.soc]} color={T.spark.cyan} height={50} />
                    </Card>
                  )}
                </>
              )}

              {!hasData && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: T.muted, fontFamily: T.fontMono, fontSize: 13 }}>
                  Keine Daten – ioBroker stats_service noch nicht gestartet?
                </div>
              )}

              {/* ── STROM & SOLAR ANSICHT ── */}
              {verlaufAnsicht === 'strom' && <>

              {/* Balken-Chart mit Drill-Down */}
              {hasData && verlaufZr !== 'heute' && verlaufZr !== 'gesamt' && (() => {
                // Drill-down: wenn drillData gesetzt, dieses anzeigen
                const chartData = drillData ?? periodData
                const cLabel    = drillData ? drillLabel : 'Verbrauch vs. Erzeugung'
                const cMaxV = Math.max(...chartData.map(d => d.verbrauch_kwh  ?? 0), 1)
                const cMaxE = Math.max(...chartData.map(d => d.erzeugung_kwh ?? 0), 1)
                const cMaxAll = Math.max(cMaxV, cMaxE, 1)
                const cBarW = drillData ? 28
                  : verlaufZr === 'jahr' ? 8 : verlaufZr === 'monat' ? 14 : 28
                const cTotalW = Math.max(chartData.length * (cBarW * 2 + barGap + 4), 300)

                // Drill-down Logik: Jahr→Monat, Monat→Woche, Woche→Tag
                const handleBarClick = (d: StatDay) => {
                  if (drillData) {
                    // Bereits gebohrt: Detail anzeigen
                    setVerlaufDetail(verlaufDetail?.date === d.date ? null : d)
                    return
                  }
                  if (verlaufZr === 'jahr' || verlaufZr === 'monat') {
                    // Auf Monat/Woche drill-down
                    const month = d.date.slice(0, 7)
                    const filtered = statTage.filter(t => t.date.startsWith(month))
                    if (filtered.length > 0) {
                      setDrillData(filtered)
                      setDrillLabel(`${month} – Tagesverlauf`)
                      setVerlaufDetail(null)
                    }
                  } else {
                    setVerlaufDetail(verlaufDetail?.date === d.date ? null : d)
                  }
                }

                const cFormatDate = (s: string) => {
                  if (drillData) {
                    const d = new Date(s + 'T12:00:00')
                    return `${d.getDate()}.`
                  }
                  return formatDate(s)
                }

                return (
                  <Card accentColor={T.spark.power} style={{ marginBottom: 12, padding: '12px 13px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <CardLabel icon="📊" color={T.spark.power}>{cLabel}</CardLabel>
                      {drillData && (
                        <button onClick={() => { setDrillData(null); setDrillLabel(''); setVerlaufDetail(null); }} style={{
                          marginLeft: 'auto', padding: '2px 10px', borderRadius: 12, fontSize: 10,
                          fontFamily: T.fontLabel, cursor: 'pointer', border: `1px solid rgba(255,255,255,0.15)`,
                          background: 'transparent', color: T.muted,
                        }}>← zurück</button>
                      )}
                    </div>
                    <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                      <svg width={Math.max(cTotalW, 300)} height={chartH + 40} style={{ display: 'block' }}>
                        {chartData.map((d, i) => {
                          const x = i * (cBarW * 2 + barGap + 4)
                          const vH = d.verbrauch_kwh  ? (d.verbrauch_kwh  / cMaxAll) * chartH : 0
                          const eH = d.erzeugung_kwh ? (d.erzeugung_kwh / cMaxAll) * chartH : 0
                          const isSelected = verlaufDetail?.date === d.date
                          const isHov = hoveredBar?.d.date === d.date
                          return (
                            <g key={d.date}
                              onClick={() => handleBarClick(d)}
                              onMouseEnter={() => setHoveredBar({ d, x: x + cBarW, y: Math.min(chartH - vH, chartH - eH) })}
                              onMouseLeave={() => setHoveredBar(null)}
                              style={{ cursor: 'pointer' }}>
                              <rect x={x} y={chartH - vH} width={cBarW} height={vH}
                                fill={T.err} opacity={isSelected || isHov ? 1 : 0.75} rx={2} />
                              <rect x={x + cBarW + 2} y={chartH - eH} width={cBarW} height={eH}
                                fill={T.ok} opacity={isSelected || isHov ? 1 : 0.75} rx={2} />
                              {(isSelected || isHov) && <rect x={x-1} y={0} width={cBarW*2+4} height={chartH}
                                fill="rgba(255,255,255,0.04)" rx={2} />}
                              <text x={x + cBarW} y={chartH + 14} textAnchor="middle"
                                fontSize={9} fill="rgba(224,234,255,0.4)" fontFamily={T.fontMono}>
                                {cFormatDate(d.date)}
                              </text>
                            </g>
                          )
                        })}
                        {/* Hover-Tooltip */}
                        {hoveredBar && (() => {
                          const td   = hoveredBar.d
                          const tw   = 160
                          const tx   = Math.min(hoveredBar.x, Math.max(cTotalW,300) - tw - 5)
                          const ty   = Math.max(55, (hoveredBar.y ?? 20))
                          const days = verlaufZr === 'woche' ? 1 : verlaufZr === 'monat' ? 1 : verlaufZr === 'jahr' ? 30 : 1
                          const euro = calcEuro(td.verbrauch_kwh, td.erzeugung_kwh, days)
                          const netCol = euro.net >= 0 ? '#34d399' : '#f87171'
                          return (
                            <g style={{ pointerEvents: 'none' }}>
                              <rect x={tx - 4} y={ty - 60} width={tw + 8} height={64} rx={5}
                                fill="#0a0f1a" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
                              <text x={tx} y={ty - 44} fontSize={11} fill={T.text} fontFamily={T.fontMono} fontWeight={700}>
                                {td.date}
                              </text>
                              <text x={tx} y={ty - 28} fontSize={10} fill={T.err} fontFamily={T.fontMono}>
                                {'▼ ' + (td.verbrauch_kwh != null ? td.verbrauch_kwh.toFixed(2) : '–') + ' kWh'}
                              </text>
                              <text x={tx + tw/2} y={ty - 28} fontSize={10} fill={T.ok} fontFamily={T.fontMono}>
                                {'▲ ' + (td.erzeugung_kwh != null ? td.erzeugung_kwh.toFixed(2) : '–') + ' kWh'}
                              </text>
                              <text x={tx} y={ty - 12} fontSize={10} fill={netCol} fontFamily={T.fontMono} fontWeight={700}>
                                {euro.net >= 0 ? 'Gespart: ' : 'Kosten:  '}
                                {Math.abs(euro.net).toFixed(2)} €
                              </text>
                            </g>
                          )
                        })()}
                        {[0.25, 0.5, 0.75, 1].map(f => (
                          <g key={f}>
                            <line x1={0} y1={chartH * (1-f)} x2={Math.max(cTotalW,300)} y2={chartH * (1-f)}
                              stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                            <text x={Math.max(cTotalW,300) - 2} y={chartH * (1-f) - 2} textAnchor="end"
                              fontSize={8} fill="rgba(224,234,255,0.3)" fontFamily={T.fontMono}>
                              {(cMaxAll * f).toFixed(1)}
                            </text>
                          </g>
                        ))}
                      </svg>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 10, fontFamily: T.fontMono, color: T.muted }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 10, height: 10, background: T.err, borderRadius: 2, display: 'inline-block' }} />Verbrauch
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 10, height: 10, background: T.ok, borderRadius: 2, display: 'inline-block' }} />Erzeugung
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        {!drillData && (verlaufZr === 'jahr' || verlaufZr === 'monat')
                          ? 'Balken anklicken → Monatsdetail'
                          : 'Balken anklicken für Details'}
                      </span>
                    </div>
                  </Card>
                )
              })()}

              {/* SOC-Verlauf mit Hover */}
              {hasData && verlaufZr !== 'heute' && verlaufZr !== 'gesamt' && socData.length >= 2 && (() => {
                const svgW   = Math.max(totalW, 300)
                const svgH   = 90
                const padL   = 26, padB = 20
                const cW     = svgW - padL
                const cH     = svgH - padB
                const step   = cW / (socData.length - 1)
                const toX    = (i: number) => padL + i * step
                const toY    = (v: number) => cH - (v / 100) * (cH - 4)
                const pts_max = socData.map((d, i) => `${toX(i)},${toY(d.soc_max!)}`).join(' ')
                const pts_min = socData.map((d, i) => `${toX(i)},${toY(d.soc_min!)}`).join(' ')
                const pts_avg = socData.map((d, i) => `${toX(i)},${toY(d.soc_avg!)}`).join(' ')
                const area    = pts_max + ' ' + [...socData].reverse().map((d, i) => `${toX(socData.length-1-i)},${toY(d.soc_min!)}`).join(' ')
                return (
                  <Card accentColor={T.spark.cyan} style={{ marginBottom: 12, padding: '12px 13px' }}>
                    <CardLabel icon="🔋" color={T.spark.cyan}>Batterie SOC-Verlauf</CardLabel>
                    <div style={{ overflowX: 'auto' }}>
                      <svg width={svgW} height={svgH} style={{ display: 'block' }}
                        onMouseMove={e => {
                          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
                          const mx   = (e.clientX - rect.left) * (svgW / rect.width)
                          const idx  = Math.round((mx - padL) / step)
                          if (idx >= 0 && idx < socData.length) {
                            setHoveredBar({ d: socData[idx], x: toX(idx), y: toY(socData[idx].soc_avg ?? 50) })
                          }
                        }}
                        onMouseLeave={() => setHoveredBar(null)}>
                        {/* Min/Max Fläche */}
                        <polygon points={area} fill={T.spark.cyan} opacity={0.08} />
                        <polyline points={pts_max} fill="none" stroke={T.spark.cyan} strokeWidth={1} opacity={0.35} strokeDasharray="3 2" />
                        <polyline points={pts_min} fill="none" stroke={T.spark.cyan} strokeWidth={1} opacity={0.35} strokeDasharray="3 2" />
                        <polyline points={pts_avg} fill="none" stroke={T.spark.cyan} strokeWidth={2} />
                        {/* Y-Labels */}
                        {[0, 25, 50, 75, 100].map(v => (
                          <g key={v}>
                            <line x1={padL} y1={toY(v)} x2={svgW} y2={toY(v)}
                              stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
                            <text x={padL - 3} y={toY(v) + 3} fontSize={8} textAnchor="end"
                              fill="rgba(224,234,255,0.3)" fontFamily={T.fontMono}>{v}%</text>
                          </g>
                        ))}
                        {/* Hover-Punkt + Tooltip */}
                        {hoveredBar && socData.some(d => d.date === hoveredBar.d.date) && (() => {
                          const hd  = hoveredBar.d
                          const hx  = hoveredBar.x
                          const hy  = toY(hd.soc_avg ?? 50)
                          const tw  = 150
                          const tx  = Math.min(hx + 8, svgW - tw - 4)
                          const ty  = Math.max(12, hy - 46)
                          const col = (hd.soc_avg ?? 50) >= 60 ? T.ok : (hd.soc_avg ?? 50) >= 30 ? T.warn : T.err
                          return (
                            <g style={{ pointerEvents: 'none' }}>
                              {/* Vertikale Linie */}
                              <line x1={hx} y1={4} x2={hx} y2={cH}
                                stroke="rgba(56,189,248,0.3)" strokeWidth={1} strokeDasharray="3 2" />
                              {/* Punkt auf avg-Linie */}
                              <circle cx={hx} cy={hy} r={4} fill={T.spark.cyan} stroke="#080d14" strokeWidth={1.5} />
                              {/* Tooltip */}
                              <rect x={tx} y={ty} width={tw} height={48} rx={4}
                                fill="#0a0f1a" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
                              <text x={tx+8} y={ty+14} fontSize={10} fill={T.text}
                                fontFamily={T.fontMono} fontWeight={700}>{hd.date}</text>
                              <text x={tx+8} y={ty+28} fontSize={10} fill={col} fontFamily={T.fontMono}>
                                {'Ø ' + (hd.soc_avg ?? '–') + '%'}
                              </text>
                              <text x={tx+70} y={ty+28} fontSize={9} fill="rgba(56,189,248,0.6)" fontFamily={T.fontMono}>
                                {(hd.soc_min ?? '–') + '–' + (hd.soc_max ?? '–') + '%'}
                              </text>
                            </g>
                          )
                        })()}
                      </svg>
                    </div>
                    <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>
                      Durchschnitt (—) · Min/Max (- -) · Hover für Details
                    </div>
                  </Card>
                )
              })()}

              </> /* end verlaufAnsicht === 'strom' */}

              {/* ── GAS ANSICHT ── */}
              {verlaufAnsicht === 'gas' && verlaufZr !== 'heute' && verlaufZr !== 'gesamt' && (() => {
                const gasData  = periodData.filter(d => d.gas_m3 !== null)
                const gasSum   = periodSum?.gas_m3
                const maxGas   = Math.max(...periodData.map(d => d.gas_m3 ?? 0), 0.1)
                const gBarW    = verlaufZr === 'jahr' ? 12 : verlaufZr === 'monat' ? 18 : 32
                const gChartH  = 120
                const gTotalW  = Math.max(periodData.length * (gBarW + 8), 300)
                const GAS_PREIS = 0.11  // €/kWh Gas ≈ ca. 1.1 ct/kWh × Brennwert ~10 kWh/m³
                const gasKwhM3  = 10.0  // kWh pro m³ Gas (Richtwert, je nach Heizwert)
                return (
                  <>
                    {/* Gas Zusammenfassung */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 12 }}>
                      <Card accentColor={T.warn}>
                        <CardLabel icon="🔥" color={T.warn}>Gasverbrauch</CardLabel>
                        <BigVal value={gasSum != null ? `${gasSum.toFixed(2)}` : '–'} unit="m³" size={21} color={T.warn} />
                        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>
                          ≈ {gasSum != null ? (gasSum * gasKwhM3).toFixed(0) : '–'} kWh Wärme
                        </div>
                        <div style={{ fontSize: 11, color: T.warn, fontFamily: T.fontMono, marginTop: 2 }}>
                          ≈ {gasSum != null ? (gasSum * gasKwhM3 * GAS_PREIS).toFixed(2) : '–'} € Kosten
                        </div>
                      </Card>
                      <Card accentColor={T.muted as string}>
                        <CardLabel icon="📊" color={T.spark.cyan}>Zählerstand</CardLabel>
                        <BigVal value={values['Gaszaehler/stand'] ?? '…'} unit="m³" size={21} />
                        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>
                          Gasverbrauch gesamt
                        </div>
                        {gasData.length > 0 && (
                          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>
                            Ø {(gasData.reduce((s,d)=>s+(d.gas_m3??0),0)/gasData.length).toFixed(2)} m³/Tag
                          </div>
                        )}
                      </Card>
                    </div>

                    {/* Gas Balkendiagramm */}
                    {gasData.length >= 2 && (
                      <Card accentColor={T.warn} style={{ marginBottom: 12, padding: '12px 13px' }}>
                        <CardLabel icon="📊" color={T.warn}>Gasverbrauch täglich</CardLabel>
                        <div style={{ overflowX: 'auto' }}>
                          <svg width={gTotalW} height={gChartH + 40} style={{ display: 'block' }}>
                            {periodData.map((d, i) => {
                              const x  = i * (gBarW + 8)
                              const h  = d.gas_m3 ? (d.gas_m3 / maxGas) * gChartH : 0
                              const isHov = hoveredBar?.d.date === d.date
                              const col = d.gas_m3 && d.gas_m3 > (maxGas * 0.7) ? T.err
                                : d.gas_m3 && d.gas_m3 > (maxGas * 0.4) ? T.warn : T.ok
                              return (
                                <g key={d.date}
                                  onMouseEnter={() => d.gas_m3 !== null && setHoveredBar({ d, x: x + gBarW/2, y: gChartH - h })}
                                  onMouseLeave={() => setHoveredBar(null)}
                                  onClick={() => setVerlaufDetail(verlaufDetail?.date === d.date ? null : d)}
                                  style={{ cursor: 'pointer' }}>
                                  <rect x={x} y={gChartH - h} width={gBarW} height={h}
                                    fill={col} opacity={isHov ? 1 : 0.75} rx={2} />
                                  <text x={x + gBarW/2} y={gChartH + 14} textAnchor="middle"
                                    fontSize={9} fill="rgba(224,234,255,0.4)" fontFamily={T.fontMono}>
                                    {formatDate(d.date)}
                                  </text>
                                </g>
                              )
                            })}
                            {/* Hover-Tooltip */}
                            {hoveredBar && periodData.some(d => d.date === hoveredBar.d.date) && (() => {
                              const td  = hoveredBar.d
                              const hx  = hoveredBar.x
                              const tx  = Math.min(hx + 8, gTotalW - 145)
                              const ty  = Math.max(50, hoveredBar.y - 10)
                              return (
                                <g style={{ pointerEvents: 'none' }}>
                                  <rect x={tx-4} y={ty-52} width={148} height={56} rx={4}
                                    fill="#0a0f1a" stroke="rgba(255,255,255,0.2)" strokeWidth={1}/>
                                  <text x={tx} y={ty-36} fontSize={11} fill={T.text} fontFamily={T.fontMono} fontWeight={700}>
                                    {td.date}
                                  </text>
                                  <text x={tx} y={ty-20} fontSize={10} fill={T.warn} fontFamily={T.fontMono}>
                                    {(td.gas_m3 ?? 0).toFixed(3)} m³ Gas
                                  </text>
                                  <text x={tx} y={ty-4} fontSize={10} fill={T.muted} fontFamily={T.fontMono}>
                                    ≈ {((td.gas_m3 ?? 0) * gasKwhM3 * GAS_PREIS).toFixed(2)} € Kosten
                                  </text>
                                </g>
                              )
                            })()}
                            {[0.5, 1].map(f => (
                              <g key={f}>
                                <line x1={0} y1={gChartH*(1-f)} x2={gTotalW} y2={gChartH*(1-f)}
                                  stroke="rgba(255,255,255,0.06)" strokeWidth={1}/>
                                <text x={gTotalW-2} y={gChartH*(1-f)-2} textAnchor="end"
                                  fontSize={8} fill="rgba(224,234,255,0.3)" fontFamily={T.fontMono}>
                                  {(maxGas*f).toFixed(2)}
                                </text>
                              </g>
                            ))}
                          </svg>
                        </div>
                        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>
                          Hover für Details · Preis: {GAS_PREIS} €/kWh · Heizwert: {gasKwhM3} kWh/m³ (Richtwert)
                        </div>
                      </Card>
                    )}
                    {gasData.length < 2 && (
                      <div style={{ textAlign: 'center', padding: '30px', color: T.muted, fontFamily: T.fontMono, fontSize: 12 }}>
                        Noch keine Gas-Verlaufsdaten – history.0 für 0_userdata.0.Gaszaehler.kWhZaehler aktivieren
                      </div>
                    )}
                  </>
                )
              })()}

              {/* ── GESAMT-ANSICHT ── */}
              {verlaufZr === 'gesamt' && (() => {
                const bkwRaw     = parseFloat(values['tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'] ?? 'NaN')
                const bkwGesamt  = !isNaN(bkwRaw) ? bkwRaw + 178.779 : NaN
                const pvGesamt   = parseFloat(values[V('solarcharger/288/Yield/System')] ?? 'NaN')
                const solarTotal = (!isNaN(bkwGesamt) ? bkwGesamt : 0) + (!isNaN(pvGesamt) ? pvGesamt : 0)

                // Jahres-Chart aus statTage – gruppiert nach Jahren
                const years = Array.from(new Set(statTage.map(d => d.date.slice(0,4)))).sort()
                const yearData = years.map(y => {
                  const days = statTage.filter(d => d.date.startsWith(y))
                  const vSum = days.reduce((s,d) => s + (d.verbrauch_kwh ?? 0), 0)
                  const eSum = days.reduce((s,d) => s + (d.erzeugung_kwh ?? 0), 0)
                  return { date: y, verbrauch_kwh: vSum > 0 ? Math.round(vSum*100)/100 : null,
                           erzeugung_kwh: eSum > 0 ? Math.round(eSum*100)/100 : null,
                           bkw_kwh: null, solar_kwh: null, soc_min: null, soc_max: null, soc_avg: null }
                })
                const maxYV = Math.max(...yearData.map(d => d.verbrauch_kwh ?? 0), 1)
                const maxYE = Math.max(...yearData.map(d => d.erzeugung_kwh ?? 0), 1)
                const maxYAll = Math.max(maxYV, maxYE, 1)
                const yBarW = 40
                const yChartH = 120
                const yTotalW = Math.max(yearData.length * (yBarW * 2 + 8), 200)

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Jahres-Balkendiagramm mit Drill-Down */}
                    {yearData.length > 0 && (
                      <Card accentColor={T.spark.power} style={{ padding: '12px 13px', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <CardLabel icon="📊" color={T.spark.power}>
                            {drillData ? drillLabel : 'Jahresübersicht – Verbrauch vs. Erzeugung'}
                          </CardLabel>
                          {drillData && (
                            <button onClick={() => { setDrillData(null); setDrillLabel(''); setVerlaufDetail(null); }} style={{
                              marginLeft: 'auto', padding: '2px 10px', borderRadius: 12, fontSize: 10,
                              fontFamily: T.fontLabel, cursor: 'pointer',
                              border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: T.muted,
                            }}>← zurück</button>
                          )}
                        </div>
                        {(() => {
                          const cData  = drillData ?? yearData
                          const cMaxV  = Math.max(...cData.map(d => d.verbrauch_kwh ?? 0), 1)
                          const cMaxE  = Math.max(...cData.map(d => d.erzeugung_kwh ?? 0), 1)
                          const cMaxA  = Math.max(cMaxV, cMaxE, 1)
                          const cBarW  = drillData ? 14 : yBarW
                          const cW     = Math.max(cData.length * (cBarW * 2 + 8), 200)
                          return (
                            <div style={{ overflowX: 'auto' }}>
                              <svg width={cW} height={yChartH + 36} style={{ display: 'block' }}>
                                {cData.map((d, i) => {
                                  const x    = i * (cBarW * 2 + 8)
                                  const vH   = d.verbrauch_kwh  ? (d.verbrauch_kwh  / cMaxA) * yChartH : 0
                                  const eH   = d.erzeugung_kwh ? (d.erzeugung_kwh / cMaxA) * yChartH : 0
                                  const isSel = verlaufDetail?.date === d.date
                                  const isHov = hoveredBar?.d.date === d.date
                                  // Drill-Tiefe: 0=Jahr, 1=Monat, 2=Tag
                                  const drillDepth = !drillData ? 0 : (drillData[0]?.date.length === 7 ? 1 : 2)
                                  return (
                                    <g key={d.date} style={{ cursor: 'pointer' }}
                                      onMouseEnter={() => setHoveredBar({ d, x: x + cBarW, y: Math.min(yChartH - vH, yChartH - eH) })}
                                      onMouseLeave={() => setHoveredBar(null)}
                                      onClick={() => {
                                        if (drillDepth === 0) {
                                          // Jahr → Monate
                                          const months = Array.from(new Set(
                                            statTage.filter(t => t.date.startsWith(d.date)).map(t => t.date.slice(0,7))
                                          )).sort()
                                          const mData = months.map(m => {
                                            const days = statTage.filter(t => t.date.startsWith(m))
                                            const vS = days.reduce((s,t) => s + (t.verbrauch_kwh ?? 0), 0)
                                            const eS = days.reduce((s,t) => s + (t.erzeugung_kwh ?? 0), 0)
                                            return { date: m, verbrauch_kwh: vS>0?Math.round(vS*100)/100:null,
                                                     erzeugung_kwh: eS>0?Math.round(eS*100)/100:null,
                                                     bkw_kwh:null, solar_kwh:null, soc_min:null, soc_max:null, soc_avg:null }
                                          })
                                          if (mData.length > 0) { setDrillData(mData); setDrillLabel(`${d.date} – Monate`); setVerlaufDetail(null) }
                                        } else if (drillDepth === 1) {
                                          // Monat → Tage
                                          const days = statTage.filter(t => t.date.startsWith(d.date))
                                          if (days.length > 0) { setDrillData(days); setDrillLabel(`${d.date} – Tage`); setVerlaufDetail(null) }
                                        } else {
                                          // Tag → Detail-Panel
                                          setVerlaufDetail(verlaufDetail?.date === d.date ? null : d)
                                        }
                                    }}>
                                      <rect x={x} y={yChartH-vH} width={cBarW} height={vH}
                                        fill={T.err} opacity={isHov||isSel ? 1 : 0.8} rx={2} />
                                      <rect x={x+cBarW+2} y={yChartH-eH} width={cBarW} height={eH}
                                        fill={T.ok} opacity={isHov||isSel ? 1 : 0.8} rx={2} />
                                      {(isHov||isSel) && <rect x={x-1} y={0} width={cBarW*2+4} height={yChartH}
                                        fill="rgba(255,255,255,0.04)" rx={2} />}
                                      <text x={x+cBarW} y={yChartH+14} textAnchor="middle"
                                        fontSize={drillDepth === 2 ? 8 : 10} fill="rgba(224,234,255,0.5)" fontFamily={T.fontMono}>
                                        {drillDepth === 0 ? d.date : d.date.length === 7 ? d.date.slice(5) : d.date.slice(8)}
                                      </text>
                                    </g>
                                  )
                                })}
                                {/* Hover-Tooltip Gesamt-Chart */}
                                {hoveredBar && (() => {
                                  const td  = hoveredBar.d
                                  const tw  = 165
                                  const tx  = Math.min(hoveredBar.x, cW - tw - 5)
                                  const ty  = Math.max(60, hoveredBar.y ?? 20)
                                  const dys = td.date.length === 10
                                    ? 1
                                    : td.date.length === 7
                                    ? statTage.filter(t => t.date.startsWith(td.date)).length
                                    : statTage.filter(t => t.date.startsWith(td.date)).length
                                  const euro = calcEuro(td.verbrauch_kwh, td.erzeugung_kwh, dys)
                                  const netCol = euro.net >= 0 ? '#34d399' : '#f87171'
                                  return (
                                    <g style={{ pointerEvents: 'none' }}>
                                      <rect x={tx-4} y={ty-62} width={tw+8} height={66} rx={5}
                                        fill="#0a0f1a" stroke="rgba(255,255,255,0.2)" strokeWidth={1}/>
                                      <text x={tx} y={ty-46} fontSize={11} fill={T.text} fontFamily={T.fontMono} fontWeight={700}>
                                        {td.date}
                                      </text>
                                      <text x={tx} y={ty-30} fontSize={10} fill={T.err} fontFamily={T.fontMono}>
                                        {'▼ '+(td.verbrauch_kwh!=null?td.verbrauch_kwh.toFixed(2):'–')+' kWh'}
                                      </text>
                                      <text x={tx+tw/2} y={ty-30} fontSize={10} fill={T.ok} fontFamily={T.fontMono}>
                                        {'▲ '+(td.erzeugung_kwh!=null?td.erzeugung_kwh.toFixed(2):'–')+' kWh'}
                                      </text>
                                      <text x={tx} y={ty-14} fontSize={10} fill={netCol} fontFamily={T.fontMono} fontWeight={700}>
                                        {euro.net>=0 ? 'Gespart:  ' : 'Kosten:   '}
                                        {Math.abs(euro.net).toFixed(2)+' €'}
                                      </text>
                                    </g>
                                  )
                                })()}
                                {[0.5, 1].map(f => (
                                  <g key={f}>
                                    <line x1={0} y1={yChartH*(1-f)} x2={cW} y2={yChartH*(1-f)}
                                      stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                                    <text x={cW-2} y={yChartH*(1-f)-2} textAnchor="end"
                                      fontSize={9} fill="rgba(224,234,255,0.3)" fontFamily={T.fontMono}>
                                      {(cMaxA*f).toFixed(0)}
                                    </text>
                                  </g>
                                ))}
                              </svg>
                            </div>
                          )
                        })()}
                        <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, fontFamily: T.fontMono, color: T.muted }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ width: 10, height: 10, background: T.err, borderRadius: 2, display: 'inline-block' }} />Verbrauch
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ width: 10, height: 10, background: T.ok, borderRadius: 2, display: 'inline-block' }} />Erzeugung
                          </span>
                          <span style={{ marginLeft: 'auto' }}>
                            {!drillData ? 'Jahr anklicken → Monate'
                              : drillData[0]?.date.length === 7 ? 'Monat anklicken → Tage'
                              : 'Tag anklicken → Details · Hover für Werte'}
                          </span>
                        </div>
                      </Card>
                    )}

                    {/* Zählerstände */}
                    <div className="grid-groups">
                      <Card accentColor={T.ok}>
                        <CardLabel icon="🌿" color={T.ok}>Solar gesamt</CardLabel>
                        <BigVal value={solarTotal > 0 ? solarTotal.toFixed(2) : '…'} unit="kWh" size={24} color={T.ok} />
                        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 4 }}>BKW + Victron kombiniert</div>
                        <Div />
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
                          <div>
                            <Sub>Balkonkraftwerk</Sub>
                            <BigVal value={!isNaN(bkwGesamt) ? bkwGesamt.toFixed(2) : '…'} unit="kWh" size={17} color={T.spark.cyan} />
                            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>seit 27.03.2023</div>
                            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono }}>({!isNaN(bkwRaw) ? bkwRaw.toFixed(2) : '…'} + 178.78 kWh)</div>
                          </div>
                          <div>
                            <Sub>Victron MPPT</Sub>
                            <BigVal value={!isNaN(pvGesamt) ? pvGesamt.toFixed(2) : '…'} unit="kWh" size={17} color={amberAcc} />
                            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>seit Inbetriebnahme</div>
                          </div>
                        </div>
                      </Card>

                      <Card accentColor={T.spark.cyan}>
                        <CardLabel icon="📊" color={T.spark.cyan}>Zählerstände</CardLabel>
                        {/* Strom + Gas nebeneinander */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
                          <div>
                            <Sub>Strom gesamt</Sub>
                            <BigVal value={values['Stromzähler/Verbrauch_gesamt'] ?? '…'} unit="kWh" size={20} />
                          </div>
                          <div>
                            <Sub>Gas gesamt</Sub>
                            <BigVal value={values['Gaszaehler/stand'] ?? '…'} unit="m³" size={20} color={T.warn} />
                          </div>
                        </div>
                        <Div />
                        <Sub>Eingespeist gesamt</Sub>
                        <BigVal value={values['Stromzähler/Eingespeist_gesamt'] ?? '…'} unit="kWh" size={17} color={T.ok} />
                      </Card>
                    </div>
                  </div>
                )
              })()}

              {/* Detail-Panel bei Klick auf Balken */}
              {verlaufDetail && (
                <Card accentColor={T.accent} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <CardLabel icon="📅" color={T.accent}>{verlaufDetail.date}</CardLabel>
                    <button onClick={() => setVerlaufDetail(null)} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: T.muted, fontSize: 16, padding: '2px 6px',
                    }}>✕</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Verbrauch</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: T.err, fontFamily: T.fontMono }}>{fkwh(verlaufDetail.verbrauch_kwh)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Erzeugung gesamt</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: T.ok, fontFamily: T.fontMono }}>{fkwh(verlaufDetail.erzeugung_kwh)}</div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginTop: 2 }}>
                        BKW {fkwh(verlaufDetail.bkw_kwh)} · PV {fkwh(verlaufDetail.solar_kwh)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Bilanz</div>
                      {(() => {
                        const b    = (verlaufDetail.erzeugung_kwh ?? 0) - (verlaufDetail.verbrauch_kwh ?? 0)
                        const euro = calcEuro(verlaufDetail.verbrauch_kwh, verlaufDetail.erzeugung_kwh, 1)
                        const col  = b >= 0 ? T.ok : T.err
                        return <>
                          <div style={{ fontSize: 20, fontWeight: 700, color: col, fontFamily: T.fontMono }}>
                            {b >= 0 ? '+' : ''}{b.toFixed(1)} kWh
                          </div>
                          <div style={{ fontSize: 12, color: euro.net >= 0 ? T.ok : T.err, fontFamily: T.fontMono, marginTop: 3, fontWeight: 700 }}>
                            {euro.net >= 0 ? `Gespart: +${euro.net.toFixed(2)} €` : `Kosten: ${euro.net.toFixed(2)} €`}
                          </div>
                        </>
                      })()}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.fontMono, marginBottom: 3 }}>Batterie SOC</div>
                      <div style={{ fontSize: 13, color: T.spark.cyan, fontFamily: T.fontMono }}>
                        Min {verlaufDetail.soc_min ?? '–'}% · Max {verlaufDetail.soc_max ?? '–'}%
                      </div>
                      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.fontMono }}>
                        Ø {verlaufDetail.soc_avg ?? '–'}%
                      </div>
                    </div>
                  </div>
                </Card>
              )}

            </div>
          )
        })()}
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
