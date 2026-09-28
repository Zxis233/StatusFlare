// StatusFlare: extracted and adapted from the UptimeFlare full-stack derivative; see NOTICE.
import { z } from 'zod'
import { assertPublicTarget, idSchema, text } from './core'
import { POLICY } from '../shared/policy'
import {
  notificationTemplateError,
  isNotificationTimeZone,
  type NotificationTemplateKind,
} from '../shared/notification-templates'
const flag = z.union([z.literal(0), z.literal(1)])
const version = z.number().int().min(1).optional()
const publicLinkSchema = z
  .string()
  .trim()
  .max(2000)
  .default('')
  .superRefine((value, ctx) => {
    if (!value) return
    try {
      assertPublicTarget(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: '公开访问链接必须为公开 HTTP/HTTPS 地址' })
    }
  })
export const groupSchema = z.object({
  id: idSchema.optional(),
  name: text(),
  position: z.number().int().min(0).max(10000).default(0),
  version,
})
export const componentSchema = z.object({
  id: idSchema.optional(),
  name: text(),
  description: z.string().max(2000).default(''),
  group_id: idSchema.nullable().default(null),
  public: flag.default(1),
  position: z.number().int().min(0).max(10000).default(0),
  link: publicLinkSchema,
  version,
})
export const probeSchema = z
  .object({
    target: text(2000),
    method: z
      .enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TCP_PING'])
      .default('GET'),
    timeout: z.number().int().min(1000).max(30000).default(10000),
    headers: z.record(z.string().max(4000)).default({}),
    body: z.string().max(16000).default(''),
    expectedCodes: z.array(z.number().int().min(100).max(599)).max(30).default([]),
    responseKeyword: z.string().max(1000).default(''),
    responseForbiddenKeyword: z.string().max(1000).default(''),
    region: z
      .enum(['', 'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'])
      .default(''),
    fallback: z.boolean().default(false),
  })
  .superRefine((v, c) => {
    try {
      assertPublicTarget(v.target, v.method === 'TCP_PING')
    } catch (e) {
      c.addIssue({ code: 'custom', message: (e as Error).message })
    }
    if (['GET', 'HEAD'].includes(v.method) && v.body)
      c.addIssue({ code: 'custom', message: 'GET/HEAD 不支持请求体' })
    if (v.method === 'HEAD' && (v.responseKeyword || v.responseForbiddenKeyword))
      c.addIssue({ code: 'custom', message: 'HEAD 无响应正文，不能检查关键词' })
    if (Object.keys(v.headers).length > 30) c.addIssue({ code: 'custom', message: '请求头过多' })
    try {
      new Headers(v.headers)
    } catch {
      c.addIssue({ code: 'custom', message: '请求头格式错误' })
    }
  })
export const monitorSchema = z.object({
  id: idSchema.optional(),
  name: text(),
  link: publicLinkSchema,
  component_id: idSchema,
  position: z.number().int().min(0).max(2147483647).default(0),
  enabled: flag.default(1),
  interval: z.number().int().min(POLICY.minimumInterval).max(86400).default(POLICY.defaultInterval),
  grace: z.number().int().min(0).max(86400).default(180),
  notify: flag.default(1),
  config: probeSchema,
  version,
})
export const eventSchema = z
  .object({
    id: idSchema.optional(),
    kind: z.enum(['incident', 'maintenance']),
    title: text(),
    status: z.enum([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
      'scheduled',
      'in_progress',
      'completed',
      'cancelled',
    ]),
    severity: z.enum(['minor', 'major', 'critical']).default('minor'),
    start_at: z.number().int().min(0),
    end_at: z.number().int().min(0).nullable().default(null),
    published: flag.default(0),
    components: z.array(idSchema).min(1).max(100),
    notificationChannels: z.array(idSchema).max(POLICY.maxChannels).default([]),
    body: z.string().trim().max(20000).default(''),
    attachments: z.array(idSchema).max(10).default([]),
    version,
  })
  .superRefine((v, c) => {
    const valid =
      v.kind === 'incident'
        ? ['investigating', 'identified', 'monitoring', 'resolved']
        : ['scheduled', 'in_progress', 'completed', 'cancelled']
    if (!valid.includes(v.status)) c.addIssue({ code: 'custom', message: '事件类型与状态不匹配' })
    if (v.end_at !== null && v.end_at < v.start_at)
      c.addIssue({ code: 'custom', message: '结束时间不能早于开始时间' })
    if (['resolved', 'completed'].includes(v.status) && v.end_at === null)
      c.addIssue({ code: 'custom', message: '结束事件需要填写结束时间' })
    if (!v.version && !v.body) c.addIssue({ code: 'custom', message: '请填写事件说明' })
  })
export const channelConfigSchema = z
  .object({
    url: text(2000),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).optional(),
    headers: z.record(z.string().max(4000)).default({}),
    payloadType: z.enum(['param', 'json', 'x-www-form-urlencoded']).default('json'),
    payload: z.record(z.unknown()).default({ text: '$MSG' }),
    timeout: z.number().int().min(1000).max(15000).default(10000),
  })
  .superRefine((v, c) => {
    try {
      const u = assertPublicTarget(v.url)
      if (u.protocol !== 'https:') throw new Error()
    } catch {
      c.addIssue({ code: 'custom', message: 'Webhook 必须使用公开 HTTPS 地址' })
    }
    if (v.method === 'GET' && v.payloadType !== 'param')
      c.addIssue({ code: 'custom', message: 'GET Webhook 需要 param 编码' })
    if (JSON.stringify(v.payload).length > 20000)
      c.addIssue({ code: 'custom', message: 'Webhook payload 过大' })
  })
export const channelSchema = z.object({
  name: text(),
  enabled: flag.default(1),
  config: channelConfigSchema.optional(),
  version,
})
export type ChannelConfig = z.infer<typeof channelConfigSchema>
const notificationTemplateSchema = (kind: NotificationTemplateKind) =>
  z.string().superRefine((value, ctx) => {
    const message = notificationTemplateError(kind, value)
    if (message) ctx.addIssue({ code: 'custom', message })
  })
export const notificationTemplatesSchema = z
  .object({
    timeZone: z
      .string()
      .trim()
      .refine(isNotificationTimeZone, '请输入有效时区，例如 Asia/Shanghai 或 UTC')
      .default('UTC'),
    down: notificationTemplateSchema('down'),
    recovery: notificationTemplateSchema('recovery'),
    event: notificationTemplateSchema('event'),
  })
  .strict()
export const settingsSchema = z.object({
  title: text(),
  description: z.string().max(2000).default(''),
  backgroundImageUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      if (!value) return true
      try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password
      } catch {
        return false
      }
    }, '请输入 HTTPS 图片地址，或留空')
    .default(''),
  backgroundDim: z.number().min(0).max(1).default(0.6),
})
