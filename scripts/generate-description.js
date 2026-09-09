import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, updatePRBody, removeLabel } from './lib/github.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The generated description lives in a marked block so a re-run replaces only
// itself. Everything the dev wrote (Ticket / Figma / Notes, the qa: preview
// block the QA bot reads) is preserved below it. A body that is entirely the
// legacy bot template (## Ce qui a changé …) is bot output and gets replaced.
const START = '<!-- hover-description:start -->'
const END = '<!-- hover-description:end -->'
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}`)
const LEGACY_RE = /^\s*## Ce qui a changé/

function devWrittenPart(body) {
  const b = (body ?? '').replace(BLOCK_RE, '').trim()
  return LEGACY_RE.test(b) ? '' : b
}

function mergeBody(body, description) {
  const block = `${START}\n${description.trim()}\n${END}`
  const dev = devWrittenPart(body)
  return dev ? `${block}\n\n${dev}` : block
}

async function main() {
  const { REPO, PR_NUMBER } = process.env
  if (!REPO || !PR_NUMBER) {
    throw new Error('Missing required env vars: REPO, PR_NUMBER')
  }

  const [pr, diff] = await Promise.all([fetchPR(REPO, PR_NUMBER), fetchDiff(REPO, PR_NUMBER)])

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'description.md'), 'utf-8')

  const userPrompt = [
    `PR title: ${pr.title}`,
    '',
    'Ce que le dev a écrit dans la PR (ticket, Figma, notes) :',
    devWrittenPart(pr.body) || '(vide)',
    '',
    'Diff:',
    '```diff',
    diff,
    '```',
  ].join('\n')

  const description = await ask(systemPrompt, userPrompt)

  await updatePRBody(REPO, PR_NUMBER, mergeBody(pr.body, description))
  await removeLabel(REPO, PR_NUMBER, 'description')

  console.log(`PR description generated for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
