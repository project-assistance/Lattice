import { useEffect, useState, ReactNode } from 'react'
import './GeminiGate.css'

type Status = 'checking' | 'available' | 'needs-download' | 'downloading' | 'incompatible'

interface GeminiGateProps {
  children: ReactNode
  className?: string
}

declare const LanguageModel: any

export default function GeminiGate({ children, className }: GeminiGateProps) {
  const [status, setStatus] = useState<Status>('checking')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof LanguageModel === 'undefined') {
      setStatus('incompatible')
      return
    }
    LanguageModel.availability()
      .then((avail: string) => {
        if (avail === 'available') setStatus('available')
        else if (avail === 'downloadable') setStatus('needs-download')
        else if (avail === 'downloading') startDownload()
        else setStatus('incompatible')
      })
      .catch(() => setStatus('incompatible'))
  }, [])

  const startDownload = async () => {
    setStatus('downloading')
    setProgress(0)
    try {
      await LanguageModel.create({
        monitor(m: EventTarget) {
          m.addEventListener('downloadprogress', (e: any) => {
            setProgress(Math.round(e.loaded * 100))
          })
        },
      })
      setStatus('available')
    } catch (err: any) {
      setError(err?.message ?? 'Download failed.')
      setStatus('needs-download')
    }
  }

  const handleDownload = () => startDownload()

  if (status === 'available') return <>{children}</>

  return (
    <div className={['gemini-gate', className].filter(Boolean).join(' ')}>
      {status === 'checking' && (
        <p className="gemini-gate__msg">Checking AI availability…</p>
      )}

      {status === 'needs-download' && (
        <div className="gemini-gate__card">
          <div className="gemini-gate__icon">✦</div>
          <h2 className="gemini-gate__title">Gemini Nano required</h2>
          <p className="gemini-gate__body">
            Tidy2 uses Gemini Nano — an on-device AI model — to intelligently
            name your tab clusters. Your browsing data never leaves your device.
          </p>
          {error && <p className="gemini-gate__error">{error}</p>}
          <button className="gemini-gate__btn" onClick={handleDownload}>
            Download Gemini Nano
          </button>
          <a
            className="gemini-gate__link"
            href="https://developer.chrome.com/docs/ai/built-in"
            target="_blank"
            rel="noopener noreferrer"
          >
            What is Gemini Nano?
          </a>
        </div>
      )}

      {status === 'downloading' && (
        <div className="gemini-gate__card">
          <div className="gemini-gate__icon">✦</div>
          <h2 className="gemini-gate__title">Downloading Gemini Nano</h2>
          <p className="gemini-gate__body">
            This only happens once. The model stays on your device.
          </p>
          <div className="gemini-gate__progress-wrap">
            <div
              className="gemini-gate__progress-bar"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="gemini-gate__progress-label">{progress}%</p>
        </div>
      )}

      {status === 'incompatible' && (
        <div className="gemini-gate__card">
          <div className="gemini-gate__icon gemini-gate__icon--dim">✦</div>
          <h2 className="gemini-gate__title">Not supported</h2>
          <p className="gemini-gate__body">
            Gemini Nano isn't available on this device or browser. Tidy2 requires
            Chrome 127+ on a supported device with the Prompt API enabled.
          </p>
          <a
            className="gemini-gate__link"
            href="https://developer.chrome.com/docs/ai/built-in"
            target="_blank"
            rel="noopener noreferrer"
          >
            System requirements
          </a>
        </div>
      )}
    </div>
  )
}
