import type { CacheEntry, CacheHitRecord, DatasetVersion } from '@/data/types'

/**
 * 查询缓存的本地持久化驱动。
 *
 * 与业务清单（data-explore-studio:entries）分开存放，避免半份缓存污染业务数据。
 * 所有状态（数据版本台账 + 缓存目录 + 命中结果记录集 + 序列号）放进同一个信封，
 * 一次 setItem 落盘：缓存写入与数据集版本在同一次写入里同时可见，刷新后依旧可核对。
 * localStorage 不可用（Node 测试、隐私模式、本地兜底）时退回到内存驱动。
 */

export const CACHE_STORAGE_KEY = 'data-explore-studio:query-cache'

export type CacheEnvelope = {
  schemaVersion: number
  versions: Record<string, DatasetVersion>
  entries: Record<string, CacheEntry>
  hitRecords: CacheHitRecord[]
  hitSequence: number
}

export type CacheDriver = {
  readonly name: 'localStorage' | 'memory'
  read(): CacheEnvelope | null
  write(envelope: CacheEnvelope): void
  reset(): void
}

export function emptyEnvelope(): CacheEnvelope {
  return { schemaVersion: 1, versions: {}, entries: {}, hitRecords: [], hitSequence: 0 }
}

function createLocalStorageDriver(): CacheDriver {
  return {
    name: 'localStorage',
    read() {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null
      }
      const raw = window.localStorage.getItem(CACHE_STORAGE_KEY)
      if (!raw) {
        return null
      }
      try {
        const parsed = JSON.parse(raw) as CacheEnvelope
        return normalizeEnvelope(parsed)
      } catch {
        // 磁盘上的信封损坏时退回空信封，绝不把半份数据交出去。
        return emptyEnvelope()
      }
    },
    write(envelope) {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(envelope))
    },
    reset() {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(CACHE_STORAGE_KEY)
      }
    },
  }
}

function createMemoryDriverInternal(): CacheDriver {
  let holder: CacheEnvelope | null = null
  return {
    name: 'memory',
    read() {
      return holder ? normalizeEnvelope(structuredCloneSafe(holder)) : null
    },
    write(envelope) {
      holder = structuredCloneSafe(envelope)
    },
    reset() {
      holder = null
    },
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeEnvelope(parsed: Partial<CacheEnvelope>): CacheEnvelope {
  const base = emptyEnvelope()
  return {
    schemaVersion: parsed.schemaVersion ?? base.schemaVersion,
    versions: parsed.versions ?? {},
    entries: parsed.entries ?? {},
    hitRecords: Array.isArray(parsed.hitRecords) ? parsed.hitRecords : [],
    hitSequence: typeof parsed.hitSequence === 'number' ? parsed.hitSequence : 0,
  }
}

/**
 * 允许测试替换驱动；默认优先 localStorage，缺失时用内存兜底（本地开发兜底）。
 * 部署流水线可通过 VITE_CACHE_DRIVER=memory 显式选择内存驱动做无头环境验证。
 */
export function createCacheDriver(): CacheDriver {
  const forced: string | undefined =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_CACHE_DRIVER : undefined
  if (forced === 'memory') {
    return createMemoryDriverInternal()
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    return createLocalStorageDriver()
  }
  return createMemoryDriverInternal()
}

/** 测试与本地兜底显式使用的内存驱动；刷新持久化测试可让多个引擎共用同一个驱动。 */
export function createMemoryDriver(): CacheDriver {
  return createMemoryDriverInternal()
}
