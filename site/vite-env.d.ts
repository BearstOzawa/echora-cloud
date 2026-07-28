/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ECHORA_WEB_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
