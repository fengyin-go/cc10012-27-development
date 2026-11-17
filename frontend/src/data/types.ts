/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 缓存策略配置：从「查询缓存」模块的登记行解析出来，供缓存引擎读取。 */
export type CacheStrategyConfig = {
  strategyCode: string
  targetQuery: string
  keyRule: string
  ttlSeconds: number
  refreshTrigger: string
  hitRateThreshold: number
  maxEntries: number
  evictionAlgorithm: string
  enabled: boolean
}

/** 数据版本台账条目：按数据集编号登记当前版本，缓存命中必须通过数据版本核对。 */
export type DatasetVersion = {
  datastoreCode: string
  version: number
  updatedAt: string
  updatedBy: string
  reason: string
}

/** 缓存条目生命周期：building 不可命中，complete 可读，evicted 仅留痕核对。 */
export type CacheEntryState = 'building' | 'complete' | 'evicted'

/** 缓存目录中的一条查询缓存；旧键（dataVersion 为 null）与版本化键共用同一结构。 */
export type CacheEntry = {
  cacheKey: string
  directory: string
  strategyCode: string
  queryCode: string
  datastoreCode: string
  /** null 表示历史旧键，没有数据版本；版本化键写入构建时捕获的版本号。 */
  dataVersion: number | null
  state: CacheEntryState
  queryResult: unknown[]
  resultRows: number
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
  lastHitAt: string | null
  hitCount: number
  /** 正在读取这份完整结果的读者数，淘汰时 readers>0 的条目受保护，避免读到半份缓存。 */
  readers: number
  /** 迁移来源旧键；由旧键升级而来的版本化条目在这里留痕。 */
  migratedFrom: string | null
  migrationMode: 'in-place' | 'new-directory' | null
  /** 构建启动时捕获的数据版本，用于版本冲突的比较取舍。 */
  buildToken: number
  evictedAt: string | null
  evictReason: string | null
}

/** 缓存命中结果记录集里每条记录的核对状态。 */
export type HitStatus =
  | 'hit'
  | 'hit-migrated'
  | 'miss'
  | 'miss-legacy'
  | 'expired'
  | 'version-mismatch'
  | 'version-conflict'
  | 'evicted'
  | 'building'

/** 缓存命中结果记录集条目：承载缓存策略与查询缓存的完整核对链路。 */
export type CacheHitRecord = {
  id: number
  recordNo: string
  at: string
  strategyCode: string
  queryCode: string
  datastoreCode: string
  cacheKey: string
  directory: string
  dataVersion: number | null
  hit: boolean
  status: HitStatus
  /** 只有版本冲突这类真正失败才算 failure；旧键未命中不算新查询失败。 */
  failure: boolean
  reason: string
  migratedFrom: string | null
  migrationMode: 'in-place' | 'new-directory' | null
  evictedKeys: string[]
  capacity: number | null
  sizeBefore: number
  sizeAfter: number
  resultRows: number
}

export type CacheDiagnostics = {
  driver: 'localStorage' | 'memory'
  strategyCount: number
  entryCount: number
  completeEntries: number
  buildingEntries: number
  evictedEntries: number
  legacyEntries: number
  versionedEntries: number
  activeReaders: number
  hitRecords: number
  hits: number
  misses: number
  failures: number
  hitRate: number
  datasetVersions: DatasetVersion[]
}

/** 导出一致性核对结果：导出结果与清单记录一致，导出入口与明细记录一致。 */
export type ExportConsistency = {
  recordCount: number
  exportRowCount: number
  detailChecked: number
  consistent: boolean
  mismatches: string[]
}
