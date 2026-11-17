import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildQueryCache,
  bumpDatastoreVersion,
  exportCacheHitRecords,
  lookupQueryCache,
  readStrategyConfig,
  resolveDatastoreCode,
  resolveStrategyForQuery,
  verifyCacheExportConsistency,
} from '@/cache/cache-service'
import { buildVersionedKey, getQueryCacheEngine, resetQueryCacheEngine } from '@/cache/query-cache-engine'

const QUERY = 'QUER-0001'
const DATASTORE = 'DATA-0003'
const STRATEGY = 'CACH-0003'

beforeEach(() => {
  resetQueryCacheEngine()
})

describe('策略配置与数据集解析', () => {
  it('从查询缓存登记行解析出可执行的策略配置', () => {
    const config = readStrategyConfig(STRATEGY)!
    expect(config).toMatchObject({
      strategyCode: STRATEGY,
      targetQuery: QUERY,
      keyRule: '查询键+数据版本',
      ttlSeconds: 300,
      maxEntries: 3,
      evictionAlgorithm: 'LRU',
      enabled: true,
    })
  })

  it('按目标查询精确解析策略，数据集编号从目标数据集字段提取', () => {
    expect(resolveStrategyForQuery(QUERY)?.strategyCode).toBe(STRATEGY)
    expect(resolveDatastoreCode(QUERY)).toBe(DATASTORE)
  })

  it('目标数据集没有有效 DATA 编号时显式报错，避免建错版本化键', () => {
    expect(() => resolveDatastoreCode('QUER-0002')).toThrow(/DATA 编号/)
  })
})

describe('服务端到端：构建、二次命中、升版失效', () => {
  it('构建后再次进入页面命中，命中通过数据版本核对', async () => {
    const built = await buildQueryCache(QUERY)
    expect(built.cacheKey).toBe(buildVersionedKey(QUERY, DATASTORE, 1))
    expect(built.dataVersion).toBe(1)

    const hit = lookupQueryCache(QUERY)
    expect(hit.hit).toBe(true)
    expect(hit.status).toBe('hit')

    const records = getQueryCacheEngine().listHitRecords()
    expect(records).toHaveLength(2)
  })

  it('DATA-0003 升版后旧键失效，记录为版本不符而不是新查询失败', async () => {
    await buildQueryCache(QUERY)
    const bumped = bumpDatastoreVersion(DATASTORE, '手动升版')
    expect(bumped.version).toBe(2)

    const stale = lookupQueryCache(QUERY)
    expect(stale.hit).toBe(false)
    expect(stale.status).toBe('version-mismatch')
    expect(stale.failure).toBe(false)
  })

  it('没有缓存也没有版本台账时，旧键未命中按 miss-legacy 处理，不误报失败', () => {
    const lookup = lookupQueryCache(QUERY)
    expect(lookup.status).toBe('miss-legacy')
    expect(lookup.failure).toBe(false)
    expect(lookup.hit).toBe(false)
  })
})

describe('导出入口读取缓存命中结果记录集', () => {
  it('导出结果与清单记录一致，导出入口与明细记录一致', async () => {
    await buildQueryCache(QUERY)
    lookupQueryCache(QUERY)

    const consistency = verifyCacheExportConsistency()
    expect(consistency.consistent).toBe(true)
    expect(consistency.exportRowCount).toBe(consistency.recordCount)
    expect(consistency.detailChecked).toBeGreaterThan(0)

    const { filename, content } = exportCacheHitRecords()
    expect(filename).toBe('缓存命中结果记录集.csv')
    expect(content).toContain('CHIT-0001')
    expect(content).toContain(buildVersionedKey(QUERY, DATASTORE, 1))
    expect(content).toContain('数据版本')
  })

  it('明细被摘除后一致性核对不通过，并给出可追溯的差异说明', async () => {
    await buildQueryCache(QUERY)
    const removed = getQueryCacheEngine().removeEntry(buildVersionedKey(QUERY, DATASTORE, 1))
    expect(removed).toBe(true)

    const consistency = verifyCacheExportConsistency()
    expect(consistency.consistent).toBe(false)
    expect(consistency.mismatches.join(' ')).toContain('明细条目')
  })

  it('版本不符的未命中记录不要求明细条目，仍可正常导出', async () => {
    await buildQueryCache(QUERY)
    bumpDatastoreVersion(DATASTORE)
    lookupQueryCache(QUERY)

    const consistency = verifyCacheExportConsistency()
    expect(consistency.consistent).toBe(true)
    const { content } = exportCacheHitRecords()
    expect(content).toContain('version-mismatch')
  })
})
