// src/utils/storage.ts
import { MinMax } from '../types'
import { MINMAX_CACHE_KEY } from '../constants'

export function loadCachedMinMax(): MinMax {
  try {
    const r = localStorage.getItem(MINMAX_CACHE_KEY)
    return r ? JSON.parse(r) : {}
  } catch {
    return {}
  }
}

export function saveCachedMinMax(data: MinMax) {
  try {
    localStorage.setItem(MINMAX_CACHE_KEY, JSON.stringify(data))
  } catch {
    // Silent fail
  }
}
