import { useEffect, useState } from 'react'
import { THRESHOLD } from '@/lib/clustering'
import './App.css'

const RECLUSTER_DEFAULT = 45

type NumPreset = { label: string; value: number; hint?: string }

function PresetSetting({ label, description, storageKey, presets, defaultValue }: {
  label: string
  description: string
  storageKey: string
  presets: NumPreset[]
  defaultValue: number
}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    chrome.storage.local.get(storageKey).then(r => {
      if (r[storageKey] != null) setValue(r[storageKey] as number)
    })
  }, [storageKey])

  const handleSelect = (v: number) => {
    setValue(v)
    chrome.storage.local.set({ [storageKey]: v })
  }

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        <span className="setting-description">{description}</span>
      </div>
      <div className="preset-group">
        {presets.map(p => (
          <button
            key={p.label}
            className={`preset-btn${value === p.value ? ' preset-btn--active' : ''}`}
            onClick={() => handleSelect(p.value)}
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleSetting({ label, description, storageKey, defaultValue }: {
  label: string
  description: string
  storageKey: string
  defaultValue: boolean
}) {
  const [enabled, setEnabled] = useState(defaultValue)

  useEffect(() => {
    chrome.storage.local.get(storageKey).then(r => {
      if (r[storageKey] != null) setEnabled(r[storageKey] as boolean)
    })
  }, [storageKey])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    chrome.storage.local.set({ [storageKey]: next })
  }

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        <span className="setting-description">{description}</span>
      </div>
      <button
        className={`toggle-switch${enabled ? ' toggle-switch--on' : ''}`}
        onClick={toggle}
        role="switch"
        aria-checked={enabled}
      >
        <span className="toggle-switch-knob" />
      </button>
    </div>
  )
}

type WindowDiag = {
  windowId: number
  cache: {
    clusterCount: number
    namedClusterCount: number
    ungroupedCount: number
    totalTabCount: number
    hasCentroids: boolean
    labels: string[]
  } | null
  job: { status: string; error?: string } | null
  hasProposal: boolean
  proposalAt: number | null
  alarm: { scheduledTime: number } | null
}

type Diagnostics = {
  offscreenAvailable: boolean
  windows: WindowDiag[]
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`diag-dot ${ok ? 'diag-dot--ok' : 'diag-dot--off'}`} />
}

function WindowCard({ win }: { win: WindowDiag }) {
  const alarmMins = win.alarm
    ? Math.round((win.alarm.scheduledTime - Date.now()) / 60000)
    : null

  return (
    <div className="diag-window">
      <div className="diag-window-title">Window {win.windowId}</div>
      <div className="diag-grid">
        <span className="diag-key">Cache</span>
        <span className="diag-val">
          {win.cache
            ? `${win.cache.namedClusterCount} named · ${win.cache.ungroupedCount} ungrouped · ${win.cache.totalTabCount} tabs`
            : <em>none</em>}
        </span>

        <span className="diag-key">Centroids</span>
        <span className="diag-val">
          <StatusDot ok={!!win.cache?.hasCentroids} />
          {win.cache?.hasCentroids ? ' present' : ' missing'}
        </span>

        <span className="diag-key">Job</span>
        <span className="diag-val">
          {win.job
            ? <><StatusDot ok={win.job.status === 'done'} /> {win.job.status}{win.job.error ? `: ${win.job.error}` : ''}</>
            : <em>none</em>}
        </span>

        <span className="diag-key">Proposal</span>
        <span className="diag-val">
          {win.hasProposal && win.proposalAt
            ? <>pending · {new Date(win.proposalAt).toLocaleTimeString()}</>
            : <em>none</em>}
        </span>

        <span className="diag-key">Re-cluster</span>
        <span className="diag-val">
          {alarmMins !== null
            ? `in ${alarmMins} min`
            : <em>not scheduled</em>}
        </span>

        {win.cache && (
          <>
            <span className="diag-key">Labels</span>
            <span className="diag-val diag-labels">
              {win.cache.labels.map((l, i) => (
                <span key={i} className={`diag-label ${l === 'Ungrouped' ? 'diag-label--dim' : ''}`}>{l}</span>
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function AiLabelingToggle() {
  const [choice, setChoice] = useState<'ai' | 'skip'>('ai')

  useEffect(() => {
    chrome.storage.local.get('geminiChoice').then(r => {
      if (r['geminiChoice']) setChoice(r['geminiChoice'] as 'ai' | 'skip')
    })
  }, [])

  const handleChange = (next: 'ai' | 'skip') => {
    setChoice(next)
    chrome.storage.local.set({ geminiChoice: next })
  }

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>Group name style</span>
        <span className="setting-description">AI labeling uses Gemini Nano, Chrome's built-in on-device AI. Keyword labels are lightweight and work immediately.</span>
      </div>
      <div className="preset-group">
        <button
          className={`preset-btn${choice === 'ai' ? ' preset-btn--active' : ''}`}
          onClick={() => handleChange('ai')}
        >
          AI labeling
        </button>
        <button
          className={`preset-btn${choice === 'skip' ? ' preset-btn--active' : ''}`}
          onClick={() => handleChange('skip')}
        >
          Keyword labels
        </button>
      </div>
    </div>
  )
}

function GeminiNanoSection() {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText('chrome://flags/#optimization-guide-on-device-model').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <section className="settings-section">
      <h2>Gemini Nano</h2>
      <div className="gemini-info-block">
        <p className="gemini-info-text">
          Lattice uses Gemini Nano for smarter group names. It is downloaded and managed by Chrome — the extension cannot remove it directly. To remove Gemini Nano and reclaim disk space:
        </p>
        <p className="gemini-info-subhead">Recommended</p>
        <ol className="gemini-info-steps">
          <li>Open Chrome menu → <strong>Settings</strong> → <strong>System</strong></li>
          <li>Turn off <strong>On-device AI</strong></li>
          <li>Relaunch Chrome — the model files are removed automatically</li>
        </ol>
        <p className="gemini-info-subhead">Alternative (if toggle is not available)</p>
        <ol className="gemini-info-steps">
          <li>
            Open <code>chrome://flags/</code> in a new tab
            <button className="gemini-copy-btn" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy flag URL'}
            </button>
          </li>
          <li>Search for <strong>optimization-guide-on-device-model</strong> and set to <strong>Disabled</strong></li>
          <li>Relaunch Chrome</li>
        </ol>
        <p className="gemini-info-note">
          Removing Gemini Nano is optional — Lattice will use keyword-based labels instead.
        </p>
      </div>
    </section>
  )
}

function DiagnosticsPanel() {
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_DIAGNOSTICS' })
      if (response?.status === 'success') setDiag(response)
    } finally {
      setLoading(false)
    }
  }

  const clearStorage = async () => {
    setClearing(true)
    const all = await chrome.storage.local.get(null)
    const keys = Object.keys(all).filter(k =>
      k.startsWith('clusterCache_') || k.startsWith('clusterJob_') || k.startsWith('clusterProposal_')
    )
    if (keys.length) await chrome.storage.local.remove(keys)
    const alarms = await chrome.alarms.getAll()
    await Promise.all(alarms.filter(a => a.name.startsWith('reCluster_')).map(a => chrome.alarms.clear(a.name)))
    setClearing(false)
    setDiag(null)
    await refresh()
  }

  useEffect(() => { refresh() }, [])

  return (
    <section className="settings-section">
      <h2>Debug</h2>

      <div className="diag-toolbar">
        <div className="diag-status-row">
          <span className="diag-key">Offscreen</span>
          {diag
            ? <><StatusDot ok={diag.offscreenAvailable} /> {diag.offscreenAvailable ? 'warm — smart placement active' : 'cold — smart placement inactive'}</>
            : '—'
          }
        </div>
        <button className="diag-refresh-btn" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {diag && diag.windows.length === 0 && (
        <p className="diag-empty">No cluster cache found. Run Organize to populate.</p>
      )}

      {diag?.windows.map(win => <WindowCard key={win.windowId} win={win} />)}

      <div className="diag-danger">
        <button className="diag-clear-btn" onClick={clearStorage} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Clear all storage & alarms'}
        </button>
        <span className="diag-danger-note">Removes all cached clusters, jobs, and proposals across all windows.</span>
      </div>
    </section>
  )
}

export default function App() {
  return (
    <div className="settings">
      <header className="settings-header">
        <h1>Settings</h1>
      </header>
      <main className="settings-body">
        <section className="settings-section">
          <h2>Clustering</h2>
          <PresetSetting
            label="Cluster sensitivity"
            description="Controls how many groups Lattice creates. Lower makes more smaller groups; Higher makes fewer larger ones."
            storageKey="clusteringThreshold"
            defaultValue={THRESHOLD}
            presets={[
              { label: 'Lower', value: 0.35, hint: 'More groups — good for large tab collections' },
              { label: 'Default', value: THRESHOLD },
              { label: 'Higher', value: 0.95, hint: 'Fewer groups — good for broad browsing' },
            ]}
          />
          <PresetSetting
            label="Re-cluster interval"
            description="How often Lattice checks for new grouping suggestions in the background."
            storageKey="reClusterInterval"
            defaultValue={RECLUSTER_DEFAULT}
            presets={[
              { label: 'Off', value: 0, hint: 'Disable background re-clustering' },
              { label: '30 min', value: 30 },
              { label: '45 min', value: RECLUSTER_DEFAULT },
              { label: '90 min', value: 90 },
            ]}
          />
          <ToggleSetting
            label="Smart placement"
            description="Automatically sort new and navigated tabs into existing groups."
            storageKey="smartPlacement"
            defaultValue={true}
          />
          <ToggleSetting
            label="Grouping proposals"
            description="Show a suggestion banner when background re-clustering detects a better grouping."
            storageKey="showProposals"
            defaultValue={true}
          />
          <AiLabelingToggle />
        </section>

        <GeminiNanoSection />
        <DiagnosticsPanel />
      </main>
    </div>
  )
}
