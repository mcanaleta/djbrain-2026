/// <reference types="vite/client" />

import type { DJBrainApi } from '../../shared/api'

declare global {
  interface Window {
    api: DJBrainApi
  }
}

export {}
