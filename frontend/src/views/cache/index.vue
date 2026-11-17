<template>
  <section class="page" data-module="cache">
    <header class="page-head">
      <div>
        <h2>查询缓存管理</h2>
        <p class="page-desc">维护查询缓存策略，并按查询键与数据版本构建缓存目录；命中通过数据版本核对，全程写入缓存命中结果记录集。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记缓存策略</button>
        <button class="btn" type="button" @click="exportRows">导出查询缓存清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无查询缓存数据，可先登记缓存策略</td>
        </tr>
      </tbody>
    </table>

    <section class="cache-panel">
      <header class="page-head">
        <div>
          <h3>缓存目录与命中结果记录集</h3>
          <p class="page-desc">缓存键由查询键 + 数据版本派生；过期或版本不符不能命中，超容量只淘汰已完成条目，记录集刷新后仍可核对。</p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" :disabled="busy" @click="buildScenario">构建 QUER-0001 缓存</button>
          <button class="btn" type="button" :disabled="busy" @click="hitScenario">再次进入（命中核对）</button>
          <button class="btn" type="button" :disabled="busy" @click="bumpScenario">DATA-0003 升版</button>
          <button class="btn" type="button" @click="exportHitRecords">导出命中结果记录集</button>
          <button class="btn ghost" type="button" @click="resetCache">重置缓存</button>
        </div>
      </header>

      <div class="stat-row">
        <article v-for="item in diagCards" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span class="legend-item">存储驱动：{{ diagnostics.driver }}</span>
        <span v-for="version in diagnostics.datasetVersions" :key="version.datastoreCode" class="legend-item">
          {{ version.datastoreCode }}：v{{ version.version }}（{{ version.reason }}）
        </span>
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in hitColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in hitRecords" :key="record.recordNo">
            <td>{{ record.recordNo }}</td>
            <td>{{ record.at }}</td>
            <td>{{ record.strategyCode }}</td>
            <td>{{ record.queryCode }}</td>
            <td>{{ record.datastoreCode }}</td>
            <td><code>{{ record.cacheKey }}</code></td>
            <td>{{ record.directory }}</td>
            <td>{{ record.dataVersion === null ? '无版本(旧键)' : `v${record.dataVersion}` }}</td>
            <td :class="record.hit ? 'hit-yes' : 'hit-no'">{{ record.status }}</td>
            <td>{{ record.failure ? '失败' : '正常' }}</td>
            <td>{{ record.migratedFrom ?? '—' }}</td>
            <td>{{ record.evictedKeys.length ? record.evictedKeys.join('、') : '—' }}</td>
            <td>{{ record.sizeBefore }} → {{ record.sizeAfter }} / {{ record.capacity ?? '—' }}</td>
            <td>{{ record.reason }}</td>
          </tr>
          <tr v-if="!hitRecords.length">
            <td :colspan="hitColumns.length" class="empty-state">暂无缓存命中记录，先构建一次查询缓存</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条查询缓存记录，命中结果记录 {{ hitRecords.length }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  buildCacheForQuery,
  checkQueryCache,
  downloadEntries,
  downloadCacheHitCsv,
  getCacheDiagnostics,
  getCacheHitRecords,
  listEntries,
  moduleMeta,
  resetQueryCache,
  runAction as applyAction,
  upgradeDatastoreVersion,
} from '@/api/local-service'
import type { CacheDiagnostics, CacheHitRecord, EntryRow } from '@/data/types'

const meta = moduleMeta('cache')
const columns = ["策略编号", "目标查询", "缓存键规则", "过期秒数", "刷新触发", "命中率阈值", "最大条目数", "淘汰算法"]
const actions = ["提交校验", "启用缓存", "停用缓存"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "缓存策略总数", "value": 0}, {"label": "已启用策略", "value": 0}, {"label": "待校验策略", "value": 0}]
const hitColumns = [
  "记录编号", "记录时间", "策略编号", "语句编号", "数据集编号", "缓存键", "缓存目录",
  "数据版本", "命中状态", "核对结果", "迁移来源", "淘汰缓存键", "容量淘汰", "说明",
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const busy = ref(false)
const hitRecords = ref<CacheHitRecord[]>([])
const diagnostics = ref<CacheDiagnostics>({
  driver: 'memory',
  strategyCount: 0,
  entryCount: 0,
  completeEntries: 0,
  buildingEntries: 0,
  evictedEntries: 0,
  legacyEntries: 0,
  versionedEntries: 0,
  activeReaders: 0,
  hitRecords: 0,
  hits: 0,
  misses: 0,
  failures: 0,
  hitRate: 0,
  datasetVersions: [],
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const diagCards = computed(() => [
  { label: '缓存条目（含留痕）', value: diagnostics.value.entryCount },
  { label: '完整可命中', value: diagnostics.value.completeEntries },
  { label: '已淘汰留痕', value: diagnostics.value.evictedEntries },
  { label: '版本化 / 旧键', value: `${diagnostics.value.versionedEntries} / ${diagnostics.value.legacyEntries}` },
  { label: '命中 / 未命中', value: `${diagnostics.value.hits} / ${diagnostics.value.misses}` },
  { label: '命中率', value: `${Math.round(diagnostics.value.hitRate * 100)}%` },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportHitRecords() {
  downloadCacheHitCsv()
}

function openCreate() {
  errorMessage.value = '缓存策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

async function buildScenario() {
  errorMessage.value = ''
  busy.value = true
  try {
    await buildCacheForQuery('QUER-0001')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '缓存构建失败'
  } finally {
    busy.value = false
    reloadCachePanel()
  }
}

function hitScenario() {
  errorMessage.value = ''
  try {
    checkQueryCache('QUER-0001')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '缓存命中核对失败'
  }
  reloadCachePanel()
}

function bumpScenario() {
  errorMessage.value = ''
  try {
    upgradeDatastoreVersion('DATA-0003', '手动升版：旧版本缓存键失效')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据集升版失败'
  }
  reloadCachePanel()
}

function resetCache() {
  errorMessage.value = ''
  resetQueryCache()
  reloadCachePanel()
}

function reloadCachePanel() {
  hitRecords.value = getCacheHitRecords()
  diagnostics.value = getCacheDiagnostics()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadCachePanel()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '查询缓存列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.cache-panel {
  margin-top: 24px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.cache-panel h3 {
  margin: 0;
  font-size: 16px;
}
.hit-yes {
  color: #067647;
  font-weight: 600;
}
.hit-no {
  color: #b54708;
  font-weight: 600;
}
code {
  font-size: 12px;
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 4px;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
