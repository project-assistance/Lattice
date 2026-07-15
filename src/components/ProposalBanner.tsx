import { ClusterProposal } from '@/types'
import './ProposalBanner.css'

interface Props {
  windowId: number
  proposal: ClusterProposal
  onDismiss: () => void
}

export default function ProposalBanner({ windowId, proposal, onDismiss }: Props) {
  const namedCount = proposal.labels.filter(l => l !== 'Ungrouped').length
  const tabCount = proposal.clusters.flat().length

  const handleApply = () => {
    chrome.runtime.sendMessage({ action: 'APPLY_PROPOSAL', windowId })
    onDismiss()
  }

  const handleDismiss = () => {
    chrome.runtime.sendMessage({ action: 'DISMISS_PROPOSAL', windowId })
    onDismiss()
  }

  return (
    <div className="proposal-banner">
      <div className="proposal-banner__text">
        <span className="proposal-banner__label">New grouping ready</span>
        <span className="proposal-banner__meta">{namedCount} groups · {tabCount} tabs</span>
      </div>
      <div className="proposal-banner__actions">
        <button className="proposal-banner__apply" onClick={handleApply}>Apply</button>
        <button className="proposal-banner__dismiss" onClick={handleDismiss} title="Dismiss">✕</button>
      </div>
    </div>
  )
}
