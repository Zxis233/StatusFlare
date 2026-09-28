import {
  defaultNotificationTemplates,
  type NotificationTemplates,
} from '../shared/notification-templates'

export async function loadNotificationTemplates(
  database: D1DatabaseSession
): Promise<NotificationTemplates> {
  const row = await database
    .prepare("SELECT value FROM settings WHERE key='notification_templates'")
    .first<{ value: string }>()
  return { ...defaultNotificationTemplates, ...(row ? JSON.parse(row.value) : {}) }
}
