import { listRows } from '@/data/local-store'
import { getQueryCacheEngine } from '@/cache/query-cache-engine'
import type { CacheHitRecord, CacheStrategyConfig, DatasetVersion, EntryRow, ExportConsistency } from '@/data/types'

/**
 * 查询缓存服务：把「查询缓存」模块的策略登记行、交互查询结果、数据集版本
 * 接到缓存引擎上。页面只读这套服务，不直接操作引擎，状态流转判断仍集中在数据层。
 */

const CACHE_MODULE = 'cache'
const QUERY_MODULE = 'query'
const DATASTORE_MODULE = 'datastore'

function toInteger(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

/** 读取缓存策略登记行并解析成引擎可用的配置；占位/脏数据走兜底默认值。 */
export function readStrategyConfig(strategyCode?: string): CacheStrategyConfig | null {
  const rows = listRows(CACHE_MODULE)
  const row = strategyCode
    ? rows.find((item) => String(item['策略编号']) === strategyCode)
    : rows.find((item) => String(item.status) === '已启用')
  if (!row) {
    return null
  }
  return {
    strategyCode: String(row['策略编号'] ?? ''),
    targetQuery: String(row['目标查询'] ?? ''),
    keyRule: String(row['缓存键规则'] ?? '查询键+数据版本'),
    ttlSeconds: toInteger(row['过期秒数'], 300),
    refreshTrigger: String(row['刷新触发'] ?? '手动刷新'),
    hitRateThreshold: toInteger(row['命中率阈值'], 80),
    maxEntries: toInteger(row['最大条目数'], 10),
    evictionAlgorithm: String(row['淘汰算法'] ?? 'LRU'),
    enabled: String(row.status) === '已启用',
  }
}

export function listStrategyConfigs(): CacheStrategyConfig[] {
  return listRows(CACHE_MODULE)
    .map((row) =>
      readStrategyConfig(String(row['策略编号'])),
    )
    .filter((item): item is CacheStrategyConfig => item !== null)
}

/** 按查询编号解析适用的缓存策略：精确命中目标查询，否则取已启用策略兜底。 */
export function resolveStrategyForQuery(queryCode: string): CacheStrategyConfig | null {
  const configs = listStrategyConfigs()
  const exact = configs.find((config) => config.targetQuery === queryCode)
  if (exact) {
    return exact
  }
  return configs.find((config) => config.enabled) ?? configs[0] ?? null
}

function getQueryRow(queryCode: string): EntryRow | null {
  const rows = listRows(QUERY_MODULE)
  return (
    rows.find((row) => String(row['语句编号']) === queryCode) ??
    rows.find((row) => String(row.id) === queryCode) ??
    null
  )
}

/** 取查询的目标数据集编号；种子里直接登记 DATA 编号，无法解析时给出显式错误而不是静默建错键。 */
export function resolveDatastoreCode(queryCode: string): string {
  const row = getQueryRow(queryCode)
  const raw = row ? String(row['目标数据集'] ?? '') : ''
  const match = raw.match(/DATA-\d{4}/)
  if (match) {
    return match[0]
  }
  throw new Error(`查询 ${queryCode} 的目标数据集没有登记有效的 DATA 编号，无法构建版本化缓存键`)
}

/**
 * 读取查询结果：离线版没有真实执行引擎，用查询登记行合成可核对的结果集，
 * 真实接回后端时只替换这里，缓存键、版本与命中记录逻辑不变。
 */
export function readQueryResult(queryCode: string): Record<string, string | number | boolean>[] {
  const row = getQueryRow(queryCode)
  if (!row) {
    throw new Error(`没有找到查询语句 ${queryCode}`)
  }
  const datastoreCode = resolveDatastoreCode(queryCode)
  return [
    {
      语句编号: String(row['语句编号'] ?? queryCode),
      数据集编号: datastoreCode,
      查询表达式: String(row['查询表达式'] ?? ''),
      返回字段: String(row['返回字段'] ?? ''),
      抓取时间: new Date().toISOString(),
    },
  ]
}

export async function buildQueryCache(queryCode: string): Promise<CacheHitRecord> {
  const strategy = resolveStrategyForQuery(queryCode)
  if (!strategy) {
    throw new Error('没有可用的缓存策略，请先在查询缓存模块登记并启用策略')
  }
  const datastoreCode = resolveDatastoreCode(queryCode)
  const queryResult = readQueryResult(queryCode)
  return getQueryCacheEngine().buildCache({ strategy, queryCode, datastoreCode, queryResult })
}

export function lookupQueryCache(
  queryCode: string,
  migrationMode: 'in-place' | 'new-directory' = 'in-place',
): CacheHitRecord {
  const strategy = resolveStrategyForQuery(queryCode)
  if (!strategy) {
    throw new Error('没有可用的缓存策略，请先在查询缓存模块登记并启用策略')
  }
  const datastoreCode = resolveDatastoreCode(queryCode)
  return getQueryCacheEngine().lookupCache({ strategy, queryCode, datastoreCode, migrationMode }).record
}

export function bumpDatastoreVersion(
  datastoreCode: string,
  reason = '数据集升版',
  by = '值班管理员',
): DatasetVersion {
  return getQueryCacheEngine().bumpDatasetVersion(datastoreCode, by, reason)
}

export function listDatasetVersions(): DatasetVersion[] {
  return getQueryCacheEngine().listDatasetVersions()
}

export function listCacheHitRecords(): CacheHitRecord[] {
  return getQueryCacheEngine().listHitRecords()
}

/** 下游导出入口直接读取缓存命中结果记录集，保证导出结果与清单记录一致。 */
export function exportCacheHitRecords(): { filename: string; content: string } {
  const header = [
    '记录编号',
    '记录时间',
    '策略编号',
    '语句编号',
    '数据集编号',
    '缓存键',
    '缓存目录',
    '数据版本',
    '命中状态',
    '是否命中',
    '是否失败',
    '迁移来源',
    '迁移方式',
    '淘汰缓存键',
    '容量上限',
    '淘汰前条目',
    '淘汰后条目',
    '结果行数',
    '说明',
  ]
  const lines = [header.join(',')]
  for (const record of [...listCacheHitRecords()].sort((a, b) => a.id - b.id)) {
    lines.push(
      [
        record.recordNo,
        record.at,
        record.strategyCode,
        record.queryCode,
        record.datastoreCode,
        record.cacheKey,
        record.directory,
        record.dataVersion === null ? '无版本(旧键)' : `v${record.dataVersion}`,
        record.status,
        record.hit ? '命中' : '未命中',
        record.failure ? '失败' : '正常',
        record.migratedFrom ?? '',
        record.migrationMode ?? '',
        record.evictedKeys.join('|'),
        record.capacity ?? '',
        record.sizeBefore,
        record.sizeAfter,
        record.resultRows,
        record.reason,
      ]
        .map((cell) => String(cell).replace(/"/g, '""'))
        .map((cell) => `"${cell}"`)
        .join(','),
    )
  }
  return { filename: '缓存命中结果记录集.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadCacheHitRecords(): void {
  const { filename, content } = exportCacheHitRecords()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 导出一致性核对：导出结果与清单记录一致，导出入口与明细记录一致。 */

/**
 * 导出入口专用：读取缓存命中结果记录集，先做一致性核对再导出。
 * 清单记录 = 命中结果记录集；明细记录 = 缓存目录里的缓存条目。
 * 命中类记录的缓存键、目录必须能在明细条目里对上，否则不允许导出。
 */
export function verifyCacheExportConsistency(): ExportConsistency {
  const records = [...listCacheHitRecords()].sort((a, b) => a.id - b.id)
  const engine = getQueryCacheEngine()
  const { content } = exportCacheHitRecords()
  // CSV 首行是表头，其余每行对应一条清单记录。
  const exportRowCount = Math.max(0, content.split('\n').length - 1)
  const mismatches: string[] = []

  if (exportRowCount !== records.length) {
    mismatches.push(`导出行数 ${exportRowCount} 与清单记录数 ${records.length} 不一致`)
  }

  let detailChecked = 0
  for (const record of records) {
    if (!record.hit) {
      // 未命中记录本来就没有明细条目，只核对清单自身字段完整。
      if (!record.cacheKey || !record.directory) {
        mismatches.push(`${record.recordNo} 缺少缓存键或目录，清单字段不完整`)
      }
      continue
    }
    const entry = engine.getEntry(record.cacheKey)
    detailChecked += 1
    if (!entry) {
      mismatches.push(`${record.recordNo} 命中但明细条目 ${record.cacheKey} 不存在`)
      continue
    }
    if (entry.directory !== record.directory) {
      mismatches.push(
        `${record.recordNo} 目录不一致：清单=${record.directory}，明细=${entry.directory}`,
      )
    }
    if (entry.dataVersion !== record.dataVersion) {
      mismatches.push(
        `${record.recordNo} 数据版本不一致：清单=${String(record.dataVersion)}，明细=${String(entry.dataVersion)}`,
      )
    }
    if (entry.resultRows !== record.resultRows) {
      mismatches.push(
        `${record.recordNo} 结果行数不一致：清单=${record.resultRows}，明细=${entry.resultRows}`,
      )
    }
  }

  return {
    recordCount: records.length,
    exportRowCount,
    detailChecked,
    consistent: mismatches.length === 0,
    mismatches,
  }
}

/** 数据导出模块的导出入口：读取缓存命中结果记录集，核对通过后才下载。 */
export function downloadCacheHitRecordsFromExport(): ExportConsistency {
  const consistency = verifyCacheExportConsistency()
  if (!consistency.consistent) {
    throw new Error(`导出一致性核对未通过：${consistency.mismatches.join('；')}`)
  }
  downloadCacheHitRecords()
  return consistency
}
