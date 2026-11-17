import { type CacheDriver, type CacheEnvelope, createCacheDriver, emptyEnvelope } from '@/cache/cache-store'
import type {
  CacheDiagnostics,
  CacheEntry,
  CacheHitRecord,
  CacheStrategyConfig,
  DatasetVersion,
  HitStatus,
} from '@/data/types'

/** 旧键没有数据版本：只由查询键派生。 */
export function buildLegacyKey(queryCode: string): string {
  return `cache:${queryCode}`
}

/** 版本化键：查询键 + 数据版本同时参与建键，DATA-0003 升版后旧键自然失效。 */
export function buildVersionedKey(queryCode: string, datastoreCode: string, dataVersion: number): string {
  return `cache:${queryCode}:${datastoreCode}:v${dataVersion}`
}

/** 按查询键与数据版本构建缓存目录：版本化目录与旧键目录分开，但都挂在查询键下。 */
export function buildDirectory(queryCode: string, datastoreCode: string, dataVersion: number | null): string {
  if (dataVersion === null) {
    return `${queryCode}/legacy`
  }
  return `${queryCode}/v${dataVersion}/${datastoreCode}`
}

export type BuildCacheInput = {
  strategy: CacheStrategyConfig
  queryCode: string
  datastoreCode: string
  queryResult: unknown[]
  migratedFrom?: string | null
  migrationMode?: 'in-place' | 'new-directory' | null
}

export type LookupCacheInput = {
  strategy: CacheStrategyConfig
  queryCode: string
  datastoreCode: string
  /** legacy 模式下命中旧键后如何迁移：原地升级旧键，或另建版本化目录。 */
  migrationMode?: 'in-place' | 'new-directory'
}

export type LookupResult = {
  record: CacheHitRecord
  entry: CacheEntry | null
}

export type EvictionReport = { evictedKeys: string[]; sizeBefore: number; sizeAfter: number }

type HitDraft = {
  strategyCode: string
  queryCode: string
  datastoreCode: string
  cacheKey: string
  directory: string
  dataVersion: number | null
  hit: boolean
  status: HitStatus
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

type Clock = () => Date

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 查询缓存引擎：读取查询结果与数据集版本，按查询键 + 数据版本构建缓存目录，
 * 并把每一次命中/未命中写进「缓存命中结果记录集」。
 */
export class QueryCacheEngine {
  private driver: CacheDriver
  private clock: Clock
  /** 正在读取的完整结果对应的缓存键，淘汰时受保护，杜绝读到半份缓存。 */
  private readers = new Set<string>()
  /** 同键并发写入只落一份：在途构建复用同一个 Promise。 */
  private inflight = new Map<string, Promise<CacheHitRecord>>()

  constructor(driver?: CacheDriver, clock?: Clock) {
    this.driver = driver ?? createCacheDriver()
    this.clock = clock ?? (() => new Date())
  }

  private now(): string {
    return this.clock().toISOString()
  }

  private load(): CacheEnvelope {
    return this.driver.read() ?? emptyEnvelope()
  }

  private store(envelope: CacheEnvelope): void {
    // 版本台账、缓存条目、命中记录在同一次写入里落盘，保证同时可见。
    this.driver.write(envelope)
  }

  // ---------------- 数据集版本 ----------------

  getDatasetVersion(datastoreCode: string): DatasetVersion | null {
    return this.load().versions[datastoreCode] ?? null
  }

  listDatasetVersions(): DatasetVersion[] {
    return Object.values(this.load().versions).sort((a, b) => a.datastoreCode.localeCompare(b.datastoreCode))
  }

  /** 首次按数据集登记版本，与第一次缓存写入同时可见。 */
  ensureDatasetVersion(datastoreCode: string, by = '本地开发兜底'): DatasetVersion {
    const envelope = this.load()
    const existing = envelope.versions[datastoreCode]
    if (existing) {
      return existing
    }
    const created: DatasetVersion = {
      datastoreCode,
      version: 1,
      updatedAt: this.now(),
      updatedBy: by,
      reason: '首次登记数据版本',
    }
    envelope.versions[datastoreCode] = created
    this.store(envelope)
    return created
  }

  /** DATA-0003 升版：旧版本键保留留痕但不再命中，必须重新构建版本化缓存。 */
  bumpDatasetVersion(datastoreCode: string, by = '本地开发兜底', reason = '数据集升版'): DatasetVersion {
    const envelope = this.load()
    const previous = envelope.versions[datastoreCode]
    const next: DatasetVersion = {
      datastoreCode,
      version: previous ? previous.version + 1 : 1,
      updatedAt: this.now(),
      updatedBy: by,
      reason,
    }
    envelope.versions[datastoreCode] = next
    this.store(envelope)
    return next
  }

  /** 构建路径内部使用：在给定信封里登记/返回数据版本，由调用方统一落盘。 */
  private ensureDatasetVersionInternal(envelope: CacheEnvelope, datastoreCode: string): DatasetVersion {
    const existing = envelope.versions[datastoreCode]
    if (existing) {
      return existing
    }
    const created: DatasetVersion = {
      datastoreCode,
      version: 1,
      updatedAt: this.now(),
      updatedBy: '缓存构建',
      reason: '缓存构建时首次登记数据版本',
    }
    envelope.versions[datastoreCode] = created
    return created
  }

  // ---------------- 缓存构建 ----------------

  async buildCache(input: BuildCacheInput): Promise<CacheHitRecord> {
    const { queryCode, datastoreCode, queryResult } = input
    const envelope = this.load()
    const version = this.ensureDatasetVersionInternal(envelope, datastoreCode)
    // 先把数据版本落盘，再构建版本化键；最终缓存写入仍与版本在同一信封里同时可见。
    this.store(envelope)
    const cacheKey = buildVersionedKey(queryCode, datastoreCode, version.version)
    const pending = this.inflight.get(cacheKey)
    if (pending) {
      // 并发写入复用在途构建，只落一份缓存命中结果记录集。
      return pending
    }
    const task = this.completeBuild(input, cacheKey, version.version, queryResult)
    this.inflight.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.inflight.delete(cacheKey)
    }
  }

  private async completeBuild(
    input: BuildCacheInput,
    cacheKey: string,
    dataVersion: number,
    queryResult: unknown[],
  ): Promise<CacheHitRecord> {
    // await 让出事件循环，验证并发调用会被 inflight 去重，而不是各写一份。
    await Promise.resolve()
    const envelope = this.load()
    const existing = envelope.entries[cacheKey]
    const ttlSeconds = toNumber(input.strategy.ttlSeconds, 300)
    const createdAt = this.now()
    const expiresAt = new Date(this.clock().getTime() + ttlSeconds * 1000).toISOString()
    const sizeBefore = this.activeSize(envelope, input.strategy.strategyCode)

    // 版本冲突处理：同键已提交的版本与本次构建版本不一致时比较取舍，高版本胜出。
    if (existing && existing.state === 'complete' && existing.dataVersion !== dataVersion) {
      const keepExisting = (existing.dataVersion ?? -1) > dataVersion
      const record = this.appendHit(envelope, {
        strategyCode: input.strategy.strategyCode,
        queryCode: input.queryCode,
        datastoreCode: input.datastoreCode,
        cacheKey,
        directory: buildDirectory(input.queryCode, input.datastoreCode, dataVersion),
        dataVersion,
        hit: false,
        status: 'version-conflict',
        failure: true,
        reason: keepExisting
          ? `版本冲突：已提交版本 v${existing.dataVersion} 高于本次构建 v${dataVersion}，保留已提交缓存`
          : `版本冲突：本次构建 v${dataVersion} 高于已提交 v${existing.dataVersion}，以新版本覆盖`,
        migratedFrom: input.migratedFrom ?? null,
        migrationMode: input.migrationMode ?? null,
        evictedKeys: [],
        capacity: toNumber(input.strategy.maxEntries, 10),
        sizeBefore,
        sizeAfter: this.activeSize(envelope, input.strategy.strategyCode),
        resultRows: queryResult.length,
      })
      if (!keepExisting) {
        envelope.entries[cacheKey] = this.newCompleteEntry(input, cacheKey, dataVersion, queryResult, createdAt, expiresAt)
      }
      this.store(envelope)
      return record
    }

    // 旧键原地升级：旧键目录标记失效并留痕；另建目录模式则保留旧键可读。
    const migratedLegacyKeys: string[] = []
    if (input.migratedFrom && input.migrationMode === 'in-place') {
      const legacy = envelope.entries[input.migratedFrom]
      if (legacy && legacy.state === 'complete') {
        legacy.state = 'evicted'
        legacy.evictedAt = createdAt
        legacy.evictReason = '旧键原地升级为版本化键'
        migratedLegacyKeys.push(legacy.cacheKey)
      }
    }

    envelope.entries[cacheKey] = this.newCompleteEntry(input, cacheKey, dataVersion, queryResult, createdAt, expiresAt)
    const eviction = this.evictIfNeeded(envelope, input.strategy)
    const sizeAfter = this.activeSize(envelope, input.strategy.strategyCode)

    const record = this.appendHit(envelope, {
      strategyCode: input.strategy.strategyCode,
      queryCode: input.queryCode,
      datastoreCode: input.datastoreCode,
      cacheKey,
      directory: buildDirectory(input.queryCode, input.datastoreCode, dataVersion),
      dataVersion,
      hit: true,
      status: input.migratedFrom ? 'hit-migrated' : 'hit',
      failure: false,
      reason: input.migratedFrom
        ? `迁移来源 ${input.migratedFrom}（${input.migrationMode === 'in-place' ? '原地升级旧键' : '另建版本化目录'}），写入版本化缓存`
        : `按查询键与数据版本 v${dataVersion} 构建缓存目录`,
      migratedFrom: input.migratedFrom ?? null,
      migrationMode: input.migrationMode ?? null,
      evictedKeys: [...eviction.evictedKeys, ...migratedLegacyKeys],
      capacity: toNumber(input.strategy.maxEntries, 10),
      sizeBefore,
      sizeAfter,
      resultRows: queryResult.length,
    })
    this.store(envelope)
    return record
  }

  private newCompleteEntry(
    input: BuildCacheInput,
    cacheKey: string,
    dataVersion: number,
    queryResult: unknown[],
    createdAt: string,
    expiresAt: string,
  ): CacheEntry {
    return {
      cacheKey,
      directory: buildDirectory(input.queryCode, input.datastoreCode, dataVersion),
      strategyCode: input.strategy.strategyCode,
      queryCode: input.queryCode,
      datastoreCode: input.datastoreCode,
      dataVersion,
      state: 'complete',
      queryResult: JSON.parse(JSON.stringify(queryResult)) as unknown[],
      resultRows: queryResult.length,
      createdAt,
      completedAt: createdAt,
      expiresAt,
      lastHitAt: null,
      hitCount: 0,
      readers: 0,
      migratedFrom: input.migratedFrom ?? null,
      migrationMode: input.migrationMode ?? null,
      buildToken: dataVersion,
      evictedAt: null,
      evictReason: null,
    }
  }

  // ---------------- 缓存查询（命中核对） ----------------

  lookupCache(input: LookupCacheInput): LookupResult {
    const envelope = this.load()
    const { strategy, queryCode, datastoreCode } = input
    const capacity = toNumber(strategy.maxEntries, 10)
    const sizeBefore = this.activeSize(envelope, strategy.strategyCode)
    const base = {
      strategyCode: strategy.strategyCode,
      queryCode,
      datastoreCode,
      capacity,
      sizeBefore,
      sizeAfter: sizeBefore,
      evictedKeys: [] as string[],
      migratedFrom: null,
      migrationMode: null,
    }
    const version = envelope.versions[datastoreCode] ?? null
    const currentVersion = version ? version.version : null
    const legacyKey = buildLegacyKey(queryCode)
    const legacyEntry = envelope.entries[legacyKey] ?? null

    // 没有数据版本台账（历史数据）：旧键仍可直接命中，绝不把旧键未命中误报成新查询失败。
    if (currentVersion === null) {
      if (legacyEntry && legacyEntry.state === 'complete' && !this.isExpired(legacyEntry)) {
        return this.legacyHit(envelope, legacyEntry, base, '旧键在无版本台账时直接命中')
      }
      return {
        record: this.missRecord(envelope, {
          ...base,
          cacheKey: legacyKey,
          directory: buildDirectory(queryCode, datastoreCode, null),
          dataVersion: null,
          status: 'miss-legacy',
          reason: '尚无数据版本台账且没有可用旧键，按未命中处理（非失败）',
          resultRows: 0,
        }),
        entry: null,
      }
    }

    const versionedKey = buildVersionedKey(queryCode, datastoreCode, currentVersion)
    const entry = envelope.entries[versionedKey] ?? null

    if (entry && entry.state === 'complete') {
      if (this.isExpired(entry)) {
        return {
          record: this.missRecord(envelope, {
            ...base,
            cacheKey: versionedKey,
            directory: entry.directory,
            dataVersion: currentVersion,
            status: 'expired',
            reason: `缓存已于 ${entry.expiresAt} 过期，不能命中`,
            resultRows: entry.resultRows,
          }),
          entry: null,
        }
      }
      entry.lastHitAt = this.now()
      entry.hitCount += 1
      const record = this.appendHit(envelope, {
        ...base,
        cacheKey: versionedKey,
        directory: entry.directory,
        dataVersion: currentVersion,
        hit: true,
        status: 'hit',
        failure: false,
        reason: `数据版本 v${currentVersion} 核对通过，第二次进入直接命中`,
        resultRows: entry.resultRows,
      })
      this.store(envelope)
      return { record, entry }
    }

    if (entry && entry.state === 'building') {
      return {
        record: this.missRecord(envelope, {
          ...base,
          cacheKey: versionedKey,
          directory: buildDirectory(queryCode, datastoreCode, currentVersion),
          dataVersion: currentVersion,
          status: 'building',
          reason: '缓存仍在构建中，不能命中不完整结果',
          resultRows: 0,
        }),
        entry: null,
      }
    }

    // 版本不符：存在旧版本/已淘汰的版本化条目，但当前版本没有完整缓存。
    // 旧键（dataVersion 为 null）不在此处理，交给下面的迁移路径保持可读。
    const stale = Object.values(envelope.entries).find(
      (candidate) =>
        candidate.queryCode === queryCode &&
        candidate.datastoreCode === datastoreCode &&
        candidate.cacheKey !== versionedKey &&
        candidate.dataVersion !== null,
    )
    if (stale) {
      const mismatchReason =
        stale.dataVersion !== currentVersion
          ? `数据版本不符：缓存为 v${stale.dataVersion}，当前为 v${currentVersion}，旧键失效`
          : '目标缓存条目已淘汰，不能命中'
      return {
        record: this.missRecord(envelope, {
          ...base,
          cacheKey: versionedKey,
          directory: buildDirectory(queryCode, datastoreCode, currentVersion),
          dataVersion: currentVersion,
          status: stale.dataVersion !== currentVersion ? 'version-mismatch' : 'evicted',
          reason: mismatchReason,
          resultRows: stale.resultRows,
        }),
        entry: null,
      }
    }

    // 旧键迁移：旧键没有数据版本而新查询要求版本化键。
    if (legacyEntry && legacyEntry.state === 'complete' && !this.isExpired(legacyEntry)) {
      const mode = input.migrationMode ?? 'in-place'
      const migrated = this.migrateLegacy(envelope, legacyEntry, input, currentVersion, mode, base.sizeBefore)
      this.store(envelope)
      return migrated
    }

    if (legacyEntry && this.isExpired(legacyEntry)) {
      return {
        record: this.missRecord(envelope, {
          ...base,
          cacheKey: versionedKey,
          directory: buildDirectory(queryCode, datastoreCode, currentVersion),
          dataVersion: currentVersion,
          status: 'expired',
          reason: `旧键 ${legacyKey} 已过期，不能迁移命中`,
          resultRows: legacyEntry.resultRows,
        }),
        entry: null,
      }
    }

    return {
      record: this.missRecord(envelope, {
        ...base,
        cacheKey: versionedKey,
        directory: buildDirectory(queryCode, datastoreCode, currentVersion),
        dataVersion: currentVersion,
        status: 'miss',
        reason: '版本化键下没有可用缓存，需要重新构建（非失败）',
        resultRows: 0,
      }),
      entry: null,
    }
  }

  private legacyHit(
    envelope: CacheEnvelope,
    legacyEntry: CacheEntry,
    base: HitBase,
    reason: string,
  ): LookupResult {
    legacyEntry.lastHitAt = this.now()
    legacyEntry.hitCount += 1
    const record = this.appendHit(envelope, {
      ...base,
      cacheKey: legacyEntry.cacheKey,
      directory: legacyEntry.directory,
      dataVersion: null,
      hit: true,
      status: 'hit',
      failure: false,
      reason,
      resultRows: legacyEntry.resultRows,
    })
    this.store(envelope)
    return { record, entry: legacyEntry }
  }

  private migrateLegacy(
    envelope: CacheEnvelope,
    legacyEntry: CacheEntry,
    input: LookupCacheInput,
    currentVersion: number,
    mode: 'in-place' | 'new-directory',
    sizeBefore: number,
  ): LookupResult {
    const { strategy, queryCode, datastoreCode } = input
    const versionedKey = buildVersionedKey(queryCode, datastoreCode, currentVersion)
    const now = this.now()
    const ttlSeconds = toNumber(strategy.ttlSeconds, 300)
    const migratedEntry: CacheEntry = {
      ...JSON.parse(JSON.stringify(legacyEntry)) as CacheEntry,
      cacheKey: versionedKey,
      directory: buildDirectory(queryCode, datastoreCode, currentVersion),
      dataVersion: currentVersion,
      state: 'complete',
      createdAt: now,
      completedAt: now,
      expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1000).toISOString(),
      lastHitAt: now,
      hitCount: 1,
      readers: 0,
      migratedFrom: legacyEntry.cacheKey,
      migrationMode: mode,
      buildToken: currentVersion,
      evictedAt: null,
      evictReason: null,
    }
    envelope.entries[versionedKey] = migratedEntry
    const evictedKeys: string[] = []
    if (mode === 'in-place') {
      // 原地升级旧键：旧键标记失效，两种路径都保持新目录可读。
      legacyEntry.state = 'evicted'
      legacyEntry.evictedAt = now
      legacyEntry.evictReason = '旧键原地升级为版本化键'
      evictedKeys.push(legacyEntry.cacheKey)
    }
    const eviction = this.evictIfNeeded(envelope, strategy)
    evictedKeys.push(...eviction.evictedKeys)
    const record = this.appendHit(envelope, {
      strategyCode: strategy.strategyCode,
      queryCode,
      datastoreCode,
      cacheKey: versionedKey,
      directory: migratedEntry.directory,
      dataVersion: currentVersion,
      hit: true,
      status: 'hit-migrated',
      failure: false,
      reason: `旧键 ${legacyEntry.cacheKey} 没有数据版本，${mode === 'in-place' ? '原地升级旧键' : '另建版本化目录'}后命中，迁移来源已记录`,
      migratedFrom: legacyEntry.cacheKey,
      migrationMode: mode,
      evictedKeys,
      capacity: toNumber(strategy.maxEntries, 10),
      sizeBefore,
      sizeAfter: this.activeSize(envelope, strategy.strategyCode),
      resultRows: migratedEntry.resultRows,
    })
    return { record, entry: migratedEntry }
  }

  // ---------------- 读取保护 ----------------

  /** 读取完整结果期间占位；淘汰跳过 readers>0 的条目，避免拿到半份缓存。 */
  withRead<T>(cacheKey: string, reader: (entry: CacheEntry) => T): T {
    const envelope = this.load()
    const entry = envelope.entries[cacheKey]
    if (!entry || entry.state !== 'complete') {
      throw new Error(`缓存键 ${cacheKey} 没有完整结果可读`)
    }
    this.readers.add(cacheKey)
    entry.readers += 1
    this.store(envelope)
    try {
      return reader(entry)
    } finally {
      const after = this.load()
      const target = after.entries[cacheKey]
      if (target) {
        target.readers = Math.max(0, target.readers - 1)
      }
      this.readers.delete(cacheKey)
      this.store(after)
    }
  }

  // ---------------- 容量淘汰 ----------------

  private evictIfNeeded(envelope: CacheEnvelope, strategy: CacheStrategyConfig): EvictionReport {
    const maxEntries = toNumber(strategy.maxEntries, 10)
    const before = this.activeSize(envelope, strategy.strategyCode)
    const evictedKeys: string[] = []
    let guard = 0
    while (this.activeSize(envelope, strategy.strategyCode) > maxEntries && guard < 100) {
      guard += 1
      const candidates = Object.values(envelope.entries).filter(
        (entry) => entry.strategyCode === strategy.strategyCode && entry.state === 'complete',
      )
      // 正在读取的完整结果不能淘汰，否则会拿到半份缓存。
      const removable = candidates.filter((entry) => entry.readers === 0 && !this.readers.has(entry.cacheKey))
      if (removable.length === 0) {
        break
      }
      const victim = this.pickEvictionVictim(removable, strategy.evictionAlgorithm)
      victim.state = 'evicted'
      victim.evictedAt = this.now()
      victim.evictReason = this.isExpired(victim)
        ? '过期淘汰'
        : `超过容量上限 ${maxEntries}，按${strategy.evictionAlgorithm || 'LRU'}淘汰已完成条目`
      evictedKeys.push(victim.cacheKey)
    }
    return { evictedKeys, sizeBefore: before, sizeAfter: this.activeSize(envelope, strategy.strategyCode) }
  }

  private pickEvictionVictim(candidates: CacheEntry[], algorithm: string): CacheEntry {
    const expired = candidates.filter((entry) => this.isExpired(entry))
    const pool = expired.length > 0 ? expired : candidates
    const upper = algorithm.toUpperCase()
    if (upper.includes('FIFO')) {
      return [...pool].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    }
    // 默认 LRU：最久未命中的已完成条目先淘汰。
    return [...pool].sort((a, b) => {
      const ta = a.lastHitAt ?? a.completedAt ?? a.createdAt
      const tb = b.lastHitAt ?? b.completedAt ?? b.createdAt
      return ta.localeCompare(tb)
    })[0]
  }

  private activeSize(envelope: CacheEnvelope, strategyCode: string): number {
    return Object.values(envelope.entries).filter(
      (entry) => entry.strategyCode === strategyCode && entry.state !== 'evicted',
    ).length
  }

  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt < this.now()
  }

  // ---------------- 旧键写入（供迁移场景测试/兜底） ----------------

  /** 写入历史旧键：没有数据版本，保留可读，等待新查询触发迁移。 */
  writeLegacyEntry(input: {
    strategy: CacheStrategyConfig
    queryCode: string
    datastoreCode: string
    queryResult: unknown[]
  }): CacheEntry {
    const envelope = this.load()
    const cacheKey = buildLegacyKey(input.queryCode)
    const now = this.now()
    const ttlSeconds = toNumber(input.strategy.ttlSeconds, 300)
    const entry: CacheEntry = {
      cacheKey,
      directory: buildDirectory(input.queryCode, input.datastoreCode, null),
      strategyCode: input.strategy.strategyCode,
      queryCode: input.queryCode,
      datastoreCode: input.datastoreCode,
      dataVersion: null,
      state: 'complete',
      queryResult: JSON.parse(JSON.stringify(input.queryResult)) as unknown[],
      resultRows: input.queryResult.length,
      createdAt: now,
      completedAt: now,
      expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1000).toISOString(),
      lastHitAt: null,
      hitCount: 0,
      readers: 0,
      migratedFrom: null,
      migrationMode: null,
      buildToken: 0,
      evictedAt: null,
      evictReason: null,
    }
    envelope.entries[cacheKey] = entry
    this.store(envelope)
    return entry
  }

  // ---------------- 命中结果记录集 ----------------

  private appendHit(envelope: CacheEnvelope, draft: HitDraft): CacheHitRecord {
    envelope.hitSequence += 1
    const record: CacheHitRecord = {
      id: envelope.hitSequence,
      recordNo: `CHIT-${String(envelope.hitSequence).padStart(4, '0')}`,
      at: this.now(),
      ...draft,
    }
    envelope.hitRecords.push(record)
    return record
  }

  private missRecord(envelope: CacheEnvelope, draft: Omit<HitDraft, 'hit' | 'failure'>): CacheHitRecord {
    const record = this.appendHit(envelope, { ...draft, hit: false, failure: false })
    this.store(envelope)
    return record
  }

  listHitRecords(): CacheHitRecord[] {
    return [...this.load().hitRecords].sort((a, b) => b.id - a.id)
  }

  getEntry(cacheKey: string): CacheEntry | null {
    return this.load().entries[cacheKey] ?? null
  }

  listEntries(): CacheEntry[] {
    return Object.values(this.load().entries).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * 对账摘除：人工核对发现条目损坏时物理移除，保留其历史命中记录。
   * 之后导出一致性核对会发现「命中记录没有对应明细」，阻止带病导出。
   */
  removeEntry(cacheKey: string): boolean {
    const envelope = this.load()
    if (!envelope.entries[cacheKey]) {
      return false
    }
    delete envelope.entries[cacheKey]
    this.store(envelope)
    return true
  }

  // ---------------- 诊断与重置 ----------------

  diagnostics(): CacheDiagnostics {
    const envelope = this.load()
    const entries = Object.values(envelope.entries)
    const records = envelope.hitRecords
    const hits = records.filter((record) => record.hit).length
    const misses = records.filter((record) => !record.hit && !record.failure).length
    const failures = records.filter((record) => record.failure).length
    return {
      driver: this.driver.name,
      strategyCount: new Set(entries.map((entry) => entry.strategyCode)).size,
      entryCount: entries.length,
      completeEntries: entries.filter((entry) => entry.state === 'complete').length,
      buildingEntries: entries.filter((entry) => entry.state === 'building').length,
      evictedEntries: entries.filter((entry) => entry.state === 'evicted').length,
      legacyEntries: entries.filter((entry) => entry.dataVersion === null).length,
      versionedEntries: entries.filter((entry) => entry.dataVersion !== null).length,
      activeReaders: entries.reduce((sum, entry) => sum + entry.readers, 0),
      hitRecords: records.length,
      hits,
      misses,
      failures,
      hitRate: records.length === 0 ? 0 : Number((hits / records.length).toFixed(4)),
      datasetVersions: this.listDatasetVersions(),
    }
  }

  reset(): void {
    this.readers.clear()
    this.inflight.clear()
    this.driver.reset()
  }
}

type HitBase = {
  strategyCode: string
  queryCode: string
  datastoreCode: string
  capacity: number | null
  sizeBefore: number
  sizeAfter: number
  evictedKeys: string[]
  migratedFrom: string | null
  migrationMode: 'in-place' | 'new-directory' | null
}

/** 单例引擎：页面、导出入口、测试重置都围绕同一个驱动，保证刷新后仍可核对。 */
let engineSingleton: QueryCacheEngine | null = null

export function getQueryCacheEngine(): QueryCacheEngine {
  if (!engineSingleton) {
    engineSingleton = new QueryCacheEngine()
  }
  return engineSingleton
}

export function resetQueryCacheEngine(): QueryCacheEngine {
  engineSingleton?.reset()
  engineSingleton = new QueryCacheEngine()
  return engineSingleton
}
