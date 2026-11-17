import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  buildQueryCache,
  bumpDatastoreVersion,
  downloadCacheHitRecords,
  downloadCacheHitRecordsFromExport,
  listCacheHitRecords,
  lookupQueryCache,
  verifyCacheExportConsistency,
} from '@/cache/cache-service'
import { getQueryCacheEngine, resetQueryCacheEngine } from '@/cache/query-cache-engine'
import type {
  ActionResult,
  CacheDiagnostics,
  CacheHitRecord,
  DatasetVersion,
  EntryRow,
  ExportConsistency,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------- 查询缓存：构建、命中核对、版本与记录集 ----------------

/** 读取查询结果与数据集版本，按查询键 + 数据版本构建缓存目录，返回命中结果记录。 */
export async function buildCacheForQuery(queryCode: string): Promise<CacheHitRecord> {
  return buildQueryCache(queryCode)
}

/** 再次进入页面时按数据版本核对缓存命中；旧键迁移方式可在调用处选择。 */
export function checkQueryCache(
  queryCode: string,
  migrationMode: 'in-place' | 'new-directory' = 'in-place',
): CacheHitRecord {
  return lookupQueryCache(queryCode, migrationMode)
}

/** 数据集升版：升版后旧版本键不能再命中，必须重新构建。 */
export function upgradeDatastoreVersion(datastoreCode: string, reason?: string): DatasetVersion {
  return bumpDatastoreVersion(datastoreCode, reason)
}

export function getDatasetVersions(): DatasetVersion[] {
  return getQueryCacheEngine().listDatasetVersions()
}

/** 缓存命中结果记录集：刷新后仍可核对，下游导出入口直接读取它。 */
export function getCacheHitRecords(): CacheHitRecord[] {
  return listCacheHitRecords()
}

export function getCacheDiagnostics(): CacheDiagnostics {
  return getQueryCacheEngine().diagnostics()
}

export function downloadCacheHitCsv(): void {
  downloadCacheHitRecords()
}

/** 数据导出模块的导出入口：读取命中结果记录集，核对通过后下载，返回一致性结果。 */
export function exportCacheFromExportEntry(): ExportConsistency {
  return downloadCacheHitRecordsFromExport()
}

export function checkCacheExportConsistency(): ExportConsistency {
  return verifyCacheExportConsistency()
}

export function resetQueryCache(): ActionResult {
  resetQueryCacheEngine()
  return { ok: true, message: '查询缓存与命中结果记录集已重置（本地开发兜底）' }
}
