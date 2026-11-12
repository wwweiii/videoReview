import type { FramelensApi } from '@shared/api'

declare global {
  interface Window {
    framelens: FramelensApi
  }
}

export {}
