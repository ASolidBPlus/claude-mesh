import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import {
  openDb,
  registerAgent,
  getAgentByToken,
  getAgentByName,
  getAgentById,
  listAgents,
  touchAgent,
  deleteAgent,
  aclGrant,
  aclRevoke,
  aclCheck,
  listGrantees,
  listGrantors,
  insertMessage,
  markDelivered,
  getPendingMessages,
  getMessage,
  expireMessages,
  getOrCreateTopic,
  listTopics,
  subscribe,
  unsubscribe,
  getTopicSubscribers,
  getAgentSubscriptions,
  getPendingTopicMessages,
} from './db'

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

// --- Agents ---

describe('agents', () => {
  test('register and retrieve by token', () => {
    const token = 'tok-abc'
    const agent = registerAgent(db, 'agent-a', hash(token), ['run-tasks'])
    expect(agent.name).toBe('agent-a')
    expect(agent.id).toBeString()

    const found = getAgentByToken(db, hash(token))
    expect(found).not.toBeNull()
    expect(found!.name).toBe('agent-a')
    expect(JSON.parse(found!.capabilities)).toEqual(['run-tasks'])
  })

  test('retrieve by name', () => {
    registerAgent(db, 'agent-b', hash('tok-b'))
    const found = getAgentByName(db, 'agent-b')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('agent-b')
  })

  test('retrieve by id', () => {
    const agent = registerAgent(db, 'agent-c', hash('tok-c'))
    const found = getAgentById(db, agent.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(agent.id)
  })

  test('returns null for unknown token', () => {
    expect(getAgentByToken(db, hash('no-such-token'))).toBeNull()
  })

  test('list agents', () => {
    registerAgent(db, 'zebra', hash('tok-z'))
    registerAgent(db, 'alpha', hash('tok-a'))
    const agents = listAgents(db)
    expect(agents.length).toBe(2)
    expect(agents[0].name).toBe('alpha') // sorted
    expect(agents[1].name).toBe('zebra')
  })

  test('touch updates last_seen', async () => {
    const agent = registerAgent(db, 'agent-d', hash('tok-d'))
    expect(agent.last_seen).toBeNull()
    const before = Date.now()
    touchAgent(db, agent.id)
    const found = getAgentById(db, agent.id)!
    expect(found.last_seen).toBeGreaterThanOrEqual(before)
  })

  test('duplicate name throws', () => {
    registerAgent(db, 'agent-e', hash('tok-e1'))
    expect(() => registerAgent(db, 'agent-e', hash('tok-e2'))).toThrow()
  })

  test('delete agent removes it', () => {
    const agent = registerAgent(db, 'agent-f', hash('tok-f'))
    deleteAgent(db, agent.id)
    expect(getAgentById(db, agent.id)).toBeNull()
  })
})

// --- ACL ---

describe('acl', () => {
  test('grant and check', () => {
    const a = registerAgent(db, 'alice', hash('tok-alice'))
    const b = registerAgent(db, 'bob', hash('tok-bob'))
    expect(aclCheck(db, a.id, b.id)).toBe(false)
    aclGrant(db, a.id, b.id) // alice allows bob to message her
    expect(aclCheck(db, a.id, b.id)).toBe(true)
  })

  test('revoke removes grant', () => {
    const a = registerAgent(db, 'alice2', hash('tok-alice2'))
    const b = registerAgent(db, 'bob2', hash('tok-bob2'))
    aclGrant(db, a.id, b.id)
    aclRevoke(db, a.id, b.id)
    expect(aclCheck(db, a.id, b.id)).toBe(false)
  })

  test('grant is idempotent', () => {
    const a = registerAgent(db, 'alice3', hash('tok-alice3'))
    const b = registerAgent(db, 'bob3', hash('tok-bob3'))
    aclGrant(db, a.id, b.id)
    expect(() => aclGrant(db, a.id, b.id)).not.toThrow()
    expect(aclCheck(db, a.id, b.id)).toBe(true)
  })

  test('listGrantees and listGrantors', () => {
    const a = registerAgent(db, 'alice4', hash('tok-alice4'))
    const b = registerAgent(db, 'bob4', hash('tok-bob4'))
    const c = registerAgent(db, 'carol4', hash('tok-carol4'))
    aclGrant(db, a.id, b.id) // b can send to a
    aclGrant(db, a.id, c.id) // c can send to a

    const grantees = listGrantees(db, a.id)
    expect(grantees).toContain(b.id)
    expect(grantees).toContain(c.id)

    const grantors = listGrantors(db, b.id)
    expect(grantors).toContain(a.id)
  })

  test('deleting agent cascades acl', () => {
    const a = registerAgent(db, 'alice5', hash('tok-alice5'))
    const b = registerAgent(db, 'bob5', hash('tok-bob5'))
    aclGrant(db, a.id, b.id)
    deleteAgent(db, a.id)
    expect(aclCheck(db, a.id, b.id)).toBe(false)
  })
})

// --- Messages ---

describe('messages', () => {
  test('insert and retrieve', () => {
    const a = registerAgent(db, 'sender', hash('tok-s'))
    const b = registerAgent(db, 'receiver', hash('tok-r'))
    const msg = insertMessage(db, a.id, b.id, null, 'hello')
    expect(msg.id).toBeString()
    expect(msg.content).toBe('hello')
    expect(msg.delivered_at).toBeNull()

    const found = getMessage(db, msg.id)
    expect(found).not.toBeNull()
    expect(found!.content).toBe('hello')
  })

  test('getPendingMessages returns undelivered', () => {
    const a = registerAgent(db, 'sender2', hash('tok-s2'))
    const b = registerAgent(db, 'receiver2', hash('tok-r2'))
    insertMessage(db, a.id, b.id, null, 'msg1')
    insertMessage(db, a.id, b.id, null, 'msg2')

    const pending = getPendingMessages(db, b.id)
    expect(pending.length).toBe(2)
  })

  test('markDelivered hides message from pending', () => {
    const a = registerAgent(db, 'sender3', hash('tok-s3'))
    const b = registerAgent(db, 'receiver3', hash('tok-r3'))
    const msg = insertMessage(db, a.id, b.id, null, 'msg-to-deliver')
    markDelivered(db, msg.id)

    const pending = getPendingMessages(db, b.id)
    expect(pending.length).toBe(0)

    const found = getMessage(db, msg.id)
    expect(found!.delivered_at).not.toBeNull()
  })

  test('expired messages excluded from pending', () => {
    const a = registerAgent(db, 'sender4', hash('tok-s4'))
    const b = registerAgent(db, 'receiver4', hash('tok-r4'))
    const expired = Date.now() - 1000 // already expired
    insertMessage(db, a.id, b.id, null, 'old msg', expired)

    const pending = getPendingMessages(db, b.id)
    expect(pending.length).toBe(0)
  })

  test('expireMessages deletes expired rows', () => {
    const a = registerAgent(db, 'sender5', hash('tok-s5'))
    const b = registerAgent(db, 'receiver5', hash('tok-r5'))
    const expired = Date.now() - 1000
    const msg = insertMessage(db, a.id, b.id, null, 'old msg', expired)
    const count = expireMessages(db)
    expect(count).toBe(1)
    expect(getMessage(db, msg.id)).toBeNull()
  })

  test('non-expired messages survive expireMessages', () => {
    const a = registerAgent(db, 'sender6', hash('tok-s6'))
    const b = registerAgent(db, 'receiver6', hash('tok-r6'))
    const future = Date.now() + 60_000
    const msg = insertMessage(db, a.id, b.id, null, 'fresh msg', future)
    expireMessages(db)
    expect(getMessage(db, msg.id)).not.toBeNull()
  })

  test('messages with null expires_at never expire', () => {
    const a = registerAgent(db, 'sender7', hash('tok-s7'))
    const b = registerAgent(db, 'receiver7', hash('tok-r7'))
    const msg = insertMessage(db, a.id, b.id, null, 'no expiry')
    expireMessages(db)
    expect(getMessage(db, msg.id)).not.toBeNull()
  })
})

// --- Topics ---

describe('topics', () => {
  test('getOrCreateTopic is idempotent', () => {
    const t1 = getOrCreateTopic(db, 'game:turns')
    const t2 = getOrCreateTopic(db, 'game:turns')
    expect(t1.id).toBe(t2.id)
  })

  test('listTopics', () => {
    getOrCreateTopic(db, 'zebra-topic')
    getOrCreateTopic(db, 'alpha-topic')
    const topics = listTopics(db)
    expect(topics.length).toBe(2)
    expect(topics[0].name).toBe('alpha-topic')
  })
})

// --- Subscriptions ---

describe('subscriptions', () => {
  test('subscribe and getTopicSubscribers', () => {
    const a = registerAgent(db, 'sub-agent-a', hash('tok-sub-a'))
    const b = registerAgent(db, 'sub-agent-b', hash('tok-sub-b'))
    const topic = getOrCreateTopic(db, 'news')
    subscribe(db, a.id, topic.id)
    subscribe(db, b.id, topic.id)

    const subs = getTopicSubscribers(db, topic.id)
    expect(subs).toContain(a.id)
    expect(subs).toContain(b.id)
  })

  test('unsubscribe removes agent', () => {
    const a = registerAgent(db, 'sub-agent-c', hash('tok-sub-c'))
    const topic = getOrCreateTopic(db, 'alerts')
    subscribe(db, a.id, topic.id)
    unsubscribe(db, a.id, topic.id)

    const subs = getTopicSubscribers(db, topic.id)
    expect(subs).not.toContain(a.id)
  })

  test('subscribe is idempotent', () => {
    const a = registerAgent(db, 'sub-agent-d', hash('tok-sub-d'))
    const topic = getOrCreateTopic(db, 'events')
    subscribe(db, a.id, topic.id)
    expect(() => subscribe(db, a.id, topic.id)).not.toThrow()
    expect(getTopicSubscribers(db, topic.id).length).toBe(1)
  })

  test('getAgentSubscriptions', () => {
    const a = registerAgent(db, 'sub-agent-e', hash('tok-sub-e'))
    const t1 = getOrCreateTopic(db, 'topic-1')
    const t2 = getOrCreateTopic(db, 'topic-2')
    subscribe(db, a.id, t1.id)
    subscribe(db, a.id, t2.id)

    const subs = getAgentSubscriptions(db, a.id)
    expect(subs.map(t => t.name).sort()).toEqual(['topic-1', 'topic-2'])
  })

  test('getPendingTopicMessages', () => {
    const sender = registerAgent(db, 'broadcaster', hash('tok-bc'))
    const sub = registerAgent(db, 'subscriber', hash('tok-sub-f'))
    const topic = getOrCreateTopic(db, 'broadcast-channel')
    subscribe(db, sub.id, topic.id)

    // Insert a topic message (to_id = null, topic = topic name)
    insertMessage(db, sender.id, null, topic.name, 'broadcast hello')

    const pending = getPendingTopicMessages(db, sub.id)
    expect(pending.length).toBe(1)
    expect(pending[0].content).toBe('broadcast hello')
  })

  test('getPendingTopicMessages excludes delivered', () => {
    const sender = registerAgent(db, 'broadcaster2', hash('tok-bc2'))
    const sub = registerAgent(db, 'subscriber2', hash('tok-sub-g'))
    const topic = getOrCreateTopic(db, 'broadcast-channel-2')
    subscribe(db, sub.id, topic.id)

    const msg = insertMessage(db, sender.id, null, topic.name, 'delivered msg')
    markDelivered(db, msg.id)

    const pending = getPendingTopicMessages(db, sub.id)
    expect(pending.length).toBe(0)
  })

  test('deleting agent cascades subscriptions', () => {
    const a = registerAgent(db, 'sub-agent-h', hash('tok-sub-h'))
    const topic = getOrCreateTopic(db, 'cascade-test')
    subscribe(db, a.id, topic.id)
    deleteAgent(db, a.id)
    expect(getTopicSubscribers(db, topic.id)).toHaveLength(0)
  })
})
