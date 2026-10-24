import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

// The Redis server the store tests use, and a minimal RESP2 client for what the tests themselves read or clean up
// (keys under a prefix): the repository carries no Redis SDK outside the packages that peer one. A missing
// NYMBAL_TEST_REDIS_URL throws, so a suite that needs Redis fails instead of skipping.

export const REDIS_URL_VAR = 'NYMBAL_TEST_REDIS_URL'

export function redisServerUrl(): string {
  const url = process.env[REDIS_URL_VAR]
  if (url === undefined || url.trim() === '') {
    throw new Error(
      `${REDIS_URL_VAR} is not set: the store suites need a Redis server ` +
        `(docker compose up -d --wait starts one; e.g. ${REDIS_URL_VAR}=redis://localhost:63799)`,
    )
  }
  return url
}

/** A prefix no other test run has used: lower-case, digits and dashes, safe in a SCAN pattern. */
export function uniquePrefix(label: string): string {
  return `primitives-${label}-${randomUUID().slice(0, 8)}`
}

type Reply = string | number | null | Reply[] | Error

function encode(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`
}

/** One reply from `buf` at `at`: the reply and where the next starts, or undefined when more bytes are needed. */
function parse(buf: Buffer, at: number): [Reply, number] | undefined {
  const end = buf.indexOf('\r\n', at)
  if (end === -1) return undefined
  const line = buf.toString('utf8', at + 1, end)
  const next = end + 2
  switch (String.fromCharCode(buf[at]!)) {
    case '+':
      return [line, next]
    case '-':
      return [new Error(line), next]
    case ':':
      return [Number(line), next]
    case '$': {
      const len = Number(line)
      if (len === -1) return [null, next]
      if (buf.length < next + len + 2) return undefined
      return [buf.toString('utf8', next, next + len), next + len + 2]
    }
    case '*': {
      const count = Number(line)
      if (count === -1) return [null, next]
      const items: Reply[] = []
      let pos = next
      for (let i = 0; i < count; i++) {
        const item = parse(buf, pos)
        if (item === undefined) return undefined
        items.push(item[0])
        pos = item[1]
      }
      return [items, pos]
    }
    default:
      throw new Error(`unexpected RESP byte ${buf[at]} in ${buf.toString('utf8', at, at + 40)}`)
  }
}

/** Runs `commands` in order on one connection and resolves with their replies; an error reply rejects. */
export async function redis(url: string, commands: string[][]): Promise<Reply[]> {
  const u = new URL(url)
  const pre: string[][] = []
  if (u.password !== '')
    pre.push(u.username !== '' ? ['AUTH', u.username, u.password] : ['AUTH', u.password])
  const db = u.pathname.replace(/^\//, '')
  if (db !== '') pre.push(['SELECT', db])
  const all = [...pre, ...commands]
  return new Promise<Reply[]>((resolve, reject) => {
    const socket = connect({ host: u.hostname, port: Number(u.port || 6379) })
    let buf = Buffer.alloc(0)
    const replies: Reply[] = []
    socket.on('error', reject)
    socket.on('connect', () => socket.write(all.map(encode).join('')))
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      let at = 0
      for (;;) {
        const parsed = parse(buf, at)
        if (parsed === undefined) break
        replies.push(parsed[0])
        at = parsed[1]
      }
      buf = buf.subarray(at)
      if (replies.length < all.length) return
      socket.end()
      const failed = replies.find((r): r is Error => r instanceof Error)
      if (failed !== undefined) reject(failed)
      else resolve(replies.slice(pre.length))
    })
  })
}

/** Every key whose name starts with `prefix`. */
export async function keysUnder(url: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [reply] = await redis(url, [['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '1000']])
    const [next, batch] = reply as [string, string[]]
    keys.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return keys
}

/** Deletes every key under `prefix` (streams and their groups go with their keys); resolves with how many. */
export async function deleteUnder(url: string, prefix: string): Promise<number> {
  const keys = await keysUnder(url, prefix)
  if (keys.length === 0) return 0
  await redis(url, [['DEL', ...keys]])
  return keys.length
}
