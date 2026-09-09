import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, fetchChangedFiles, postComment, addLabel, deleteOwnComments } from './lib/github.js'
import { buildQaUserPrompt } from './lib/qa-context.js'
import { ask, askWithTools } from './lib/claude.js'
import { buildRepoTools } from './lib/repo-tools.js'
import { buildReviewFacts, formatReviewFacts } from './lib/review-facts.js'

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

  // Agency context first (golden rule, operating facts), then the review method.
  const hoverContext = await readFile(path.join(__dirname, '..', 'prompts', 'hover-context.md'), 'utf-8')
  const systemPrompt = hoverContext + '\n\n---\n\n' + (await readFile(path.join(__dirname, '..', 'prompts', 'code-review.md'), 'utf-8'))

  // Deterministic pre-pass: same PR → same facts, every run. The model
  // assesses these; it does not rediscover them.
  let factsBlock = '(pré-analyse indisponible — REPO_DIR non défini)'
  if (process.env.REPO_DIR) {
    try {
      const baseRef = `origin/${process.env.BASE_REF || pr.base?.ref || 'main'}`
      factsBlock = formatReviewFacts(buildReviewFacts(process.env.REPO_DIR, baseRef))
    } catch (err) {
      console.error('review-facts failed (continuing without):', err.message)
      factsBlock = `(pré-analyse en échec : ${err.message})`
    }
  }
  const fullUserPrompt = ['## Faits pré-calculés (déterministes)', '', factsBlock, '', '---', '', userPrompt].join('\n')

  let review
  try {
    if (process.env.REPO_DIR) {
      // Agentic mode: the model can read/grep the full checked-out branch to
      // verify bindings and consumers before asserting anything.
      const repoTools = buildRepoTools(process.env.REPO_DIR)
      review = await askWithTools(systemPrompt, fullUserPrompt, repoTools, { maxTokens: 16000 })
    } else {
      console.error('REPO_DIR not set — running without repo tools (context-only review)')
      review = await ask(systemPrompt, fullUserPrompt, 16000)
    }
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

  // Gate: every numbered finding must state its Type (nouveau code | régression |
  // fichier lié | périmètre). A finding without one is the model commenting on
  // code it never linked to the feature — the golden rule, enforced.
  const gate = (text) => {
    const findings = [...text.matchAll(/^### (\d+)\. .*$\n([\s\S]*?)(?=^### |^## |\Z)/gm)]
    return findings
      .filter(([, n, body]) => !/\*\*Type\s*:\*\*\s*(nouveau code|régression|fichier lié|périmètre)/i.test(body))
      .map(([, n]) => `finding ${n} has no valid **Type :** line (nouveau code | régression | fichier lié | périmètre)`)
  }
  let violations = gate(review)
  if (violations.length) {
    console.log(`Gate: ${violations.length} violation(s), retrying once`)
    const retry = [fullUserPrompt, '', 'Ta review précédente viole le format. Corrige et renvoie la review complète :', ...violations.map((v) => `- ${v}`), '', 'Review précédente :', review].join('\n')
    review = process.env.REPO_DIR
      ? await askWithTools(systemPrompt, retry, buildRepoTools(process.env.REPO_DIR), { maxTokens: 16000 })
      : await ask(systemPrompt, retry, 16000)
    violations = gate(review)
    if (violations.length) console.error('Gate still failing after retry:', violations.join('; '))
  }

  // Substitute the footer placeholders the prompt asks the model to emit.
  review = review.replaceAll('{PR_NUMBER}', PR_NUMBER).replaceAll('{timestamp}', timestamp)

  // A re-labelled PR gets a fresh review — replace the previous one instead of
  // stacking review comments (the old one may describe hunks that no longer exist).
  const cleared = await deleteOwnComments(REPO, PR_NUMBER, /^## 🔎 Code Review —/)
  if (cleared) console.log(`Removed ${cleared} previous review comment(s)`)

  await postComment(REPO, PR_NUMBER, review)
  await addLabel(REPO, PR_NUMBER, 'code-reviewed')

  console.log(`Code review posted for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
