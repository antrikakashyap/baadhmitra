import { DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { SendMessageCommand } from '@aws-sdk/client-sqs'
import { TBL, bump, ddb, emf, log, need, rid, sha, sqs } from './aws'
import { redact } from '../../shared/redact'

/** Message that travels through SQS to the extractor. Text is already redacted. */
export interface Msg {
  id: string
  text: string
  who: string
  lat: number | null
  lon: number | null
  ts: number
}
export interface Pin {
  lat: number
  lon: number
}

const HOUR = 3600_000
export const RATE = Number(process.env.RATE_PER_HOUR ?? 30)

const isCond = (e: unknown) => (e as { name?: string }).name === 'ConditionalCheckFailedException'

/**
 * Per-sender hourly budget. A flood produces panic and repeats, so the limit is generous, but one
 * phone cannot flood the queue. Returns false when the sender is over budget.
 */
export async function allow(who: string, now = Date.now()): Promise<boolean> {
  const hr = Math.floor(now / HOUR)
  const r = await ddb.send(
    new UpdateCommand({
      TableName: TBL(),
      Key: { pk: 'RL#' + who + '#' + hr, sk: 'R' },
      UpdateExpression: 'ADD n :one SET #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': Math.floor(now / 1000) + 2 * 3600 },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  const n = Number((r as { Attributes?: { n?: number } }).Attributes?.n ?? 1)
  if (n > RATE) emf('RateLimited', 1)
  return n <= RATE
}

export type Acc = { ok: true; id: string } | { ok: false; why: 'short' | 'dup' | 'rate' }

/** Single front door for text reports (web form, WhatsApp, anything else): redact, dedupe, rate limit, enqueue. */
export async function accept(raw: string, who: string, pin: Pin | null, now = Date.now()): Promise<Acc> {
  const text = redact(raw.slice(0, 1000))
  if (text.length < 3) return { ok: false, why: 'short' }
  if (!(await allow(who, now))) return { ok: false, why: 'rate' }

  // Same sender + same words within 10 minutes is one report (phones and networks retry).
  const k = sha(who + text.toLowerCase() + Math.floor(now / 600_000))
  const id = rid()
  try {
    await ddb.send(
      new PutCommand({
        TableName: TBL(),
        Item: { pk: 'K#' + k, sk: 'K', id, ttl: Math.floor(now / 1000) + 3600 },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
  } catch (err) {
    if (isCond(err)) {
      emf('DuplicateReports', 1)
      return { ok: false, why: 'dup' }
    }
    throw err
  }

  const msg: Msg = { id, text, who, lat: pin?.lat ?? null, lon: pin?.lon ?? null, ts: now }
  try {
    await ddb.send(
      new PutCommand({ TableName: TBL(), Item: { pk: 'R#' + id, sk: 'M', who, t: text, st: 'queued', ts: now, ttl: Math.floor(now / 1000) + 7 * 86400 } }),
    )
    await sqs.send(new SendMessageCommand({ QueueUrl: need('QURL'), MessageBody: JSON.stringify(msg) }))
  } catch (err) {
    // Release the dedupe claim, otherwise the sender's retry would look like a duplicate of a
    // report that never reached the queue and be dropped. Best effort: if this also fails the
    // claim simply expires with its TTL.
    await ddb.send(new DeleteCommand({ TableName: TBL(), Key: { pk: 'K#' + k, sk: 'K' } })).catch(() => emf('DedupeReleaseError', 1))
    log('error', 'enqueue_failed', { rid: id, err: (err as Error).name })
    throw err
  }
  await bump('reports')
  emf('ReportsIn', 1)
  log('info', 'report_accepted', { rid: id })
  return { ok: true, id }
}

/** Create the placeholder for a voice note (the transcript fills it in later). Returns the report id. */
export async function voiceMeta(who: string, pin: Pin | null, now = Date.now()): Promise<string> {
  const id = rid()
  await ddb.send(
    new PutCommand({
      TableName: TBL(),
      Item: { pk: 'R#' + id, sk: 'M', who, lat: pin?.lat ?? null, lon: pin?.lon ?? null, st: 'wait', ts: now, ttl: Math.floor(now / 1000) + 7 * 86400 },
    }),
  )
  return id
}
