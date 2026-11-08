import { afterAll, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createReceiverApp } from '../../examples/receiver/server.js'
import { signWebhook } from '../../src/domain/signing.js'
import { createSigningSecret } from '../../src/security/crypto.js'

/**
 * The sample receiver's secret handling (examples/receiver): one startup
 * secret, additional rotation secrets, and—the compose demo's mechanism —
 * a `WEBHOOK_SECRET_FILE` re-read on every request so secrets generated
 * after start-up are accepted without a restart.
 */

const VALID_SECRET = createSigningSecret()
const OTHER_SECRET = createSigningSecret()
const TOLERANCE = 300

const receiver = createReceiverApp({
  secret: VALID_SECRET,
  toleranceSeconds: TOLERANCE,
  additionalSecrets: [OTHER_SECRET],
})

afterAll(async () => {
  delete process.env['WEBHOOK_SECRET_FILE']
})

function signedRequest(webhookId: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = signWebhook(webhookId, secret, timestamp, Buffer.from('{"n":1}'))
  return { webhookId, timestamp, signature }
}

describe('sample receiver secret handling', () => {
  afterEach(async () => {
    await request(receiver.app).post('/__reset')
  })

  it('accepts the startup secret', async () => {
    const id = 'msg_startup_secret'
    const signed = signedRequest(id, VALID_SECRET)
    const response = await request(receiver.app)
      .post('/hook')
      .set('webhook-id', signed.webhookId)
      .set('webhook-timestamp', String(signed.timestamp))
      .set('webhook-signature', signed.signature)
      .send('{"n":1}')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ received: true, duplicate: false })
  })

  it('accepts any additional secret (rotation overlap)', async () => {
    const id = 'msg_other_secret'
    const signed = signedRequest(id, OTHER_SECRET)
    const response = await request(receiver.app)
      .post('/hook')
      .set('webhook-id', signed.webhookId)
      .set('webhook-timestamp', String(signed.timestamp))
      .set('webhook-signature', signed.signature)
      .send('{"n":1}')
    expect(response.status).toBe(200)
  })

  it('accepts a secret added to WEBHOOK_SECRET_FILE after start-up', async () => {
    const fresh = createSigningSecret()
    const file = `/tmp/demo-receiver-test-${Date.now()}`
    const id = 'msg_file_secret'
    const signed = signedRequest(id, fresh)

    process.env['WEBHOOK_SECRET_FILE'] = file
    // The file does not exist, and nothing changes.
    await writeFileSafe(file, '')
    const before = await request(receiver.app)
      .post('/hook')
      .set('webhook-id', signed.webhookId)
      .set('webhook-timestamp', String(signed.timestamp))
      .set('webhook-signature', signed.signature)
      .send('{"n":1}')
    expect(before.status).toBe(401)

    // The demo initializer generates the endpoint secret AFTER the
    // receiver started: write it, and the very next delivery verifies.
    await writeFileSafe(file, `${fresh}\n`)
    const after = await request(receiver.app)
      .post('/hook')
      .set('webhook-id', signed.webhookId)
      .set('webhook-timestamp', String(signed.timestamp))
      .set('webhook-signature', signed.signature)
      .send('{"n":1}')
    expect(after.status).toBe(200)
    expect(after.body).toMatchObject({ received: true })

    // ...and stays clean for receivers of other secrets.
    await writeFileSafe(file, '')
    const another = signedRequest('msg_other_secret_2', OTHER_SECRET)
    const still = await request(receiver.app)
      .post('/hook')
      .set('webhook-id', another.webhookId)
      .set('webhook-timestamp', String(another.timestamp))
      .set('webhook-signature', another.signature)
      .send('{"n":1}')
    expect(still.status).toBe(200)
  })
})

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content)
}
