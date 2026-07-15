import { useEffect, useRef, useState } from 'react'
import { Tab, ClusterCache, ClusterJob, ClusterProposal } from '@/types'
import TabList, { ChromeGroupInfo } from '@/components/TabList'
import GeminiGate from '@/components/GeminiGate'
import ProposalBanner from '@/components/ProposalBanner'
import { IconSettings } from '@/components/Icons'
import './App.css'

async function computeGroupInfo(clusters: Tab[][], windowId: number): Promise<ChromeGroupInfo[]> {
  const [chromeTabs, chromeGroups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ])
  const tabToGroupId = new Map(chromeTabs.map(t => [t.id!, t.groupId]))
  const groupIdToColor = new Map(chromeGroups.map(g => [g.id, g.color as string]))

  return clusters.map(cluster => {
    const groupIds = [...new Set(cluster.map(t => tabToGroupId.get(t.id) ?? -1).filter(id => id !== -1))]
    if (groupIds.length !== 1) return null
    const color = groupIdToColor.get(groupIds[0])
    return color ? { groupId: groupIds[0], color } : null
  })
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[][]>([])
  const [labels, setLabels] = useState<string[]>([])
  const [chromeGroups, setChromeGroups] = useState<ChromeGroupInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [clustering, setClustering] = useState(false)
  const [proposal, setProposal] = useState<ClusterProposal | null>(null)
  const windowIdRef = useRef<number | null>(null)

  useEffect(() => {
    const init = async () => {
      const win = await chrome.windows.getCurrent()
      const wid = win.id!
      windowIdRef.current = wid

      const [jobResult, proposalResult, response] = await Promise.all([
        chrome.storage.local.get(`clusterJob_${wid}`),
        chrome.storage.local.get(`clusterProposal_${wid}`),
        chrome.runtime.sendMessage({ action: 'GET_TABS', windowId: wid }),
      ])

      if ((jobResult[`clusterJob_${wid}`] as ClusterJob | undefined)?.status === 'running') setClustering(true)
      const savedProposal = proposalResult[`clusterProposal_${wid}`] as ClusterProposal | undefined
      if (savedProposal) setProposal(savedProposal)

      let clusters: Tab[][] = []
      if (response.status === 'cache_success') {
        clusters = response.tabs
        setTabs(clusters)
        setLabels(response.labels ?? [])
      } else if (response.status === 'success') {
        clusters = [response.tabs]
        setTabs(clusters)
      }
      setLoading(false)
      setChromeGroups(await computeGroupInfo(clusters, wid))
    }

    const handleStorageChange = async (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const wid = windowIdRef.current
      if (!wid || area !== 'local') return
      const cacheChange = changes[`clusterCache_${wid}`]
      if (cacheChange?.newValue) {
        const cache = cacheChange.newValue as ClusterCache
        setTabs(cache.clusters)
        setLabels(cache.labels ?? [])
        setChromeGroups(await computeGroupInfo(cache.clusters, wid))
      }
      const jobChange = changes[`clusterJob_${wid}`]
      if ((jobChange?.newValue as ClusterJob | undefined)?.status === 'done') setClustering(false)
      if ((jobChange?.newValue as ClusterJob | undefined)?.status === 'error') setClustering(false)
      const proposalChange = changes[`clusterProposal_${wid}`]
      if (proposalChange !== undefined) {
        setProposal(proposalChange.newValue as ClusterProposal | null ?? null)
      }
    }

    init().catch(console.error)
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [])

  const handleClusterTabs = () => {
    setClustering(true)
    chrome.windows.getCurrent()
      .then(win => chrome.runtime.sendMessage({ action: 'CLUSTER_TABS', windowId: win.id }))
      .then(async response => {
        if (response.status === 'success') {
          setTabs(response.clusters)
          setLabels(response.labels ?? [])
          const wid = windowIdRef.current
          if (wid) setChromeGroups(await computeGroupInfo(response.clusters, wid))
        }
      })
      .catch(console.error)
      .finally(() => setClustering(false))
  }

  const handleTabClick = (tab: Tab) => {
    chrome.runtime.sendMessage({ action: 'SET_ACTIVE_TAB', tabId: tab.id })
  }

  const handleTabClose = (tab: Tab) => {
    chrome.runtime.sendMessage({ action: 'CLOSE_TAB', tabId: tab.id })
  }

  const handleGroupCluster = async (group: Tab[], label: string, index: number) => {
    await chrome.runtime.sendMessage({
      action: 'CREATE_TAB_GROUP',
      tabIds: group.map(t => t.id),
      title: label,
      colorIndex: index,
      windowId: windowIdRef.current,
    })
    const wid = windowIdRef.current
    if (wid) setChromeGroups(await computeGroupInfo(tabs, wid))
  }

  const handleUngroupCluster = async (group: Tab[], _groupId: number) => {
    await chrome.runtime.sendMessage({ action: 'UNGROUP_TABS', tabIds: group.map(t => t.id) })
    const wid = windowIdRef.current
    if (wid) setChromeGroups(await computeGroupInfo(tabs, wid))
  }

  return (
    <GeminiGate className="panel">
      <div className="panel">
        <div className="toolbar">
          <span className="tab-count">{tabs.flat().length} tabs</span>
          <div className="toolbar-actions">
            <button onClick={handleClusterTabs} disabled={tabs.flat().length < 2 || clustering}>
              {clustering ? 'Tidying…' : 'Tidy Up'}
            </button>
            <button className="icon-btn" onClick={() => chrome.runtime.openOptionsPage()} title="Settings">
              <IconSettings />
            </button>
          </div>
        </div>
        {proposal && windowIdRef.current && (
          <ProposalBanner
            windowId={windowIdRef.current}
            proposal={proposal}
            onDismiss={() => setProposal(null)}
          />
        )}
        <TabList
          tabs={tabs}
          labels={labels}
          chromeGroups={chromeGroups}
          loading={loading}
          onTabClick={handleTabClick}
          onTabClose={handleTabClose}
          onGroupCluster={handleGroupCluster}
          onUngroupCluster={handleUngroupCluster}
        />
      </div>
    </GeminiGate>
  )
}
