import { createHash } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { S3Client } from '@aws-sdk/client-s3'
import { SNSClient } from '@aws-sdk/client-sns'
import type { APIGatewayProxyResult } from 'aws-lambda'
import type { Gauge, Inc } from '../../shared/types'

export const env = (k: string, d = ''): string => process.env[k] ?? d

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
export const sqs = new SQSClient({})
export const s3 = new S3Client({})
export const sns = new SNSClient({})

/** Required setting: a missing value fails loudly at first use instead of writing to a table named "". */
export const need = (k: string): string => {
  const v = process.env[k]
  if (!v) throw new Error(`missing required environment variable ${k}`)
  return v
}

export const TBL = () => need('TBL')

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24)

/** Sortable, roughly unique id: time first, then random. */
export const rid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export const pad = (n: number, w = 3): string => String(Math.max(0, Math.round(n))).padStart(w, '0')

// ---- incidents -------------------------------------------------------------

const strip = (i: Inc): Omit<Inc, 'who'> => {
  const { who: _w, ...rest } = i
  return rest
}
export { strip }

export async function getInc(id: string): Promise<Inc | null> {
  const r = await ddb.send(new GetCommand({ TableName: TBL(), Key: { pk: 'I#' + id, sk: 'M' } }))
  return (r.Item?.inc as Inc) ?? null
}

/**
 * Write an incident with optimistic locking: succeeds only if nobody else changed it
 * since we read it. Returns false on a lost race so the caller can re-read and re-merge.
 */
export async function putInc(i: Inc): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TBL(),
        Item: { pk: 'I#' + i.id, sk: 'M', g1p: 'INC', g1s: pad(i.score) + '#' + i.id, inc: i },
        ConditionExpression: 'attribute_not_exists(pk) OR inc.ver = :v',
        ExpressionAttributeValues: { ':v': i.ver - 1 },
      }),
    )
    return true
  } catch (e) {
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false
    throw e
  }
}

export async function listInc(lim = 150): Promise<Inc[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TBL(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'g1p = :p',
      ExpressionAttributeValues: { ':p': 'INC' },
      ScanIndexForward: false,
      Limit: lim,
    }),
  )
  return (r.Items ?? []).map((x) => x.inc as Inc)
}

/** Every incident including resolved and dismissed ones (for reports and the SLA sweep), paged, capped at `max`. */
export async function allInc(max = 1000): Promise<Inc[]> {
  const out: Inc[] = []
  let key: Record<string, unknown> | undefined
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TBL(),
        IndexName: 'gsi1',
        KeyConditionExpression: 'g1p = :p',
        ExpressionAttributeValues: { ':p': 'INC' },
        ScanIndexForward: false,
        ExclusiveStartKey: key,
        Limit: 200,
      }),
    )
    for (const x of r.Items ?? []) out.push(x.inc as Inc)
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (key && out.length < max)
  return out.slice(0, max)
}

export async function listGauges(): Promise<Gauge[]> {
  const r = await ddb.send(
    new QueryCommand({ TableName: TBL(), IndexName: 'gsi1', KeyConditionExpression: 'g1p = :p', ExpressionAttributeValues: { ':p': 'GAUGE' }, Limit: 100 }),
  )
  return (r.Items ?? []).map((x) => x.g as Gauge)
}

// ---- counters --------------------------------------------------------------

export async function bump(field: 'reports' | 'rule' | 'review' | 'unpl', by = 1): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TBL(),
      Key: { pk: 'S', sk: 'G' },
      UpdateExpression: 'ADD #f :n',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':n': by },
    }),
  )
}

// ---- metrics (CloudWatch Embedded Metric Format: free to emit, no API calls) -

export function emf(name: string, value: number, unit = 'Count'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'BaadhMitra', Dimensions: [[]], Metrics: [{ Name: name, Unit: unit }] }],
      },
      [name]: value,
    }),
  )
}

// ---- structured logs ---------------------------------------------------------

/** One JSON line per event. `rid` is the report id, so every step of one report can be found with one CloudWatch query. */
export function log(level: 'info' | 'warn' | 'error', event: string, f: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...f })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// ---- http ------------------------------------------------------------------

const H = {
  'content-type': 'application/json',
  'access-control-allow-origin': env('CORS_ORIGIN', '*'),
  'cache-control': 'no-store',
}

export const ok = (b: unknown, code = 200): APIGatewayProxyResult => ({
  statusCode: code,
  headers: H,
  body: JSON.stringify(b),
})
export const bad = (m: string, code = 400): APIGatewayProxyResult => ({
  statusCode: code,
  headers: H,
  body: JSON.stringify({ error: m }),
})

export function body(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
  } catch {
    return null
  }
}
