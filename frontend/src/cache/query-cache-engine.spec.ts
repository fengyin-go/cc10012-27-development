import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryDriver } from '@/cache/cache-store'
import type { CacheDriver } from '@/cache/cache-store'
import {
  buildDirectory,
  buildLegacyKey,
  buildVersionedKey,
  QueryCacheEngine,
} from '@/cache/query-cache-engine'
import type { CacheEntry, CacheStrategyConfig } from '@/data/types'

const QUERY = 'QUER-0001'
const DATASTORE = 'DATA-0003'
const STRATEGY = 'CACH-0003'

function makeStrategy(overrides: Partial<CacheStrategyConfig> = {}): CacheStrategyConfig {
  return {
    strategyCode: STRATEGY,
    targetQuery: QUERY,
    keyRule: '查询键+数据版本',
    ttlSeconds: 300,
    refreshTrigger: '手动刷新',
    hitRateThreshold: 80,
    maxEntries: 3,
    evictionAlgorithm: 'LRU',
    enabled: true,
    ...overrides,
  }
}

function resultRows(marker: string): Record<string, string>[] {
  return [{ 语句编号: QUERY, 数据集编号: DATASTORE, 标记: marker }]
}

/** 可控时钟：默认固定时间，测试里手动拨钟验证过期。 */
function mutableClock(start = new Date('2026-11-17T08:00:00.000Z')) {
  let current = new Date(start)
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
  }
}

function makeEngine(driver?: CacheDriver) {
  const clock = mutableClock()
  const sharedDriver = driver ?? createMemoryDriver()
  const engine = new QueryCacheEngine(sharedDriver, clock.now)
  return { engine, driver: sharedDriver, clock }
}

describe('缓存键与缓存目录构建', () => {
  it('旧键不带数据版本，版本化键同时包含查询键与数据版本', () => {
    expect(buildLegacyKey(QUERY)).toBe('cache:QUER-0001')
    expect(buildVersionedKey(QUERY, DATASTORE, 1)).toBe('cache:QUER-0001:DATA-0003:v1')
    expect(buildDirectory(QUERY, DATASTORE, null)).toBe('QUER-0001/legacy')
    expect(buildDirectory(QUERY, DATASTORE, 2)).toBe('QUER-0001/v2/DATA-0003')
  })
})

describe('CACH-0003 对 QUER-0001 与 DATA-0003 建键后第二次命中', () => {
  let engine: QueryCacheEngine
  let driver: CacheDriver

  beforeEach(() => {
    const kit = makeEngine()
    engine = kit.engine
    driver = kit.driver
  })

  it('首次构建落版本化条目，再次进入按数据版本核对命中', async () => {
    const built = await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('首次'),
    })
    expect(built.hit).toBe(true)
    expect(built.status).toBe('hit')
    expect(built.cacheKey).toBe(buildVersionedKey(QUERY, DATASTORE, 1))
    expect(built.dataVersion).toBe(1)
    expect(built.directory).toBe(buildDirectory(QUERY, DATASTORE, 1))

    const version = engine.getDatasetVersion(DATASTORE)
    expect(version?.version).toBe(1)

    const second = engine.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(second.record.hit).toBe(true)
    expect(second.record.status).toBe('hit')
    expect(second.entry?.hitCount).toBe(1)
    expect(second.entry?.queryResult).toEqual(resultRows('首次'))
  })

  it('缓存写入与数据集版本在同一信封里同时可见', async () => {
    await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('原子'),
    })
    const envelope = driver.read()!
    expect(envelope.versions[DATASTORE].version).toBe(1)
    expect(Object.keys(envelope.entries)).toHaveLength(1)
    expect(envelope.hitRecords).toHaveLength(1)
  })

  it('刷新后重新进入页面，新引擎复用同一驱动仍可核对记录集与命中', async () => {
    await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('持久化'),
    })
    const reloaded = new QueryCacheEngine(driver)
    expect(reloaded.listHitRecords()).toHaveLength(1)
    const lookup = reloaded.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(lookup.record.hit).toBe(true)
    expect(reloaded.getEntry(buildVersionedKey(QUERY, DATASTORE, 1))?.state).toBe('complete')
  })
})

describe('DATA-0003 升版后旧键失效', () => {
  it('升版后版本不符不能命中，重新构建新版本键后才恢复命中', async () => {
    const kit = makeEngine()
    const { engine } = kit
    await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('v1结果'),
    })
    const v1Key = buildVersionedKey(QUERY, DATASTORE, 1)

    engine.bumpDatasetVersion(DATASTORE, '值班管理员', '手动升版')
    expect(engine.getDatasetVersion(DATASTORE)?.version).toBe(2)

    const stale = engine.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(stale.record.hit).toBe(false)
    expect(stale.record.status).toBe('version-mismatch')
    expect(stale.record.failure).toBe(false)
    // 旧键保留留痕但不再可命中。
    expect(engine.getEntry(v1Key)?.state).toBe('complete')
    expect(stale.entry).toBeNull()

    const rebuilt = await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('v2结果'),
    })
    expect(rebuilt.cacheKey).toBe(buildVersionedKey(QUERY, DATASTORE, 2))
    const hitAgain = engine.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(hitAgain.record.hit).toBe(true)
    expect(hitAgain.entry?.queryResult).toEqual(resultRows('v2结果'))
  })
})

describe('过期条目不能命中', () => {
  it('TTL 到期后 lookup 返回 expired 未命中且不算失败', async () => {
    const kit = makeEngine()
    const { engine, clock } = kit
    await engine.buildCache({
      strategy: makeStrategy({ ttlSeconds: 300 }),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('会过期'),
    })
    clock.advance(301 * 1000)
    const lookup = engine.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(lookup.record.hit).toBe(false)
    expect(lookup.record.status).toBe('expired')
    expect(lookup.record.failure).toBe(false)
    expect(lookup.entry).toBeNull()
  })
})

describe('并发写入只落一份缓存命中结果记录集', () => {
  it('同键并发构建复用在途任务，只产生一个条目与一条构建记录', async () => {
    const kit = makeEngine()
    const { engine } = kit
    const input = {
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('并发'),
    }
    const results = await Promise.all([
      engine.buildCache(input),
      engine.buildCache(input),
      engine.buildCache(input),
    ])
    expect(results.every((record) => record.id === results[0].id)).toBe(true)
    const envelope = kit.driver.read()!
    expect(Object.keys(envelope.entries)).toHaveLength(1)
    expect(envelope.hitRecords).toHaveLength(1)
  })
})

describe('超过容量淘汰', () => {
  it('只淘汰已完成条目，正在读取的完整结果受保护，不会读到半份缓存', async () => {
    const kit = makeEngine()
    const { engine, driver } = kit
    const strategy = makeStrategy({ maxEntries: 2 })
    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0001',
      datastoreCode: DATASTORE,
      queryResult: resultRows('A'),
    })
    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0002',
      datastoreCode: DATASTORE,
      queryResult: resultRows('B'),
    })
    const keyA = buildVersionedKey('QUER-0001', DATASTORE, 1)

    // 模拟 A 正在被读取：读保护计数 > 0。
    const envelope = driver.read()!
    ;(envelope.entries[keyA] as CacheEntry).readers = 1
    driver.write(envelope)

    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0003',
      datastoreCode: DATASTORE,
      queryResult: resultRows('C'),
    })

    const keyB = buildVersionedKey('QUER-0002', DATASTORE, 1)
    const keyC = buildVersionedKey('QUER-0003', DATASTORE, 1)
    expect(engine.getEntry(keyA)?.state).toBe('complete')
    expect(engine.getEntry(keyA)?.queryResult).toEqual(resultRows('A'))
    expect(engine.getEntry(keyB)?.state).toBe('evicted')
    expect(engine.getEntry(keyC)?.state).toBe('complete')
    expect(engine.diagnostics().completeEntries).toBe(2)

    // 释放读者后 A 仍完整可读，没有半份数据。
    const released = driver.read()!
    ;(released.entries[keyA] as CacheEntry).readers = 0
    driver.write(released)
    const full = engine.withRead(keyA, (entry) => entry.queryResult)
    expect(full).toEqual(resultRows('A'))
  })

  it('building 条目不参与淘汰，容量统计只数未淘汰条目', async () => {
    const kit = makeEngine()
    const { engine, driver } = kit
    const strategy = makeStrategy({ maxEntries: 1 })
    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0001',
      datastoreCode: DATASTORE,
      queryResult: resultRows('A'),
    })
    // 手工放一个构建中的条目，淘汰算法必须跳过它。
    const envelope = driver.read()!
    const buildingKey = 'cache:QUER-0009:DATA-0003:v1'
    envelope.entries[buildingKey] = {
      ...(envelope.entries[buildVersionedKey('QUER-0001', DATASTORE, 1)] as CacheEntry),
      cacheKey: buildingKey,
      queryCode: 'QUER-0009',
      state: 'building',
      readers: 0,
    }
    driver.write(envelope)

    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0002',
      datastoreCode: DATASTORE,
      queryResult: resultRows('B'),
    })
    expect(engine.getEntry(buildingKey)?.state).toBe('building')
    const evictionRecord = engine
      .listHitRecords()
      .find((record) => record.evictedKeys.includes(buildVersionedKey('QUER-0001', DATASTORE, 1)))
    expect(evictionRecord).toBeDefined()
  })

  it('withRead 对非完整条目直接报错，杜绝半份缓存外泄', () => {
    const kit = makeEngine()
    const { engine } = kit
    expect(() => engine.withRead('cache:not-exist', () => true)).toThrow(/没有完整结果/)
  })

  it('多轮超上限时按 LRU 只淘汰最久未命中的已完成条目，并在记录集留痕', async () => {
    const kit = makeEngine()
    const { engine, clock } = kit
    const strategy = makeStrategy({ maxEntries: 2 })
    for (const code of ['QUER-0001', 'QUER-0002', 'QUER-0003']) {
      clock.advance(1000)
      await engine.buildCache({
        strategy,
        queryCode: code,
        datastoreCode: DATASTORE,
        queryResult: resultRows(code),
      })
    }
    // QUER-0001 最久未命中，先被淘汰。
    expect(engine.getEntry(buildVersionedKey('QUER-0001', DATASTORE, 1))?.state).toBe('evicted')
    expect(engine.diagnostics().completeEntries).toBe(2)

    // 让 QUER-0002 成为最近命中，则下一轮淘汰 QUER-0003 而不是 QUER-0002。
    clock.advance(1000)
    engine.lookupCache({ strategy, queryCode: 'QUER-0002', datastoreCode: DATASTORE })
    clock.advance(1000)
    await engine.buildCache({
      strategy,
      queryCode: 'QUER-0004',
      datastoreCode: DATASTORE,
      queryResult: resultRows('QUER-0004'),
    })
    expect(engine.getEntry(buildVersionedKey('QUER-0002', DATASTORE, 1))?.state).toBe('complete')
    expect(engine.getEntry(buildVersionedKey('QUER-0003', DATASTORE, 1))?.state).toBe('evicted')

    const records = engine.listHitRecords()
    const evictionRecord = records.find((record) =>
      record.evictedKeys.includes(buildVersionedKey('QUER-0003', DATASTORE, 1)),
    )
    expect(evictionRecord).toBeDefined()
    expect(evictionRecord?.sizeAfter).toBeLessThanOrEqual(2)
    // 淘汰原因写在被淘汰条目的留痕字段上，记录集负责挂上被淘汰的键。
    expect(engine.getEntry(buildVersionedKey('QUER-0003', DATASTORE, 1))?.evictReason).toContain('超过容量上限')
  })
})

describe('旧键迁移：原地升级与另建版本化目录', () => {
  it('原地升级：旧键标记失效，版本化目录可读，记录迁移来源', async () => {
    const kit = makeEngine()
    const { engine } = kit
    const strategy = makeStrategy()
    const legacy = engine.writeLegacyEntry({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('旧键结果'),
    })
    engine.ensureDatasetVersion(DATASTORE)

    const lookup = engine.lookupCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      migrationMode: 'in-place',
    })
    expect(lookup.record.status).toBe('hit-migrated')
    expect(lookup.record.hit).toBe(true)
    expect(lookup.record.failure).toBe(false)
    expect(lookup.record.migratedFrom).toBe(legacy.cacheKey)
    expect(lookup.record.migrationMode).toBe('in-place')
    expect(engine.getEntry(legacy.cacheKey)?.state).toBe('evicted')
    expect(lookup.entry?.dataVersion).toBe(1)
    expect(lookup.entry?.migratedFrom).toBe(legacy.cacheKey)
  })

  it('另建目录：旧键保持可读，版本化目录同时可读，迁移来源留痕', () => {
    const kit = makeEngine()
    const { engine } = kit
    const strategy = makeStrategy()
    const legacy = engine.writeLegacyEntry({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('旧键结果'),
    })
    engine.ensureDatasetVersion(DATASTORE)

    const lookup = engine.lookupCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      migrationMode: 'new-directory',
    })
    expect(lookup.record.status).toBe('hit-migrated')
    expect(lookup.record.migrationMode).toBe('new-directory')
    expect(engine.getEntry(legacy.cacheKey)?.state).toBe('complete')
    expect(lookup.entry?.state).toBe('complete')
    expect(lookup.entry?.directory).toBe(buildDirectory(QUERY, DATASTORE, 1))
  })

  it('没有版本台账也没有旧键时，旧键未命中按 miss-legacy 处理且不误报失败', () => {
    const kit = makeEngine()
    const { engine } = kit
    const lookup = engine.lookupCache({ strategy: makeStrategy(), queryCode: QUERY, datastoreCode: DATASTORE })
    expect(lookup.record.status).toBe('miss-legacy')
    expect(lookup.record.hit).toBe(false)
    expect(lookup.record.failure).toBe(false)
  })

  it('旧键过期后不能迁移命中，按 expired 处理且不算失败', () => {
    const kit = makeEngine()
    const { engine, clock } = kit
    const strategy = makeStrategy({ ttlSeconds: 10 })
    engine.writeLegacyEntry({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('过期旧键'),
    })
    engine.ensureDatasetVersion(DATASTORE)
    clock.advance(11 * 1000)
    const lookup = engine.lookupCache({ strategy, queryCode: QUERY, datastoreCode: DATASTORE })
    expect(lookup.record.status).toBe('expired')
    expect(lookup.record.failure).toBe(false)
  })
})

describe('版本冲突处理：比较取舍', () => {
  it('已提交版本高于本次构建时保留已提交缓存，并记录一次失败', async () => {
    const kit = makeEngine()
    const { engine, driver } = kit
    const strategy = makeStrategy()
    await engine.buildCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('v1'),
    })
    // 模拟另一个写入者已在当前键上提交了更高版本 v3。
    const envelope = driver.read()!
    const currentKey = buildVersionedKey(QUERY, DATASTORE, 1)
    const higherEntry = { ...(envelope.entries[currentKey] as CacheEntry), dataVersion: 3, buildToken: 3 }
    envelope.entries[currentKey] = higherEntry
    driver.write(envelope)

    const conflict = await engine.buildCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('低版本写入'),
    })
    expect(conflict.status).toBe('version-conflict')
    expect(conflict.failure).toBe(true)
    expect(engine.getEntry(currentKey)?.dataVersion).toBe(3)
  })

  it('本次构建版本更高时覆盖旧缓存，冲突记录说明取舍方向', async () => {
    const kit = makeEngine()
    const { engine, driver } = kit
    const strategy = makeStrategy()
    await engine.buildCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('v1'),
    })
    const envelope = driver.read()!
    const currentKey = buildVersionedKey(QUERY, DATASTORE, 1)
    envelope.entries[currentKey] = {
      ...(envelope.entries[currentKey] as CacheEntry),
      dataVersion: 0,
      buildToken: 0,
    }
    driver.write(envelope)

    const conflict = await engine.buildCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('高版本覆盖'),
    })
    expect(conflict.status).toBe('version-conflict')
    expect(conflict.failure).toBe(true)
    expect(engine.getEntry(currentKey)?.dataVersion).toBe(1)
    expect(engine.getEntry(currentKey)?.queryResult).toEqual(resultRows('高版本覆盖'))
  })
})

describe('诊断与记录集核对', () => {
  it('命中率、驱动、版本化/旧键计数可核对', async () => {
    const kit = makeEngine()
    const { engine } = kit
    const strategy = makeStrategy()
    await engine.buildCache({
      strategy,
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('诊断'),
    })
    engine.lookupCache({ strategy, queryCode: QUERY, datastoreCode: DATASTORE })
    const diag = engine.diagnostics()
    expect(diag.driver).toBe('memory')
    expect(diag.versionedEntries).toBe(1)
    expect(diag.legacyEntries).toBe(0)
    expect(diag.hits).toBe(2)
    expect(diag.hitRate).toBe(1)
  })

  it('reset 清空条目、版本台账与命中记录', async () => {
    const kit = makeEngine()
    const { engine } = kit
    await engine.buildCache({
      strategy: makeStrategy(),
      queryCode: QUERY,
      datastoreCode: DATASTORE,
      queryResult: resultRows('待重置'),
    })
    engine.reset()
    expect(engine.listHitRecords()).toHaveLength(0)
    expect(engine.listEntries()).toHaveLength(0)
    expect(engine.listDatasetVersions()).toHaveLength(0)
  })
})
