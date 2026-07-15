import React from 'react'
import { Tab } from '@/types'
import { IconClose } from './Icons'
import './TabList.css'

function getDomain(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return '' }
}

const CHROME_GROUP_COLORS: Record<string, string> = {
  grey:   '#5f6368',
  blue:   '#1a73e8',
  red:    '#d93025',
  yellow: '#f9ab00',
  green:  '#1e8e3e',
  pink:   '#d01884',
  purple: '#9334e6',
  cyan:   '#007b83',
  orange: '#fa7b17',
}

export type ChromeGroupInfo = { groupId: number; color: string } | null

interface TabListProps {
  tabs: Tab[][]
  labels?: string[]
  chromeGroups?: ChromeGroupInfo[]
  loading: boolean
  onTabClick: (tab: Tab) => void
  onTabClose: (tab: Tab) => void
  onGroupCluster?: (tabs: Tab[], label: string, index: number) => void
  onUngroupCluster?: (tabs: Tab[], groupId: number) => void
}

export default function TabList({
  tabs, labels, chromeGroups, loading,
  onTabClick, onTabClose, onGroupCluster, onUngroupCluster,
}: TabListProps) {
  if (loading) return <p className="empty">Loading...</p>
  if (tabs.length === 0) return <p className="empty">No tabs found</p>

  const isMultiGroup = tabs.length > 1

  return (
    <div className="tab-groups">
      {tabs.map((group, gi) => {
        const label = labels?.[gi]
        const groupInfo = chromeGroups?.[gi] ?? null
        const showHeader = isMultiGroup && !!label
        const isUngrouped = label === 'Ungrouped'
        const dotColor = groupInfo ? (CHROME_GROUP_COLORS[groupInfo.color] ?? groupInfo.color) : null

        const cardStyle: React.CSSProperties | undefined = isMultiGroup && dotColor ? {
          backgroundColor: dotColor + '55',
          borderColor: dotColor + '80',
        } : undefined

        return (
          <div key={gi} className={`tab-group${isMultiGroup ? ' tab-group--card' : ''}`} style={cardStyle}>
            {showHeader && (
              <div className="cluster-header">
                <div className="cluster-header-left">
                  {dotColor && (
                    <span className="cluster-chrome-dot" style={{ backgroundColor: dotColor }} />
                  )}
                  <span className="cluster-label">{label}</span>
                </div>
                {!isUngrouped && (
                  groupInfo && onUngroupCluster ? (
                    <button
                      className="cluster-group-btn cluster-group-btn--active"
                      style={{ borderColor: dotColor ?? undefined, color: dotColor ?? undefined }}
                      onClick={() => onUngroupCluster(group, groupInfo.groupId)}
                      title={`Remove Chrome tab group for "${label}"`}
                    >
                      Ungroup
                    </button>
                  ) : onGroupCluster ? (
                    <button
                      className="cluster-group-btn"
                      onClick={() => onGroupCluster(group, label, gi)}
                      title={`Create Chrome tab group for "${label}"`}
                    >
                      Group
                    </button>
                  ) : null
                )}
              </div>
            )}
            <ul className="tab-list">
              {group.map((tab, i) => (
                <li
                  key={i}
                  className={`tab-item${tab.active ? ' tab-item--active' : ''}`}
                  onClick={() => onTabClick(tab)}
                >
                  <div className="tab-favicon-wrap">
                    <img
                      className="tab-favicon"
                      src={tab.favIconUrl}
                      width="16"
                      height="16"
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                    />
                  </div>
                  <div className="tab-info">
                    <span className="tab-title">{tab.title || getDomain(tab.url)}</span>
                    <span className="tab-domain">{getDomain(tab.url)}</span>
                  </div>
                  <button
                    className="tab-close"
                    onClick={e => { e.stopPropagation(); onTabClose(tab) }}
                    title="Close tab"
                  >
                    <IconClose />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
