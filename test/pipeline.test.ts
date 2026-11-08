import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for DynamoDB / SQS / SNS so the real handlers run end to end without AWS.
const db = new Map<string, Record<string, unknown>>()
const sent: string[] = []
const pub: string[] = []
const subs: string[] = []
const flaky = { sns: false, sqs: 0, put: 0 }

// Mock at the SDK client level (not the helper module) so helpers inside backend/lib/aws.ts
// such as getInc, putInc and bump also hit the fake.
vi.hoisted(() => {
  process.env.AWS_REGION = 'ap-south-1'
  process.env.TBL = 'tbl'
})

const fake = {
  send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const key = (k: { pk: string; sk: string }) => k.pk + '|' + k.sk
    const n = cmd.constructor.name
    const i = cmd.input
    if (n === 'PutCommand') {
      if (i.Item.pk.startsWith('R#') && flaky.put > 0) {
        flaky.put--
        throw Object.assign(new Error('ddb throttled'), { name: 'ProvisionedThroughputExceededException' })
      }
      const k = key(i.Item)
      const old = db.get(k)
      const c = i.ConditionExpression as string | undefined
      if (c?.startsWith('attribute_not_exists(pk)') && old) {
        const lost = c === 'attribute_not_exists(pk)' || (old.inc as { ver: number }).ver !== i.ExpressionAttributeValues[':v']
        if (lost) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' })
      }
      db.set(k, structuredClone(i.Item))
      return {}
    }
    if (n === 'DeleteCommand') {
      db.delete(key(i.Key))
      return {}
    }
    if (n === 'GetCommand') return { Item: db.get(key(i.Key)) }
    if (n === 'UpdateCommand') {
      const k = key(i.Key)
      const row = db.get(k) ?? { ...i.Key }
      if (i.UpdateExpression.startsWith('ADD')) {
        const ref = /^ADD\s+(\S+)/.exec(i.UpdateExpression)![1]
        const f = (i.ExpressionAttributeNames?.[ref] as string | undefined) ?? ref
        row[f] = Number(row[f] ?? 0) + (Object.values(i.ExpressionAttributeValues)[0] as number)
        db.set(k, row)
        return { Attributes: { [f]: row[f] } }
      }
      db.set(k, row)
      return {}
    }
    if (n === 'QueryCommand') {
      const p = i.ExpressionAttributeValues[':p']
      const rows = [...db.values()].filter((r) => r.g1p === p).sort((x, y) => String(x.g1s).localeCompare(String(y.g1s)))
      if (i.ScanIndexForward === false) rows.reverse()
      return { Items: rows.slice(0, i.Limit ?? 50) }
    }
    if (n === 'SendMessageCommand') {
      if (flaky.sqs > 0) {
        flaky.sqs--
        throw Object.assign(new Error('sqs down'), { name: 'ServiceUnavailable' })
      }
      sent.push(i.MessageBody)
      return {}
    }
    if (n === 'PublishCommand') {
      if (flaky.sns) throw Object.assign(new Error('sns down'), { name: 'ServiceUnavailable' })
      pub.push(i.Message)
      return {}
    }
    if (n === 'SubscribeCommand') {
      subs.push(i.Endpoint)
      return {}
    }
    if (n === 'StartMessageMoveTaskCommand') return { TaskHandle: 'task-1' }
    throw new Error('unhandled ' + n)
  },
}

vi.mock('@aws-sdk/lib-dynamodb', async () => ({ ...(await vi.importActual<object>('@aws-sdk/lib-dynamodb')), DynamoDBDocumentClient: { from: () => fake } }))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async (_c: unknown, cmd: { input: { Key: string } }) => 'https://signed.test/' + cmd.input.Key }))
vi.mock('@aws-sdk/client-sqs', async () => ({ ...(await vi.importActual<object>('@aws-sdk/client-sqs')), SQSClient: class { send = fake.send } }))
vi.mock('@aws-sdk/client-sns', async () => ({ ...(await vi.importActual<object>('@aws-sdk/client-sns')), SNSClient: class { send = fake.send } }))

// Bedrock is "down": the extractor must fall back to the rule extractor.
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    send = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
    }
  },
  ConverseCommand: class {
    constructor(public input: unknown) {}
  },
}))

process.env.QURL = 'q'
process.env.TOPIC = 'arn:topic'
process.env.MODEL = 'm'

const ev = (resource: string, method: string, b?: unknown, pp?: Record<string, string>, groups: string | null = 'district_officer', extra: Record<string, string> = {}) =>
  ({
    resource,
    httpMethod: method,
    body: b === undefined ? null : JSON.stringify(b),
    pathParameters: pp ?? null,
    requestContext: { identity: { sourceIp: '1.2.3.4' }, authorizer: groups === null ? undefined : { claims: { sub: 's1', email: 'officer@example.gov.in', 'cognito:groups': groups, ...extra } } },
  }) as any

beforeEach(() => {
  db.clear()
  sent.length = 0
  pub.length = 0
  subs.length = 0
  flaky.sns = false
  flaky.sqs = 0
  flaky.put = 0
})

describe('text report -> queue -> extractor -> dispatcher API', async () => {
  const ing = (await import('../backend/ingest')).handler
  const ext = (await import('../backend/extract')).handler
  const api = (await import('../backend/api')).handler

  const drain = async () => {
    const recs = sent.splice(0).map((body, k) => ({ messageId: 'm' + k, body }))
    return ext({ Records: recs } as any)
  }

  it('accepts a report, redacts PII, and builds a ranked incident', async () => {
    const r = await ing(ev('/reports', 'POST', { text: 'सुपौल में पानी कमर तक है, 20 लोग फंसे, नाव चाहिए. call 98765 43210', sender: 'u1' }))
    expect(r.statusCode).toBe(202)
    expect(sent[0]).not.toContain('98765')
    const res = await drain()
    expect(res.batchItemFailures).toEqual([])

    const list = JSON.parse((await api(ev('/incidents', 'GET'))).body)
    expect(list.items).toHaveLength(1)
    expect(list.items[0].place).toBe('Supaul')
    expect(list.items[0].snips[0].src).toBe('rule') // Bedrock was down
    expect(list.items[0].who).toBeUndefined() // hashed sender ids are never exposed
    expect(JSON.parse((await api(ev('/stats', 'GET'))).body)).toMatchObject({ reports: 1, rule: 1, incidents: 1 })
  })

  it('rate-limits one sender but not others', async () => {
    let last = 0
    for (let k = 0; k < 32; k++) last = (await ing(ev('/reports', 'POST', { text: 'Kursela me paani aa gaya report ' + k, sender: 'spam' }))).statusCode
    expect(last).toBe(429)
    expect(sent.length).toBe(30)
    expect((await ing(ev('/reports', 'POST', { text: 'Kursela me paani aa gaya', sender: 'other' }))).statusCode).toBe(202)
  })

  it('treats an identical resend as a duplicate and counts a repeat sender once', async () => {
    const b = { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'u1' }
    expect((await ing(ev('/reports', 'POST', b))).statusCode).toBe(202)
    const dup = await ing(ev('/reports', 'POST', b))
    expect(JSON.parse(dup.body).dup).toBe(true)
    expect(sent).toHaveLength(1)
    await ing(ev('/reports', 'POST', { ...b, text: b.text + ' jaldi' })) // same person, new words
    await ing(ev('/reports', 'POST', { ...b, sender: 'u2' }))
    await drain()
    const inc = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0]
    expect(inc.n).toBe(2) // two people
    expect(inc.raw).toBe(3) // three reports
  })

  it('keeps unplaceable reports for a human instead of dropping them', async () => {
    await ing(ev('/reports', 'POST', { text: 'please help us water is rising', sender: 'u9' }))
    await drain()
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(0)
    const un = JSON.parse((await api(ev('/unplaced', 'GET'))).body).items
    expect(un).toHaveLength(1)
    expect(JSON.parse((await api(ev('/stats', 'GET'))).body).unpl).toBe(1)
  })

  it('uses a phone GPS pin over the text, and rejects pins outside Bihar', async () => {
    await ing(ev('/reports', 'POST', { text: 'paani bhar gaya hai, 5 log', sender: 'g1', lat: 25.9, lon: 86.6 }))
    await ing(ev('/reports', 'POST', { text: 'paani bhar gaya hai, 5 log', sender: 'g2', lat: 28.6, lon: 77.2 })) // Delhi: ignored
    await drain()
    const items = JSON.parse((await api(ev('/incidents', 'GET'))).body).items
    expect(items).toHaveLength(1) // the Delhi one had no usable location
  })

  it('assign lowers the score; resolve removes it from the queue', async () => {
    await ing(ev('/reports', 'POST', { text: 'Khagaria: 25 log phanse hain, paani gardan tak, boat urgently', sender: 'k1' }))
    await drain()
    const a = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0]
    const as = JSON.parse((await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF Team A' }, { id: a.id }))).body)
    expect(as.status).toBe('assigned')
    expect(as.score).toBeLessThan(a.score)
    await api(ev('/incidents/{id}/resolve', 'POST', {}, { id: a.id }))
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(0)
    // officers can still read the closed incident for after-action analysis; other roles cannot
    const all = (g: string) => api({ ...ev('/incidents', 'GET', undefined, undefined, g), queryStringParameters: { all: '1' } })
    const hist = JSON.parse((await all('district_officer')).body).items
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ status: 'resolved', by: 'control' })
    expect((await all('control_room')).statusCode).toBe(403)
    expect((await all('viewer')).statusCode).toBe(403)
  })

  // ---- failure injection: a dependency fails halfway through a request ------------------------
  it('a failed enqueue does not turn the sender\'s retry into a "duplicate" that is silently dropped', async () => {
    const b = { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'u1' }
    flaky.sqs = 1
    await expect(ing(ev('/reports', 'POST', b))).rejects.toThrow()
    expect(sent).toHaveLength(0)
    const again = await ing(ev('/reports', 'POST', b)) // the phone retries
    expect(again.statusCode).toBe(202)
    expect(JSON.parse(again.body).dup).toBeUndefined()
    expect(sent).toHaveLength(1)
    await drain()
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(1)
  })

  it('a failed report-row write also releases the dedupe claim', async () => {
    const b = { text: 'Supaul me paani badh raha hai, 4 log phanse', sender: 'u3' }
    flaky.put = 1
    await expect(ing(ev('/reports', 'POST', b))).rejects.toThrow()
    expect((await ing(ev('/reports', 'POST', b))).statusCode).toBe(202)
    expect(sent).toHaveLength(1)
  })

  it('an SNS outage after the incident is saved does not retry the message or double-count it', async () => {
    const t = 'Khagaria: 25 log phanse hain, paani gardan tak, bachche aur bujurg, naav chahiye'
    flaky.sns = true
    for (const u of ['a', 'b', 'c']) await ing(ev('/reports', 'POST', { text: t, sender: u }))
    const res = await drain()
    expect(res.batchItemFailures).toEqual([]) // nothing sent back to SQS
    const inc = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0]
    expect(inc.raw).toBe(3) // each report counted exactly once
    expect(inc.n).toBe(3)
    expect(pub).toHaveLength(0)
  })

  it('logs one JSON line per step with the report id, and never the message text or phone number', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((x: unknown) => void lines.push(String(x)))
    const warn = vi.spyOn(console, 'warn').mockImplementation((x: unknown) => void lines.push(String(x)))
    const err = vi.spyOn(console, 'error').mockImplementation((x: unknown) => void lines.push(String(x)))
    try {
      flaky.sqs = 1
      await expect(ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, call 98765 43210', sender: 'lg' }))).rejects.toThrow()
      await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, call 98765 43210', sender: 'lg' }))
    } finally {
      spy.mockRestore()
      warn.mockRestore()
      err.mockRestore()
    }
    const events = lines.filter((l) => l.startsWith('{"level"')).map((l) => JSON.parse(l))
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['enqueue_failed', 'report_accepted']))
    expect(events.every((e) => typeof e.rid === 'string' && e.rid.length > 5)).toBe(true)
    expect(lines.join('\n')).not.toMatch(/98765|Kursela/)
  })

  it('alerts the ops topic once when an incident first crosses priority 75', async () => {
    const t = 'Khagaria: 25 log phanse hain, paani gardan tak, bachche aur bujurg, naav chahiye'
    for (const u of ['a', 'b', 'c']) await ing(ev('/reports', 'POST', { text: t, sender: u }))
    await drain()
    expect(pub.filter((m) => m.includes('Khagaria')).length).toBe(1)
  })

  it('hands out a short-lived upload address for a voice note and a placeholder report', async () => {
    const r = await ing(ev('/upload-url', 'POST', { ext: 'OGG', sender: 'v1' }))
    expect(r.statusCode).toBe(201)
    const out = JSON.parse(r.body)
    expect(out.key).toMatch(/^audio\/.+\.ogg$/)
    expect(out.url).toBe('https://signed.test/' + out.key)
    expect(out.type).toMatch(/ogg/)
    expect(db.get(`R#${out.id}|M`)).toMatchObject({ st: 'wait' })
  })

  it('rate-limits voice uploads the same way as text', async () => {
    let last = 0
    for (let k = 0; k < 32; k++) last = (await ing(ev('/upload-url', 'POST', { ext: 'ogg', sender: 'vspam' }))).statusCode
    expect(last).toBe(429)
  })

  it('text outside the 3 to 1000 character range is refused', async () => {
    expect((await ing(ev('/reports', 'POST', { text: 'x'.repeat(1001), sender: 'a' }))).statusCode).toBe(400)
    expect((await ing(ev('/reports', 'POST', { text: '   ', sender: 'a' }))).statusCode).toBe(400)
    expect((await ing(ev('/reports', 'POST', { text: 42, sender: 'a' }))).statusCode).toBe(400)
    expect(sent.length).toBe(0)
  })

  it('subscribes a valid email to alerts and refuses a malformed one', async () => {
    expect((await api(ev('/subscribe', 'POST', { email: ' ops@example.gov.in ' }, undefined, null))).statusCode).toBe(202)
    expect(subs).toEqual(['ops@example.gov.in'])
    for (const email of ['nope', 'a@b', 'a b@c.in', '', 7]) expect((await api(ev('/subscribe', 'POST', { email }, undefined, null))).statusCode).toBe(400)
    expect(subs).toHaveLength(1)
  })

  it('only an officer can replay the dead-letter queue, and the replay is audited', async () => {
    expect((await api(ev('/admin/replay', 'POST', {}, undefined, 'control_room'))).statusCode).toBe(403)
    const r = await api(ev('/admin/replay', 'POST', {}, undefined, 'district_officer'))
    expect(r.statusCode).toBe(202)
    expect(JSON.parse(r.body).task).toBe('task-1')
    const log = JSON.parse((await api(ev('/audit', 'GET'))).body).items
    expect(log.some((x: { action: string }) => x.action === 'replay')).toBe(true)
  })

  it('rejects bad input', async () => {
    expect((await ing(ev('/reports', 'POST', { text: 'x' }))).statusCode).toBe(400)
    expect((await ing({ ...ev('/reports', 'POST'), body: '{bad' })).statusCode).toBe(400)
    expect((await ing(ev('/upload-url', 'POST', { ext: 'exe' }))).statusCode).toBe(400)
    expect((await api(ev('/nope', 'GET'))).statusCode).toBe(404)
  })

  it('assign needs a team name, trims a long one, and refuses an unknown incident', async () => {
    await ing(ev('/reports', 'POST', { text: 'Khagaria: 25 log phanse hain, paani gardan tak, boat urgently', sender: 'k9' }))
    await drain()
    const a = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0]
    const p = { id: a.id }
    expect((await api(ev('/incidents/{id}/assign', 'POST', {}, p))).statusCode).toBe(400)
    expect((await api(ev('/incidents/{id}/assign', 'POST', { team: '   ' }, p))).statusCode).toBe(400)
    expect((await api(ev('/incidents/{id}/assign', 'POST', { team: 12 }, p))).statusCode).toBe(400)
    const long = JSON.parse((await api(ev('/incidents/{id}/assign', 'POST', { team: 'N'.repeat(100) }, p))).body)
    expect(long.team).toHaveLength(40)
    expect((await api(ev('/incidents/{id}/assign', 'POST', { team: 'T' }, { id: 'zzzzz' }))).statusCode).toBeGreaterThanOrEqual(400)
  })

  it('enforces roles and writes an audit trail', async () => {
    await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'u1' }))
    await drain()
    const id = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0].id
    const p = { id }
    expect((await api(ev('/incidents', 'GET', undefined, undefined, null))).statusCode).toBe(401)
    expect((await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF-3' }, p, 'viewer'))).statusCode).toBe(403)
    expect((await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF-3' }, p, 'control_room'))).statusCode).toBe(200)
    expect((await api(ev('/audit', 'GET', undefined, undefined, 'control_room'))).statusCode).toBe(403)
    const au = JSON.parse((await api(ev('/audit', 'GET'))).body).items
    expect(au).toHaveLength(1)
    expect(au[0]).toMatchObject({ actor: 'officer@example.gov.in', action: 'assigned', target: id, team: 'NDRF-3' })
  })

  it('dismissed incidents leave the queue and a new independent report re-opens them', async () => {
    await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'u1' }))
    await drain()
    const id = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0].id
    expect((await api(ev('/incidents/{id}/dismiss', 'POST', {}, { id }))).statusCode).toBe(200)
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(0)
    await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, 6 log, naav chahiye abhi', sender: 'u2' }))
    await drain()
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(1)
  })

  // ---- field teams, overdue sweep, feedback and metrics --------------------------------------
  const crew = (r: string, m: string, b?: unknown, pp?: Record<string, string>, name = 'NDRF Team A') => ev(r, m, b, pp, 'field_team', { email: 'crew@example.gov.in', name })

  const seed = async () => {
    await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'u1' }))
    await drain()
    return JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0].id as string
  }

  it('field team flow: ping, see only own incident, report progress, close it', async () => {
    const id = await seed()
    expect((await api(crew('/field/ping', 'POST', { lat: 25.4, lon: 87.2 }))).statusCode).toBe(200)
    expect((await api(crew('/field/ping', 'POST', { lat: 10, lon: 10 }))).statusCode).toBe(400) // outside Bihar
    await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF Team A' }, { id }))
    const teams = JSON.parse((await api(ev('/teams', 'GET'))).body).items
    expect(teams).toEqual([expect.objectContaining({ id: 'NDRF Team A', busy: true })])

    expect(JSON.parse((await api(crew('/field/mine', 'GET'))).body).items).toHaveLength(1)
    expect(JSON.parse((await api(crew('/field/mine', 'GET', undefined, undefined, 'Other Team'))).body).items).toHaveLength(0)
    expect((await api(crew('/field/{id}/progress', 'POST', { state: 'enroute' }, { id }, 'Other Team'))).statusCode).toBe(403)
    expect((await api(crew('/field/{id}/progress', 'POST', { state: 'teleported' }, { id }))).statusCode).toBe(400)

    const en = JSON.parse((await api(crew('/field/{id}/progress', 'POST', { state: 'enroute' }, { id }))).body)
    expect(en.fstate).toBe('enroute')
    const done = JSON.parse((await api(crew('/field/{id}/progress', 'POST', { state: 'done' }, { id }))).body)
    expect(done).toMatchObject({ status: 'resolved', by: 'team' })
    const au = JSON.parse((await api(ev('/audit', 'GET'))).body).items.map((x: any) => x.action)
    expect(au).toEqual(expect.arrayContaining(['field:enroute', 'field:done', 'assigned']))
  })

  it('a team that finds nobody hands the incident back to the queue, flagged for review', async () => {
    const id = await seed()
    await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF Team A' }, { id }))
    await api(crew('/field/{id}/progress', 'POST', { state: 'nofind' }, { id }))
    const i = JSON.parse((await api(ev('/incidents', 'GET'))).body).items[0]
    expect(i).toMatchObject({ status: 'open', review: true })
    expect(i.team).toBeUndefined()
  })

  it('staff roles cannot use field routes, and field teams cannot use staff routes', async () => {
    const id = await seed()
    expect((await api(ev('/field/mine', 'GET', undefined, undefined, 'district_officer'))).statusCode).toBe(403)
    expect((await api(crew('/incidents', 'GET'))).statusCode).toBe(403)
    expect((await api(crew('/incidents/{id}/resolve', 'POST', {}, { id }))).statusCode).toBe(403)
    expect((await api(crew('/audit', 'GET'))).statusCode).toBe(403)
  })

  it('overdue sweep notifies once per level and restarts after a change', async () => {
    const id = await seed()
    const sweep = (await import('../backend/sla')).handler
    const raw = db.get('I#' + id + '|M')!
    const old = (raw.inc as any).opn ?? (raw.inc as any).first
    const realNow = Date.now
    try {
      Date.now = () => old + 20 * 60_000 // 20 min: warning only for urgent, nothing for the rest
      await sweep()
      expect(pub.filter((m) => m.startsWith('Overdue'))).toHaveLength(0)
      Date.now = () => old + 61 * 60_000
      await sweep()
      await sweep() // second sweep must not repeat
      expect(pub.filter((m) => m.startsWith('Overdue') && m.includes('no team assigned'))).toHaveLength(1)
      await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF Team A' }, { id })) // restarts the clock
      Date.now = () => old + 61 * 60_000 + 130 * 60_000
      await sweep()
      expect(pub.filter((m) => m.includes('no update'))).toHaveLength(1)
    } finally {
      Date.now = realNow
    }
  })

  it('an overdue notice that could not be sent is retried on the next sweep, not forgotten', async () => {
    const id = await seed()
    const sweep = (await import('../backend/sla')).handler
    const old = (db.get('I#' + id + '|M')!.inc as any).opn ?? (db.get('I#' + id + '|M')!.inc as any).first
    const realNow = Date.now
    try {
      Date.now = () => old + 61 * 60_000
      flaky.sns = true
      await sweep()
      expect(pub.filter((m) => m.startsWith('Overdue'))).toHaveLength(0)
      expect((db.get('I#' + id + '|M')!.inc as any).esc ?? 0).toBe(0) // not marked as announced
      flaky.sns = false
      await sweep()
      expect(pub.filter((m) => m.startsWith('Overdue'))).toHaveLength(1)
      await sweep()
      expect(pub.filter((m) => m.startsWith('Overdue'))).toHaveLength(1)
    } finally {
      Date.now = realNow
    }
  })

  it('one unreadable queue message fails alone: the others in the batch are still processed', async () => {
    await ing(ev('/reports', 'POST', { text: 'Kursela me paani chhat par, 6 log, naav chahiye', sender: 'b1' }))
    const good = sent.splice(0)[0]
    const res = await ext({ Records: [{ messageId: 'bad', body: '{not json' }, { messageId: 'ok', body: good }] } as any)
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }])
    expect(JSON.parse((await api(ev('/incidents', 'GET'))).body).items).toHaveLength(1)
  })

  it('lists gauges, and alerts with a short-lived link to the Hindi voice file when there is one', async () => {
    db.set('G#a|L', { pk: 'G#a', sk: 'L', g1p: 'GAUGE', g1s: 'a', g: { id: 'a', name: 'Hajipur' } })
    db.set('A#x|M', { pk: 'A#x', sk: 'M', g1p: 'ALERT', g1s: '000000000002', a: { id: 'x', name: 'Hajipur', en: 'e', hi: 'h' }, akey: 'alerts/x.mp3' })
    db.set('A#y|M', { pk: 'A#y', sk: 'M', g1p: 'ALERT', g1s: '000000000001', a: { id: 'y', name: 'Basua', en: 'e', hi: 'h' } })
    expect(JSON.parse((await api(ev('/gauges', 'GET'))).body).items).toEqual([{ id: 'a', name: 'Hajipur' }])
    const al = JSON.parse((await api(ev('/alerts', 'GET'))).body).items
    expect(al.map((x: { id: string }) => x.id)).toEqual(['x', 'y']) // newest first
    expect(al[0].audio).toBe('https://signed.test/alerts/x.mp3')
    expect(al[1].audio).toBeUndefined()
  })

  it('records dispatcher feedback and reports response times and agreement', async () => {
    const id = await seed()
    expect((await api(ev('/incidents/{id}/feedback', 'POST', { ok: 'yes' }, { id }))).statusCode).toBe(400)
    expect((await api(ev('/incidents/{id}/feedback', 'POST', { ok: false, wrong: ['people', 'bogus'] }, { id }, 'viewer'))).statusCode).toBe(403)
    expect((await api(ev('/incidents/{id}/feedback', 'POST', { ok: false, wrong: ['people', 'bogus'] }, { id }, 'control_room'))).statusCode).toBe(201)
    await api(ev('/incidents/{id}/assign', 'POST', { team: 'NDRF Team A' }, { id }))
    await api(ev('/incidents/{id}/resolve', 'POST', {}, { id }))
    const m = JSON.parse((await api(ev('/metrics', 'GET', undefined, undefined, 'viewer'))).body)
    expect(m).toMatchObject({ incidents: 1, resolved: 1, controlClosed: 1, fb: { n: 1, ok: 0, rate: 0, wrong: { people: 1, place: 0 } } })
    expect(m.toAssign.n).toBe(1)
    // the labelled export is for district officers only and keeps text already redacted
    expect((await api(ev('/feedback', 'GET', undefined, undefined, 'control_room'))).statusCode).toBe(403)
    const ex = JSON.parse((await api(ev('/feedback', 'GET'))).body).items
    expect(ex[0]).toMatchObject({ ok: false, wrong: ['people'] })
    expect(ex[0].texts.join(' ')).not.toMatch(/\d{10}/)
  })
})

describe('required configuration', () => {
  it('a missing table or queue setting fails loudly instead of using an empty name', async () => {
    const { TBL, need } = await import('../backend/lib/aws')
    const keep = process.env.TBL
    delete process.env.TBL
    try {
      expect(() => TBL()).toThrow(/missing required environment variable TBL/)
      expect(() => need('NOPE_NOT_SET')).toThrow(/NOPE_NOT_SET/)
    } finally {
      process.env.TBL = keep
    }
  })
})
