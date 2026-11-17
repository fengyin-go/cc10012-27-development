/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_APP_NAME?: string
  /** 缓存驱动：auto（浏览器 localStorage，缺失时内存兜底，默认）或 memory（强制本地内存兜底）。 */
  readonly VITE_CACHE_DRIVER?: 'auto' | 'memory'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
