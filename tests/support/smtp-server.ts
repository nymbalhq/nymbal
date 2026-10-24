import { createServer, type Socket } from 'node:net'

// A minimal SMTP server in the test process, for the email contract on @nymbalhq/adapter-smtp without Mailpit: it
// greets, answers EHLO without STARTTLS or AUTH (so nodemailer neither upgrades nor logs in), accepts MAIL, RCPT and
// DATA, and keeps each message's data. Enough for nodemailer's verify() and sendMail(), nothing more.

export interface FakeSmtpServer {
  port: number
  messages: string[]
  close(): Promise<void>
}

export async function fakeSmtpServer(): Promise<FakeSmtpServer> {
  const sockets = new Set<Socket>()
  const messages: string[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setEncoding('utf8')
    const reply = (line: string) => socket.write(`${line}\r\n`)
    let buffer = ''
    let data: string[] | null = null
    reply('220 contracts fake smtp ready')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'))
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
        else if (['MAIL', 'RCPT', 'RSET', 'NOOP'].includes(verb)) reply('250 2.0.0 ok')
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    port: (server.address() as { port: number }).port,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
