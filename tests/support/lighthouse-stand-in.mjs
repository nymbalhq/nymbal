import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

// A stand-in for the Lighthouse CLI, installed in a test project as node_modules/lighthouse/cli/index.js beside a
// package.json naming the version the test wants. It reads its plan from the JSON file NYMBAL_LIGHTHOUSE_STAND_IN
// names:
//
//   { "log": "<file>", "fixture": "<a recorded Lighthouse result>",
//     "answers": [{ "port": <n>, "path"?: "<exact>", "pathPrefix"?: "<prefix>", "answer": "hang" | { "runtimeError": { "code", "message" } } }] }
//
// Each run appends a `start` line to the log, `{ event, url, argv, pid, chromePid, at, answer, sample }`, and an `end`
// line when it exits. Like the real CLI it starts a Chrome of its own, detached (its own process group), and kills it
// on SIGINT before it exits 130. A URL no answer matches gets the fixture with values derived from the URL and how
// many times it was measured before (logged as `sample`, the metrics a reader of the result should get); `hang` never
// finishes; `runtimeError` writes the result with that error and exits 1, as Lighthouse does for a page it cannot
// load.

const planPath = process.env.NYMBAL_LIGHTHOUSE_STAND_IN
if (!planPath || !existsSync(planPath)) {
  process.stderr.write('lighthouse stand-in: NYMBAL_LIGHTHOUSE_STAND_IN names no plan file\n')
  process.exit(2)
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const argv = process.argv.slice(2)
const url = argv.find((a) => /^https?:\/\//.test(a)) ?? null

const optionValue = (name) => {
  const inline = argv.find((a) => a.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const at = argv.indexOf(name)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}
const outputPath = optionValue('--output-path')

const log = (line) => appendFileSync(plan.log, `${JSON.stringify(line)}\n`)

const chrome = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
  detached: true,
  stdio: 'ignore',
})
chrome.unref()

const finish = (code) => {
  try {
    chrome.kill('SIGKILL')
  } catch {
    // already gone
  }
  log({ event: 'end', pid: process.pid, at: Date.now(), code })
  process.exit(code)
}
process.on('SIGINT', () => finish(130))

const parsed = url === null ? null : new URL(url)
const planned = (plan.answers ?? []).find(
  (a) =>
    parsed !== null &&
    Number(parsed.port) === a.port &&
    (a.path === undefined || parsed.pathname === a.path) &&
    (a.pathPrefix === undefined || parsed.pathname.startsWith(a.pathPrefix)),
)
const answer = planned?.answer ?? 'ok'

/** How many runs this URL had before this one. */
function earlierRuns() {
  if (!existsSync(plan.log)) return 0
  return readFileSync(plan.log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === 'start' && l.url === url).length
}

/** Values of their own for this URL's nth run: what the fixture's result is rewritten with. */
function valuesFor(n) {
  const h = createHash('sha256').update(`${url}#${n}`).digest()
  const u32 = (i) => h.readUInt32BE(i * 4)
  return {
    score: (u32(0) % 101) / 100,
    lcpMs: 400 + (u32(1) % 600000) / 100,
    cls: (u32(2) % 400) / 1000,
    tbtMs: (u32(3) % 90000) / 100,
    bytes: 20000 + (u32(4) % 900000),
    serverMs: 5 + (u32(5) % 80000) / 100,
  }
}

const AUDITS = {
  lcpMs: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbtMs: 'total-blocking-time',
  bytes: 'total-byte-weight',
  serverMs: 'server-response-time',
}

const n = earlierRuns()
const values = answer === 'ok' ? valuesFor(n) : null
log({
  event: 'start',
  url,
  argv,
  pid: process.pid,
  chromePid: chrome.pid,
  at: Date.now(),
  answer: typeof answer === 'string' ? answer : 'runtimeError',
  sample:
    values === null
      ? null
      : {
          performance: Math.round(values.score * 100),
          lcpMs: values.lcpMs,
          cls: values.cls,
          tbtMs: values.tbtMs,
          bytes: values.bytes,
          serverMs: values.serverMs,
        },
})

if (answer === 'hang') {
  setInterval(() => {}, 1 << 30)
} else {
  const lhr = JSON.parse(readFileSync(plan.fixture, 'utf8'))
  lhr.requestedUrl = url
  lhr.finalDisplayedUrl = url
  if (values !== null) {
    lhr.categories.performance.score = values.score
    for (const [metric, id] of Object.entries(AUDITS)) lhr.audits[id].numericValue = values[metric]
  } else {
    lhr.runtimeError = answer.runtimeError
    lhr.categories.performance.score = null
    for (const id of Object.values(AUDITS)) delete lhr.audits[id].numericValue
  }
  if (outputPath !== null) writeFileSync(outputPath, `${JSON.stringify(lhr, null, 2)}\n`)
  if (values === null) {
    process.stderr.write(`Runtime error encountered: ${answer.runtimeError.message}\n`)
    finish(1)
  } else {
    finish(0)
  }
}
