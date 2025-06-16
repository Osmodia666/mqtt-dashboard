 return (
    <main className="min-h-screen p-4 sm:p-6 bg-gray-950 text-white font-sans">
      <header className="mb-6 text-sm text-gray-400">
        Letztes Update: {lastUpdate || 'Lade...'}
      </header>
 
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🧱 3D-Drucker</h2>
          {['Ender 3 Pro', 'Sidewinder X1'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}`}>
                <span>{label}</span>
                <button
                  className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}
                >
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>
 
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🏊 Pool</h2>
          {(() => {
            const pumpe = topics.find(t => t.label === 'Poolpumpe')
            const tempKey = 'Pool_temp/temperatur'
            const raw = values[tempKey]
            const val = raw !== undefined ? parseFloat(raw) : NaN
            const range = minMax[tempKey] ?? { min: val, max: val }
 
            return (
              <>
                <div className="flex justify-between items-center">
                  <span>Pumpe</span>
                  {pumpe && (
                    <button
                      className={`px-4 py-1 rounded text-white ${values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                      onClick={() => toggleBoolean(pumpe.publishTopic!, values[pumpe.statusTopic])}
                    >
                      {values[pumpe.statusTopic]?.toUpperCase() === 'ON' ? 'AN' : 'AUS'}
                    </button>
                  )}
                </div>
                <p className="mt-3">🌡️ Temperatur: {isNaN(val) ? '...' : `${val} °C`}</p>
                {progressBar(val, 40, getBarColor('Pool Temperatur', val))}
                <p className="text-xs text-gray-400">
                  Min: {range.min?.toFixed(1)} °C | Max: {range.max?.toFixed(1)} °C
                </p>
              </>
            )
          })()}
        </div>
 
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🎰 Zähler</h2>
          <div className="flex flex-col space-y-3">
            <p>⚡ Strom: {values['tele/Stromzähler/SENSOR.grid.Verbrauch_gesamt'] ?? '...'} kWh</p>
            <p>🔥 Gas: {values['Gaszaehler/stand'] ?? '...'} m³</p>
          </div>
        </div>
 
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-3">🔋 Erzeugung</h2>
          <p>Gesamt: {(() => {
            const key = 'tele/Balkonkraftwerk/SENSOR.ENERGY.EnergyPTotal.0'
            const raw = values[key]
            const num = parseFloat(raw)
            return !isNaN(num) ? (num + 178.779).toFixed(3) : '...'
          })()} kWh</p>
        </div>
        <div className="rounded-xl p-4 border border-gray-600 bg-gray-800">
          <h2 className="text-md font-bold mb-2">🔌 Steckdosen</h2>
          {['Steckdose 1', 'Steckdose 2'].map((label, i) => {
            const topic = topics.find(t => t.label === label)
            if (!topic) return null
            const val = values[topic.statusTopic]?.toUpperCase()
            return (
              <div key={label} className={`flex justify-between items-center ${i > 0 ? 'mt-3' : 'mt-1'}`}>
                <span>{label}</span>
                <button
                  className={`px-4 py-1 rounded text-white ${val === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(topic.publishTopic!, val)}
                >
                  {val === 'ON' ? 'AN' : 'AUS'}
                </button>
              </div>
            )
          })}
        </div>
 
        {topics.filter(t =>
          t.type !== 'group' &&
          !['Ender 3 Pro', 'Sidewinder X1', 'Poolpumpe', 'Steckdose 1', 'Steckdose 2'].includes(t.label)
        ).map(({ label, type, unit, favorite, statusTopic, publishTopic, topic }) => {
          const key = statusTopic ?? topic
          const raw = values[key]
          const value = raw?.toUpperCase()
          const num = parseFloat(raw)
          const isNumber = type === 'number' && !isNaN(num)
          const showMinMax = !label.includes('gesamt') && (
            key.includes('power_L') || key.includes('Verbrauch_aktuell') || key.includes('Balkonkraftwerk')
          )
          const range = minMax[key] ?? { min: num, max: num }
          const barColor = getBarColor(label, num)
 
          return (
            <div key={key} className={`rounded-xl p-4 border ${favorite ? 'border-yellow-400' : 'border-gray-600'} bg-gray-800`}>
              <h2 className="text-md font-bold mb-2">{label}</h2>
              {type === 'boolean' && (
                <button
                  className={`px-4 py-1 rounded text-white ${value === 'ON' ? 'bg-green-500' : 'bg-red-500'}`}
                  onClick={() => toggleBoolean(publishTopic ?? key, value)}
                >
                  {value === 'ON' ? 'AN' : 'AUS'}
                </button>
              )}
              {isNumber && (
                <>
                  <p className="text-2xl">{raw ?? '...'} {unit}</p>
                  {showMinMax && progressBar(num, range.max > 0 ? range.max : 100, barColor)}
                  {showMinMax && (
                    <p className="text-xs text-gray-400">
                      Min: {range.min.toFixed(1)} {unit} | Max: {range.max.toFixed(1)} {unit}
                    </p>
                  )}
                </>
              )}
              {type === 'string' && <p className="text-lg">{raw ?? '...'}</p>}
            </div>
          )
        })}
      </div>
 
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {topics.filter(t => t.type === 'group').map(group => (
          <div key={group.label} className="rounded-xl p-4 border border-gray-600 bg-gray-800">
            <h2 className="text-lg font-bold mb-2">{group.label}</h2>
            {group.keys?.map(({ label, key }) => {
              const raw = values[key]
              const num = raw !== undefined ? parseFloat(raw) : NaN
              const range = minMax[key] ?? { min: num, max: num }
 
              return (
                <div key={key} className="mb-2">
                  <div className="text-sm">{label}: {isNaN(num) ? '...' : `${num} ${group.unit}`}</div>
                  {progressBar(num, group.label.includes('Spannung') ? 250 : 1000, 'bg-blue-500')}
                  <div className="text-xs text-gray-400">
                    Min: {range.min?.toFixed(1)} | Max: {range.max?.toFixed(1)}
                  </div>
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
