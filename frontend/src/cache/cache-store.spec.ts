import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_STORAGE_KEY,
  createCacheDriver,
  createMemoryDriver,
  emptyEnvelope,
} from '@/cache/cache-store'

describe('缓存持久化驱动', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('localStorage 驱动在同一存储键一次写入完整信封，保证同时可见', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    const driver = createCacheDriver()
    expect(driver.name).toBe('localStorage')
    const envelope = emptyEnvelope()
    envelope.versions['DATA-0003'] = {
      datastoreCode: 'DATA-0003',
      version: 1,
      updatedAt: '2026-11-17T08:00:00.000Z',
      updatedBy: '测试',
      reason: '首次登记',
    }
    driver.write(envelope)

    const raw = store.get(CACHE_STORAGE_KEY)!
    const parsed = JSON.parse(raw)
    expect(parsed.versions['DATA-0003'].version).toBe(1)
    expect(driver.read()?.versions['DATA-0003'].version).toBe(1)

    driver.reset()
    expect(store.has(CACHE_STORAGE_KEY)).toBe(false)
  })

  it('磁盘信封损坏时退回空信封，绝不交出半份数据', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => '{broken-json',
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    })
    const driver = createCacheDriver()
    const envelope = driver.read()!
    expect(envelope.entries).toEqual({})
    expect(envelope.hitRecords).toEqual([])
  })

  it('没有 localStorage（Node/本地兜底）时自动退回内存驱动且可持久读写', () => {
    vi.stubGlobal('window', undefined)
    const driver = createCacheDriver()
    expect(driver.name).toBe('memory')
    expect(driver.read()).toBeNull()
    const envelope = emptyEnvelope()
    envelope.hitSequence = 2
    driver.write(envelope)
    expect(driver.read()?.hitSequence).toBe(2)
  })

  it('内存驱动读写之间做深拷贝，外部改动不会污染已落盘数据', () => {
    const driver = createMemoryDriver()
    const envelope = emptyEnvelope()
    envelope.hitRecords.push({
      id: 1,
      recordNo: 'CHIT-0001',
      at: '2026-11-17T08:00:00.000Z',
      strategyCode: 'CACH-0003',
      queryCode: 'QUER-0001',
      datastoreCode: 'DATA-0003',
      cacheKey: 'k',
      directory: 'd',
      dataVersion: 1,
      hit: true,
      status: 'hit',
      failure: false,
      reason: '',
      migratedFrom: null,
      migrationMode: null,
      evictedKeys: [],
      capacity: 3,
      sizeBefore: 0,
      sizeAfter: 1,
      resultRows: 1,
    })
    driver.write(envelope)
    const first = driver.read()!
    first.hitRecords.length = 0
    const second = driver.read()!
    expect(second.hitRecords).toHaveLength(1)
  })
})
