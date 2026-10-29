import { createServer, type Socket } from 'node:net'

// A minimal SMTP server in the test process, for the email contract on @nymbalhq/email-smtp without Mailpit: it
// greets, answers EHLO without STARTTLS or AUTH (so nodemailer neither upgrades nor logs in), accepts MAIL, RCPT and
// DATA, and keeps each message's data and recipients. Enough for nodemailer's verify() and sendMail(), nothing more.
// `refuseRecipients(n)` answers the next n RCPT commands with 451, a passing refusal, as a mail host under load does.

export interface FakeSmtpServer {
  port: number
  messages: string[]
  /** The envelope recipients of each message in `messages`, by the same index. */
  recipients: string[][]
  /** How many RCPT commands have been refused so far. */
  refused(): number
  /** How many connections the server has accepted so far: a client's verify() opens one. */
  connections(): number
  /** Answers the next `n` RCPT commands with `451 4.3.0`. */
  refuseRecipients(n: number): void
  close(): Promise<void>
}

/** Listens on 127.0.0.1: point the client at that address, not `localhost`, whose answer differs by resolver. */
export async function fakeSmtpServer(): Promise<FakeSmtpServer> {
  const sockets = new Set<Socket>()
  const messages: string[] = []
  const recipients: string[][] = []
  let toRefuse = 0
  let refusedSoFar = 0
  let accepted = 0
  const server = createServer((socket) => {
    accepted += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setEncoding('utf8')
    const reply = (line: string) => socket.write(`${line}\r\n`)
    let buffer = ''
    let data: string[] | null = null
    let to: string[] = []
    reply('220 contracts fake smtp ready')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'))
            recipients.push(to)
            to = []
            data = null
            reply('250 2.0.0 queued')
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line)
          }
          continue
        }
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO') {
          reply('250-contracts hello')
          reply('250 8BITMIME')
        } else if (verb === 'HELO') reply('250 contracts hello')
        else if (verb === 'RCPT') {
          if (toRefuse > 0) {
            toRefuse -= 1
            refusedSoFar += 1
            reply('451 4.3.0 try again later')
          } else {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
            reply('250 2.0.0 ok')
          }
        } else if (verb === 'MAIL' || verb === 'RSET') {
          to = []
          reply('250 2.0.0 ok')
        } else if (verb === 'NOOP') reply('250 2.0.0 ok')
        else if (verb === 'DATA') {
          data = []
          reply('354 end data with <CR><LF>.<CR><LF>')
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 bye')
          socket.end()
        } else reply('502 5.5.2 not implemented')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as { port: number }).port,
    messages,
    recipients,
    refused: () => refusedSoFar,
    connections: () => accepted,
    refuseRecipients(n) {
      toRefuse = n
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
