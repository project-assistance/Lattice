import './App.css'

function PinVisual() {
  return (
    <div className="pin-visual">
      <div className="pin-step">
        <div className="mock-toolbar">
          <div className="mock-toolbar-spacer" />
          <div className="mock-toolbar-btn mock-toolbar-btn--puzzle" title="Extensions">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M12 2a2 2 0 0 1 2 2v.5a.5.5 0 0 0 .5.5H16a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-.5a.5.5 0 0 0-.5.5V12a2 2 0 0 1-2 2h-1a.5.5 0 0 0-.5.5V15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-.5a.5.5 0 0 0-.5-.5H4a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h.5A.5.5 0 0 0 5 8.5V7a2 2 0 0 1 2-2h.5A.5.5 0 0 0 8 4.5V4a2 2 0 0 1 2-2h2Z" fill="currentColor" opacity=".7"/>
            </svg>
          </div>
        </div>
        <p className="pin-step-label">Click the puzzle piece</p>
      </div>

      <div className="pin-arrow">→</div>

      <div className="pin-step">
        <div className="mock-dropdown">
          <div className="mock-dropdown-row mock-dropdown-row--highlight">
            <img className="mock-ext-icon" src="/logo.png" alt="" width="16" height="16" />
            <span className="mock-ext-name">Lattice</span>
            <span className="mock-pin-icon" title="Pin">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M16 2L8 10l-4 1 5 5-1 4 8-8" stroke="#52C9A8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 12L4 20" stroke="#52C9A8" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </span>
          </div>
        </div>
        <p className="pin-step-label">Pin Lattice</p>
      </div>

      <div className="pin-arrow">→</div>

      <div className="pin-step">
        <div className="mock-toolbar">
          <div className="mock-toolbar-spacer" />
          <div className="mock-toolbar-btn mock-toolbar-btn--ext" title="Lattice">
            <img src="/logo.png" alt="Lattice" width="18" height="18" />
          </div>
          <div className="mock-toolbar-btn mock-toolbar-btn--puzzle">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M12 2a2 2 0 0 1 2 2v.5a.5.5 0 0 0 .5.5H16a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-.5a.5.5 0 0 0-.5.5V12a2 2 0 0 1-2 2h-1a.5.5 0 0 0-.5.5V15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-.5a.5.5 0 0 0-.5-.5H4a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h.5A.5.5 0 0 0 5 8.5V7a2 2 0 0 1 2-2h.5A.5.5 0 0 0 8 4.5V4a2 2 0 0 1 2-2h2Z" fill="currentColor" opacity=".7"/>
            </svg>
          </div>
        </div>
        <p className="pin-step-label">Lattice is pinned!</p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo-wrap">
          <img src="/logo.png" alt="Lattice" className="welcome-logo" />
        </div>
        <h1 className="welcome-title">Welcome to Lattice</h1>
        <p className="welcome-subtitle">
          Lattice automatically organizes your open tabs into smart groups using on-device AI.
        </p>

        <div className="welcome-pin-section">
          <h2 className="welcome-section-title">Pin Lattice to your toolbar</h2>
          <p className="welcome-section-desc">
            For quick access, pin Lattice to Chrome's toolbar — it takes two clicks.
          </p>
          <PinVisual />
        </div>

        <div className="welcome-tip">
          <span className="welcome-tip-label">Tip</span>
          Click the Lattice icon anytime to see your organized tabs. Open the side panel for a persistent view alongside your browsing.
        </div>

        <button className="welcome-btn" onClick={() => window.close()}>
          Got it — let's go
        </button>
      </div>
    </div>
  )
}
