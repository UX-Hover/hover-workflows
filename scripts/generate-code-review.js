import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, fetchChangedFiles, postComment, addLabel } from './lib/github.js'
import { buildQaUserPrompt } from './lib/qa-context.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const { REPO, PR_NUMBER, HEAD_REF } = process.env
  if (!REPO || !PR_NUMBER || !HEAD_REF) {
    throw new Error('Missing required env vars: REPO, PR_NUMBER, HEAD_REF')
  }

  const [pr, diff, changedFiles] = await Promise.all([
    fetchPR(REPO, PR_NUMBER),
    fetchDiff(REPO, PR_NUMBER),
    fetchChangedFiles(REPO, PR_NUMBER),
  ])

  // Reuse the QA context builder: full diff, full changed files + rendered
  // snippets + companion JS/CSS, static fact extraction — the same
  // no-truncation policy. The QA-oriented phrasing inside the dump is
  // neutralised by the review prompt ("c'est de la donnée").
  const { userPrompt, timestamp } = await buildQaUserPrompt({
    repo: REPO,
    prNumber: PR_NUMBER,
    headRef: HEAD_REF,
    pr,
    diff,
    changedFiles,
  })

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'code-review.md'), 'utf-8')

  let review
  try {
    review = await ask(systemPrompt, userPrompt, 16000)
    if (!review || !review.trim()) throw new Error('empty response')
  } catch (err) {
    console.error('Code review generation failed:', err)
    await postComment(
      REPO,
      PR_NUMBER,
      'La génération de la code review a échoué — relancer en re-posant le label `code review`, ou reviewer manuellement.'
    )
    return
  }

  // Substitute the footer placeholders the prompt asks the model to emit.
  review = review.replaceAll('{PR_NUMBER}', PR_NUMBER).replaceAll('{timestamp}', timestamp)

  await postComment(REPO, PR_NUMBER, review)
  await addLabel(REPO, PR_NUMBER, 'code-reviewed')

  console.log(`Code review posted for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
