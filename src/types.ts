export type Tab = {
  title: string
  url: string
  id: number
  windowId: number
  index: number
  active: boolean
  pinned: boolean
  discarded: boolean
  favIconUrl?: string
}

export type Tabs = Tab[]

export type EnrichedTab = Tab & {
  signal: string | null
  category: string | null
}

export type ClusterCache = {
  clusters: Tab[][]
  labels: string[]
  centroids?: number[][]
}

export type ClusterProposal = {
  clusters: Tab[][]
  labels: string[]
  centroids: number[][]
  proposedAt: number
}

export type ClusterJob = {
  status: 'running' | 'done' | 'error'
  error?: string
}

export type EnrichedTabs = EnrichedTab[]
