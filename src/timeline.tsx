// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { useEffect, useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import ReactMarkdown from 'react-markdown'
import type { StatusEvent, EventUpdate } from '../shared/models'
import { statusLabels } from '../shared/models'
import { request, formatTime } from './api'
export default function Timeline({
  event,
  admin = false,
}: {
  event: StatusEvent
  admin?: boolean
}) {
  const [extra, setExtra] = useState<EventUpdate[]>([]),
    [next, setNext] = useState<string | null | undefined>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    setExtra([])
    setNext(undefined)
  }, [event.id, event.updated_at])
  const updates = [
    ...event.updates,
    ...extra.filter((u) => !event.updates.some((old) => old.id === u.id)),
  ]
  return (
    <Stack mt="lg" gap="lg">
      {updates.map((update) => (
        <div className="timeline-entry" key={update.id}>
          <Group gap="xs">
            <Text size="sm" fw={600}>
              {statusLabels[update.status]}
            </Text>
            <Text size="xs" c="dimmed">
              {formatTime(update.created_at)}
            </Text>
          </Group>
          <div className="markdown">
            <ReactMarkdown>{update.body}</ReactMarkdown>
          </div>
        </div>
      ))}
      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
      {(next === undefined ? event.moreUpdates : !!next) && (
        <Button
          variant="subtle"
          loading={loading}
          onClick={async () => {
            const last = updates.at(-1),
              cursor = next || (last ? `${last.created_at}:${last.id}` : '')
            setLoading(true)
            try {
              const result = await request(
                `/api/${admin ? 'admin/' : ''}incidents/${
                  event.id
                }/updates?cursor=${encodeURIComponent(cursor)}`
              )
              setExtra((previous) => [...previous, ...result.updates])
              setNext(result.nextCursor)
              setError('')
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setLoading(false)
            }
          }}
        >
          加载更早进展
        </Button>
      )}
    </Stack>
  )
}
