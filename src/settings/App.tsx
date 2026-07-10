import './App.css'

export default function App() {
  return (
    <div className="settings">
      <header className="settings-header">
        <h1>Settings</h1>
      </header>
      <main className="settings-body">
        <section className="settings-section">
          <h2>Clustering</h2>
          <div className="setting-row">
            <div className="setting-label">
              <span>Cluster threshold</span>
              <span className="setting-description">How aggressively tabs are grouped. Lower = more clusters, higher = fewer clusters.</span>
            </div>
            <input className="setting-input" type="number" defaultValue={0.8} min={0} max={2} step={0.05} />
          </div>
        </section>
      </main>
    </div>
  )
}
