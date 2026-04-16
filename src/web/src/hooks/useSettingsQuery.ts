import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export const SETTINGS_QUERY_KEY = ['settings'] as const

export function useSettingsQuery() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: api.settings.get
  })
}
