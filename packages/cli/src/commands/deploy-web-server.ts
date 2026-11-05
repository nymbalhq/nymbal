import { mkdirSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { defineCommand } from 'citty'
import pc from 'picocolors'
import { loadProject } from '../utils/project.js'

export type WebServer = 'nginx' | 'apache' | 'caddy'

export interface WebServerOptions {
  /** The store's public origin, NYMBAL_PUBLIC_URL: its host is the server name. */
  publicUrl: string
  /** Where the API listens, `host:port`. */
  upstream: string
  /** The CDN's addresses, trusted to name the client in `realIpHeader`. */
  realIpFrom?: string[]
  /** The header the CDN names the client in; `X-Forwarded-For` when only `realIpFrom` is given. */
  realIpHeader?: string
}

export interface WebServerRecipe {
  /** Relative to the project root. */
  file: string
  content: string
  steps: string[]
}

const FILES: Record<WebServer, string> = {
  nginx: join('deploy', 'nginx.conf'),
  apache: join('deploy', 'apache.conf'),
  caddy: join('deploy', 'Caddyfile'),
}

/** What the browser and the storefront compress; never `text/event-stream`, whose events must arrive as written. */
const COMPRESSED = [
  'application/json',
  'application/javascript',
  'text/css',
  'text/plain',
  'image/svg+xml',
]

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const API_STEP =
  "In nymbal.config.ts set http.host to '127.0.0.1', so only the web server reaches the API, and keep NYMBAL_TRUSTED_PROXIES=loopback (the default): the web server overwrites X-Forwarded-For with the address it saw"

/** The host of an http(s) origin with no path, or null. */
export function originHost(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    const plain =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    return plain ? url.hostname : null
  } catch {
    return null
  }
}

/** Why a `--real-ip-from` entry cannot be used, or null: an IP address or a CIDR, never one holding every address. */
export function realIpFromProblem(entry: string): string | null {
  const slash = entry.indexOf('/')
  const address = slash < 0 ? entry : entry.slice(0, slash)
  const family = isIP(address)
  const prefix = slash < 0 ? undefined : entry.slice(slash + 1)
  const max = family === 6 ? 128 : 32
  if (
    family === 0 ||
    (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
    Number(prefix ?? max) > max
  ) {
    return `${entry} is not an IP address or a CIDR such as 173.245.48.0/20`
  }
  if (prefix !== undefined && Number(prefix) === 0) {
    return `${entry} trusts every address to name the client, so any client could choose its own; list the CDN's published ranges`
  }
  return null
}

function nginx(host: string, upstream: string, realIpFrom: string[], realIpHeader: string): string {
  const realIp =
    realIpFrom.length === 0
      ? []
      : [
          '',
          '    # The CDN in front names the client; only these addresses may.',
          ...realIpFrom.map((range) => `    set_real_ip_from ${range};`),
          `    real_ip_header ${realIpHeader};`,
          ...(realIpHeader.toLowerCase() === 'x-forwarded-for'
            ? ['    real_ip_recursive on;']
            : []),
        ]
  return [
    `# nginx in front of the Nymbal API for ${host}, written by \`nymbal deploy nginx\`.`,
    "# The forwarded headers are overwritten with what nginx itself resolved, never appended to the client's.",
    '',
    'upstream nymbal_api {',
    `    server ${upstream};`,
    '    keepalive 16;',
    '}',
    '',
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${host};`,
    `    return 301 https://${host}$request_uri;`,
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    '    listen [::]:443 ssl;',
    `    server_name ${host};`,
    '',
    `    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;`,
    `    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;`,
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    ssl_session_cache shared:nymbal_tls:10m;',
    ...realIp,
    '',
    '    gzip on;',
    '    gzip_vary on;',
    '    gzip_proxied any;',
    `    gzip_types ${COMPRESSED.join(' ')};`,
    '',
    '    location / {',
    '        proxy_pass http://nymbal_api;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header Connection "";',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-For $remote_addr;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-Proto https;',
    '        proxy_set_header X-Forwarded-Host $host;',
    '        proxy_set_header Forwarded "";',
    '        # Streams (the admin assistant) answer X-Accel-Buffering: no, which nginx honours; they stay open.',
    '        proxy_read_timeout 300s;',
    '    }',
    '}',
    '',
  ].join('\n')
}

function apache(
  host: string,
  upstream: string,
  realIpFrom: string[],
  realIpHeader: string,
): string {
  const realIp =
    realIpFrom.length === 0
      ? []
      : [
          '',
          '    # The CDN in front names the client; only these addresses may.',
          `    RemoteIPHeader ${realIpHeader}`,
          `    RemoteIPTrustedProxy ${realIpFrom.join(' ')}`,
        ]
  return [
    `# Apache httpd in front of the Nymbal API for ${host}, written by \`nymbal deploy apache\`.`,
    "# The forwarded headers are overwritten with what Apache itself resolved, never appended to the client's.",
    '',
    '<VirtualHost *:80>',
    `    ServerName ${host}`,
    `    Redirect permanent / https://${host}/`,
    '</VirtualHost>',
    '',
    '<VirtualHost *:443>',
    `    ServerName ${host}`,
    '',
    '    SSLEngine on',
    `    SSLCertificateFile /etc/letsencrypt/live/${host}/fullchain.pem`,
    `    SSLCertificateKeyFile /etc/letsencrypt/live/${host}/privkey.pem`,
    '    SSLProtocol -all +TLSv1.2 +TLSv1.3',
    ...realIp,
    '',
    `    AddOutputFilterByType DEFLATE ${COMPRESSED.join(' ')}`,
    '',
    '    ProxyPreserveHost On',
    '    ProxyAddHeaders Off',
    '    ProxyTimeout 300',
    '    RequestHeader set X-Forwarded-For "expr=%{REMOTE_ADDR}"',
    '    RequestHeader set X-Real-IP "expr=%{REMOTE_ADDR}"',
    '    RequestHeader set X-Forwarded-Proto "https"',
    '    RequestHeader set X-Forwarded-Host "expr=%{HTTP_HOST}"',
    '    RequestHeader unset Forwarded',
    '    # flushpackets: a stream event (the admin assistant) goes out as the API writes it.',
    `    ProxyPass / http://${upstream}/ flushpackets=on`,
    `    ProxyPassReverse / http://${upstream}/`,
    '</VirtualHost>',
    '',
  ].join('\n')
}

function caddy(host: string, upstream: string, realIpFrom: string[], realIpHeader: string): string {
  const global =
    realIpFrom.length === 0
      ? []
      : [
          '{',
          '\t# The CDN in front names the client; only these addresses may.',
          '\tservers {',
          `\t\ttrusted_proxies static ${realIpFrom.join(' ')}`,
          `\t\tclient_ip_headers ${realIpHeader}`,
          "\t\t# Read the header right to left, as nginx and Apache do: its leftmost entries are the client's to write.",
          '\t\ttrusted_proxies_strict',
          '\t}',
          '}',
          '',
        ]
  return [
    `# Caddy in front of the Nymbal API for ${host}, written by \`nymbal deploy caddy\`.`,
    '# Caddy gets and renews the certificate itself. The forwarded headers are overwritten with what Caddy resolved.',
    '',
    ...global,
    `${host} {`,
    '\tencode gzip {',
    '\t\tmatch {',
    ...COMPRESSED.map((type) => `\t\t\theader Content-Type ${type}*`),
    '\t\t}',
    '\t}',
    `\treverse_proxy ${upstream} {`,
    '\t\theader_up X-Forwarded-For {client_ip}',
    '\t\theader_up X-Real-IP {client_ip}',
    '\t\theader_up X-Forwarded-Proto https',
    '\t\theader_up -Forwarded',
    '\t\t# A stream event (the admin assistant) goes out as the API writes it.',
    '\t\tflush_interval -1',
    '\t}',
    '}',
    '',
  ].join('\n')
}

function steps(server: WebServer, host: string, file: string): string[] {
  const certbot = (service: string) =>
    `sudo certbot certonly --standalone -d ${host} --pre-hook 'systemctl stop ${service}' --post-hook 'systemctl start ${service}'`
  if (server === 'nginx') {
    return [
      'sudo apt install nginx certbot',
      certbot('nginx'),
      `sudo cp ${file} /etc/nginx/sites-available/nymbal.conf && sudo ln -sf /etc/nginx/sites-available/nymbal.conf /etc/nginx/sites-enabled/nymbal.conf && sudo rm -f /etc/nginx/sites-enabled/default`,
      'sudo nginx -t && sudo systemctl reload nginx',
      API_STEP,
    ]
  }
  if (server === 'apache') {
    return [
      'sudo apt install apache2 certbot',
      'sudo a2enmod ssl proxy proxy_http headers remoteip deflate filter',
      certbot('apache2'),
      `sudo cp ${file} /etc/apache2/sites-available/nymbal.conf && sudo a2ensite nymbal && sudo a2dissite 000-default`,
      'sudo apachectl configtest && sudo systemctl reload apache2',
      API_STEP,
    ]
  }
  return [
    'Install Caddy (https://caddyserver.com/docs/install), then open ports 80 and 443: Caddy obtains the certificate',
    `sudo cp ${file} /etc/caddy/Caddyfile && sudo systemctl reload caddy`,
    API_STEP,
  ]
}

/**
 * A web server config for the store's own server: TLS for the public origin's host, port 80 redirected, the API at
 * `upstream` with X-Forwarded-For, X-Real-IP and X-Forwarded-Proto overwritten by what the server resolved, JSON and
 * text compressed, streams passed through as written, nothing cached. With `realIpFrom` the server takes the client
 * from `realIpHeader` when a listed CDN address sends it.
 */
export function webServerRecipe(server: WebServer, options: WebServerOptions): WebServerRecipe {
  const host = originHost(options.publicUrl)
  if (host === null)
    throw new Error(`${options.publicUrl} is not an http or https origin with no path`)
  const realIpFrom = options.realIpFrom ?? []
  const refused = realIpFrom.map(realIpFromProblem).find((problem) => problem !== null)
  if (refused !== undefined) throw new Error(refused)
  const realIpHeader = options.realIpHeader ?? 'X-Forwarded-For'
  if (!TOKEN.test(realIpHeader)) throw new Error(`${realIpHeader} is not an HTTP header name`)
  const render = { nginx, apache, caddy }[server]
  const file = FILES[server]
  return {
    file,
    content: render(host, options.upstream, realIpFrom, realIpHeader),
    steps: steps(server, host, file),
  }
}

function fail(message: string): never {
  process.stderr.write(`${pc.red(message)}\n`)
  process.exit(1)
}

export function webServerCommand(server: WebServer) {
  return defineCommand({
    meta: {
      name: server,
      description: `Write ${FILES[server]}: ${server} with TLS in front of the API on this machine`,
    },
    args: {
      realIpFrom: {
        type: 'string',
        alias: 'real-ip-from',
        description: "A CDN's address ranges, comma-separated, trusted to name the client",
      },
      realIpHeader: {
        type: 'string',
        alias: 'real-ip-header',
        description: 'The header that CDN names the client in, such as CF-Connecting-IP',
      },
    },
    async run({ args }) {
      const { projectRoot } = await loadProject()
      const publicUrl = process.env['NYMBAL_PUBLIC_URL']
      if (publicUrl === undefined || originHost(publicUrl) === null) {
        fail(
          "NYMBAL_PUBLIC_URL must be the store's public origin with no path, such as https://shop.example, in .env or the environment",
        )
      }
      const port = process.env['PORT']?.trim() || '3001'
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        fail(`PORT must be the API's port, a number from 1 to 65535`)
      }
      const realIpFrom = (args.realIpFrom ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      for (const entry of realIpFrom) {
        const problem = realIpFromProblem(entry)
        if (problem !== null) fail(`--real-ip-from: ${problem}`)
      }
      if (args.realIpHeader !== undefined && realIpFrom.length === 0) {
        fail('--real-ip-header needs --real-ip-from: the CDN addresses allowed to send it')
      }
      if (args.realIpHeader !== undefined && !TOKEN.test(args.realIpHeader)) {
        fail(`--real-ip-header: ${args.realIpHeader} is not an HTTP header name`)
      }
      const recipe = webServerRecipe(server, {
        publicUrl,
        upstream: `127.0.0.1:${port}`,
        ...(realIpFrom.length > 0 && { realIpFrom }),
        ...(args.realIpHeader !== undefined && { realIpHeader: args.realIpHeader }),
      })
      const path = join(projectRoot, recipe.file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, recipe.content)
      // eslint-disable-next-line no-console
      console.log(`✓ wrote ${recipe.file}`)
      // eslint-disable-next-line no-console
      console.log(`\nThe steps, on the server:\n${recipe.steps.map((s) => `  ${s}`).join('\n')}`)
    },
  })
}
