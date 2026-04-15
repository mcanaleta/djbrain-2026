import type { ComponentType } from 'react'
import {
  ArchiveIcon,
  BookmarkIcon,
  DownloadIcon,
  EyeOpenIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
  RowsIcon,
  SewingPinIcon
} from '@radix-ui/react-icons'

export type NavItem = {
  key: string
  label: string
  path: `/${string}`
  icon: ComponentType<{ className?: string }>
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'collection', label: 'Collection', path: '/collection', icon: RowsIcon },
  { key: 'upgrades', label: 'Upgrades', path: '/upgrades', icon: ArchiveIcon },
  { key: 'wantlist', label: 'Want List', path: '/wantlist', icon: BookmarkIcon },
  {
    key: 'discogs-search',
    label: 'Discogs',
    path: '/discogs-search',
    icon: MagnifyingGlassIcon
  },
  {
    key: 'grok-search',
    label: 'Grok Search',
    path: '/grok-search',
    icon: MagnifyingGlassIcon
  },
  { key: 'soulseek', label: 'Soulseek', path: '/soulseek', icon: DownloadIcon },
  { key: 'spotify', label: 'Spotify', path: '/spotify', icon: SewingPinIcon },
  { key: 'import', label: 'Import', path: '/import', icon: MixerHorizontalIcon },
  { key: 'identify', label: 'Identify', path: '/identify', icon: EyeOpenIcon },
  { key: 'dropbox', label: 'Dropbox', path: '/dropbox', icon: ArchiveIcon }
]

export const NAV_TITLE_BY_PATH = new Map(NAV_ITEMS.map((item) => [item.path, item.label]))

export function resolveNavTitle(pathname: string): string {
  if (/^\/discogs\/(?:release|artist|label|master)\/\d+$/u.test(pathname)) {
    return 'Discogs'
  }

  if (/^\/wantlist\/\d+$/u.test(pathname)) {
    return 'Wanted Item'
  }

  if (pathname === '/import/review') {
    return 'Import Review'
  }

  if (pathname === '/identify') {
    return 'Identify'
  }

  if (/^\/upgrades\/\d+$/u.test(pathname)) {
    return 'Upgrade'
  }

  if (pathname === '/collection/item') {
    return 'Track'
  }

  return NAV_TITLE_BY_PATH.get(pathname as `/${string}`) ?? 'DJBrain'
}
