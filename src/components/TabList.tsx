import React, { useState, useEffect, useRef } from 'react'
import { Tab } from '@/types'
import { IconClose } from './Icons'
import './TabList.css'

function getDomain(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return '' }
}

function getScrollParent(el: HTMLElement | null): HTMLElement {
  while (el && el !== document.body) {
    const { overflow, overflowY } = getComputedStyle(el)
    if (/auto|scroll/.test(overflow + overflowY)) return el
    el = el.parentElement
  }
  return document.documentElement
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
  onUngroupCluster?: (tabs: Tab[], groupId: number, clusterIdx: number) => void
  onMoveTab?: (tabId: number, fromIdx: number, toIdx: number) => void
  onRenameCluster?: (clusterIdx: number, newLabel: string) => void
}

export default function TabList({
  tabs, labels, chromeGroups, loading,
  onTabClick, onTabClose, onGroupCluster, onUngroupCluster, onMoveTab, onRenameCluster,
}: TabListProps) {
  const [dragOverClusterIdx, setDragOverClusterIdx] = useState<number | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null)
  const [editingClusterIdx, setEditingClusterIdx] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll while dragging — must be before early returns (Rules of Hooks).
  useEffect(() => {
    const active = !!onMoveTab && tabs.length > 1 && draggingTabId !== null
    if (!active) return

    const ZONE = 100
    const MAX_SPEED = 12
    let dir = 0, speed = 0, rafId: number

    const onDragOver = (e: DragEvent) => {
      const y = e.clientY, vh = window.innerHeight
      if (y < ZONE)          { dir = -1; speed = MAX_SPEED * (1 - y / ZONE) }
      else if (y > vh - ZONE){ dir =  1; speed = MAX_SPEED * (1 - (vh - y) / ZONE) }
      else                   { dir =  0; speed = 0 }
    }

    const tick = () => {
      if (dir !== 0) getScrollParent(containerRef.current).scrollTop += dir * speed
      rafId = requestAnimationFrame(tick)
    }

    document.addEventListener('dragover', onDragOver)
    rafId = requestAnimationFrame(tick)
    return () => { document.removeEventListener('dragover', onDragOver); cancelAnimationFrame(rafId) }
  }, [onMoveTab, tabs.length, draggingTabId])

  if (loading) return <p className="empty">Loading...</p>
  if (tabs.length === 0) return <p className="empty">No tabs found</p>

  const isMultiGroup = tabs.length > 1
  const canMove = !!onMoveTab && isMultiGroup

  const handleDragStart = (e: React.DragEvent, tabId: number, fromIdx: number) => {
    e.dataTransfer.setData('tabId', String(tabId))
    e.dataTransfer.setData('fromClusterIdx', String(fromIdx))
    e.dataTransfer.effectAllowed = 'move'
    setDraggingTabId(tabId)
  }

  const handleDragEnd = () => {
    setDraggingTabId(null)
    setDragOverClusterIdx(null)
  }

  const handleDrop = (e: React.DragEvent, toIdx: number) => {
    e.preventDefault()
    setDragOverClusterIdx(null)
    const tabId = parseInt(e.dataTransfer.getData('tabId'), 10)
    const fromIdx = parseInt(e.dataTransfer.getData('fromClusterIdx'), 10)
    if (isNaN(tabId) || isNaN(fromIdx) || fromIdx === toIdx) return
    onMoveTab!(tabId, fromIdx, toIdx)
  }

  const handleRenameStart = (gi: number, currentLabel: string) => {
    setEditingClusterIdx(gi)
    setEditValue(currentLabel)
    setEditError(null)
  }

  // fromBlur=true: quietly revert on duplicates instead of showing error
  const handleRenameCommit = (gi: number, fromBlur = false) => {
    const newName = editValue.trim()
    const original = labels?.[gi] ?? ''

    if (!newName || newName === original) {
      setEditingClusterIdx(null)
      setEditError(null)
      return
    }

    const isDuplicate = labels?.some((l, i) => i !== gi && l !== 'Ungrouped' && l === newName)
    if (isDuplicate) {
      if (fromBlur) {
        setEditingClusterIdx(null)
        setEditError(null)
      } else {
        setEditError('Name already used')
        // Re-focus so the user can correct it
        setTimeout(() => editInputRef.current?.focus(), 0)
      }
      return
    }

    onRenameCluster?.(gi, newName)
    setEditingClusterIdx(null)
    setEditError(null)
  }

  return (
    <div ref={containerRef} className="tab-groups">
      {tabs.map((group, gi) => {
        const label = labels?.[gi]
        const groupInfo = chromeGroups?.[gi] ?? null
        const showHeader = isMultiGroup && !!label
        const isUngrouped = label === 'Ungrouped'
        const dotColor = groupInfo ? (CHROME_GROUP_COLORS[groupInfo.color] ?? groupInfo.color) : null
        const isDragTarget = canMove && dragOverClusterIdx === gi
        const canRename = !!onRenameCluster && !isUngrouped
        const isEditing = editingClusterIdx === gi

        const cardStyle: React.CSSProperties | undefined = isMultiGroup && dotColor ? {
          backgroundColor: dotColor + '55',
          borderColor: dotColor + '80',
        } : undefined

        return (
          <div
            key={gi}
            className={`tab-group${isMultiGroup ? ' tab-group--card' : ''}${isDragTarget ? ' tab-group--drag-over' : ''}`}
            style={cardStyle}
            onDragEnter={canMove ? () => setDragOverClusterIdx(gi) : undefined}
            onDragOver={canMove ? (e) => e.preventDefault() : undefined}
            onDragLeave={canMove ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverClusterIdx(null)
              }
            } : undefined}
            onDrop={canMove ? (e) => handleDrop(e, gi) : undefined}
          >
            {showHeader && (
              <div className="cluster-header">
                <div className="cluster-header-left">
                  {dotColor && (
                    <span className="cluster-chrome-dot" style={{ backgroundColor: dotColor }} />
                  )}
                  {isEditing ? (
                    <div className="cluster-label-edit">
                      <input
                        ref={editInputRef}
                        className={`cluster-label-input${editError ? ' cluster-label-input--error' : ''}`}
                        value={editValue}
                        autoFocus
                        onChange={e => { setEditValue(e.target.value); setEditError(null) }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRenameCommit(gi) }
                          if (e.key === 'Escape') { setEditingClusterIdx(null); setEditError(null) }
                        }}
                        onBlur={() => handleRenameCommit(gi, true)}
                      />
                      {editError && <span className="cluster-label-error">{editError}</span>}
                    </div>
                  ) : (
                    <span
                      className={`cluster-label${canRename ? ' cluster-label--editable' : ''}`}
                      onClick={canRename ? () => handleRenameStart(gi, label!) : undefined}
                      title={canRename ? 'Click to rename' : undefined}
                    >
                      {label}
                    </span>
                  )}
                </div>
                {!isUngrouped && !isEditing && (
                  groupInfo && onUngroupCluster ? (
                    <button
                      className="cluster-group-btn cluster-group-btn--active"
                      style={{ borderColor: dotColor ?? undefined, color: dotColor ?? undefined }}
                      onClick={() => onUngroupCluster(group, groupInfo.groupId, gi)}
                      title={`Remove this group from Chrome's tab bar`}
                    >
                      Unpin
                    </button>
                  ) : onGroupCluster ? (
                    <button
                      className="cluster-group-btn"
                      onClick={() => onGroupCluster(group, label!, gi)}
                      title={`Show "${label}" as a group in Chrome's tab bar`}
                    >
                      Pin to Chrome
                    </button>
                  ) : null
                )}
              </div>
            )}
            <ul className="tab-list">
              {group.map((tab) => (
                <li
                  key={tab.id}
                  draggable={canMove || undefined}
                  className={`tab-item${tab.active ? ' tab-item--active' : ''}${draggingTabId === tab.id ? ' tab-item--dragging' : ''}`}
                  onClick={() => onTabClick(tab)}
                  onDragStart={canMove ? (e) => handleDragStart(e, tab.id, gi) : undefined}
                  onDragEnd={canMove ? handleDragEnd : undefined}
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
