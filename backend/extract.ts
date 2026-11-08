import type { SQSBatchResponse, SQSEvent } from 'aws-lambda'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { PublishCommand } from '@aws-sdk/client-sns'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { TBL, bump, ddb, emf, env, getInc, log, putInc, sns } from './lib/aws'
import type { Msg } from './ingest'
import { SYS, check, pick, prompt, rulex } from '../shared/extract'
import { merge } from '../shared/score'
import { nearest } from '../shared/gazetteer'
import { ghash, inBihar } from '../shared/geo'
import type { Rep } from '../shared/types'
import { buildIndex, findVillage, type Vil } from '../shared/villages'
import villages from '../shared/villages.json'

// Empty unless a licensed village dataset was imported (see docs/DEPLOY-INDIA.md).
const VIDX = buildIndex(villages as Vil[])

const br = new BedrockRuntimeClient({})

/** Ask the model. Any failure (throttle, timeout, bad JSON) returns null and we fall back. */
async function ask(text: string): Promise<Rep | null> {
  const t0 = Date.now()
  try {
    const out = await br.send(
      new ConverseCommand({
        modelId: env('MODEL'),
        system: [{ text: SYS }],
        messages: [{ role: 'user', content: [{ text: prompt(text) }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      }),
      { abortSignal: AbortSignal.timeout(9000) },
    )
    emf('BedrockMs', Date.now() - t0, 'Milliseconds')
    const blk = out.output?.message?.content?.find((c) => 'text' in c)
    const rep = check(pick((blk as { text?: string } | undefined)?.text ?? ''))
    if (!rep) emf('BedrockInvalid', 1)
    return rep
  } catch (err) {
    console.warn('bedrock failed, using rule extractor', (err as Error).name)
    emf('BedrockError', 1)
    return null
  }
}

/** Decide location: a phone-GPS pin beats text; text beats nothing. Returns null if unplaceable. */
function place(rep: Rep, msg: Msg, text: string): Rep | null {
  if (msg.lat !== null && msg.lon !== null && inBihar(msg.lat, msg.lon)) {
    const n = nearest(msg.lat, msg.lon)
    return { ...rep, lat: msg.lat, lon: msg.lon, place: rep.place ?? n.p.en, conf: Math.min(1, rep.conf + 0.1) }
  }
  // Village names beat the model's guess: they are finer than a district centre.
  const hint = rep.lat !== null && rep.lon !== null ? { lat: rep.lat, lon: rep.lon } : null
  const v = findVillage(text, VIDX, { near: hint })
  if (v) return { ...rep, lat: v.v[2], lon: v.v[3], place: v.v[0], conf: Math.round(rep.conf * (v.amb ? 85 : 100)) / 100 }
  if (rep.lat !== null) return rep
  const r2 = rulex(text) // the model named somewhere the gazetteer does not know; try the text itself
  if (r2.lat !== null) return { ...rep, lat: r2.lat, lon: r2.lon, place: r2.place, conf: Math.round(rep.conf * 90) / 100 }
  return null
}

async function one(m: Msg): Promise<void> {
  const llm = await ask(m.text)
  const rep0 = llm ?? rulex(m.text)
  if (!llm) {
    await bump('rule')
    emf('FallbackUsed', 1)
  }
  emf('Confidence', rep0.conf, 'None')

  const rep = place(rep0, m, m.text)
  if (!rep) {
    // Cannot put this on a map. Keep it for a human; never silently drop a cry for help.
    await ddb.send(
      new PutCommand({
        TableName: TBL(),
        Item: { pk: 'U#' + m.id, sk: 'M', g1p: 'UNPL', g1s: String(m.ts), t: m.text, ts: m.ts, ttl: Math.floor(m.ts / 1000) + 7 * 86400 },
      }),
    )
    await bump('unpl')
    emf('Unplaced', 1)
    return
  }

  // Optimistic-lock loop: two reports for the same area may land at the same time.
  for (let k = 0; k < 4; k++) {
    const old = await getInc(ghash(rep.lat as number, rep.lon as number, 5))
    const inc = merge(old, rep, m.text, m.who, Date.now())
    if (await putInc(inc)) {
      if (inc.review && !old?.review) await bump('review')
      emf('IncidentScore', inc.score, 'None')
      if (inc.score >= 75 && (old?.score ?? 0) < 75 && env('TOPIC')) {
        // The incident is already saved. A failed alert must not fail the message: the SQS retry
        // would merge the same report again and inflate its count.
        await sns
          .send(
            new PublishCommand({
              TopicArn: env('TOPIC'),
              Subject: `BaadhMitra: high-priority incident near ${inc.place}`.slice(0, 99),
              Message: `Priority ${inc.score}/100 near ${inc.place}. ${inc.n} independent reporters, up to ${inc.ppl} people at risk. Needs: ${inc.needs.join(', ') || 'unspecified'}.`,
            }),
          )
          .catch((err) => {
            emf('AlertError', 1)
            log('warn', 'alert_failed', { rid: m.id, inc: inc.id, err: (err as Error).name })
          })
      }
      return
    }
    emf('LockRetry', 1)
  }
  throw new Error('could not update incident after retries') // SQS will retry; DLQ after 3 tries
}

/** SQS consumer with partial batch response: one bad message never blocks the other four. */
export const handler = async (e: SQSEvent): Promise<SQSBatchResponse> => {
  const fail: SQSBatchResponse['batchItemFailures'] = []
  await Promise.all(
    e.Records.map(async (r) => {
      let rid: string | undefined
      try {
        const m = JSON.parse(r.body) as Msg
        rid = m.id
        await one(m)
      } catch (err) {
        log('error', 'record_failed', { rid, messageId: r.messageId, err: (err as Error).message })
        fail.push({ itemIdentifier: r.messageId })
      }
    }),
  )
  return { batchItemFailures: fail }
}
