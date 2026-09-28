import type { CSSProperties } from 'react'

const paths: Record<string, string> = {
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  monitors: 'M3 12h4l3-8 4 16 3-8h4',
  components: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  groups: 'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3',
  events: 'M5 3h14v18H5z M9 8h6 M9 12h6 M9 16h4',
  channels: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  activity: 'M4 19V9 M10 19V4 M16 19v-7 M22 19H2',
  plus: 'M12 5v14 M5 12h14',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  refresh: 'M20 7V3l-4 4 M20 7a8 8 0 1 0 0 10',
  arrow: 'M7 17 17 7 M7 7h10v10',
}

export default function AdminIcon({
  name,
  size = 20,
  style,
}: {
  name: string
  size?: number
  style?: CSSProperties
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={paths[name] || paths.components} />
    </svg>
  )
}
