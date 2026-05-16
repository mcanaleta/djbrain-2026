import { Badge } from './Badge'

export function LocationBadge({ location }: { location: 'collection' | 'downloads' }): React.JSX.Element {
  return <Badge label={location} className={location === 'downloads' ? 'bg-amber-400 text-amber-950' : 'bg-emerald-400 text-emerald-950'} />
}
