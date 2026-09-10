import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, fetchChangedFiles, postComment, addLabel, deleteOwnComments } from './lib/github.js'
import { buildQaUserPrompt } from './lib/qa-context.js'
import { lintQaYaml } from './lib/lint-qa-yaml.js'
import { lintQaHuman } from './lib/lint-qa-human.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const promptPath = (name) => path.join(__dirname, '..', 'prompts', name)

// One label, one context, two artifacts.
//
// The bot plan and the human checklist used to be two labels and two runs that
// never saw each other, so they re-derived the same feature list independently —
// and the YAML's `regression:` block (readability, contrast, business coherence,
// doubts) is a human task list that the human checklist then duplicated, worse.
// Here the bot plan is generated first, validated, and handed to the human pass
// as "already covered": the checklist owns what a runner cannot do — the theme
// customizer, visual judgement, markets, and those regression doubts in plain
// French. The bot prompt and its user prompt are unchanged: its plan must not move.
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

  const { userPrompt, humanUserPrompt, timestamp, qaBlock, codeCorpus } = await buildQaUserPrompt({
    repo: REPO,
    prNumber: PR_NUMBER,
    headRef: HEAD_REF,
    pr,
    diff,
    changedFiles,
  })

  // ── Pass 1 — bot plan (unchanged behaviour) ────────────────────────────────
  const botSystem = await readFile(promptPath('qa-bot.md'), 'utf-8')
  let botPlan = null
  let botErrors = []
  try {
    botPlan = await ask(botSystem, userPrompt, 16000)
    if (!botPlan || !botPlan.trim()) throw new Error('empty response')

    const lintOpts = { qaBlock, codeCorpus }
    botErrors = lintQaYaml(botPlan, lintOpts).errors
    if (botErrors.length) {
      console.log(`Bot lint failed (${botErrors.length} error(s)), retrying once with feedback`)
      const retry = [
        userPrompt,
        '',
        'Your previous output failed validation. Fix every error below and output the corrected YAML block (full output, same format):',
        ...botErrors.map((e) => `- ${e}`),
        '',
        'Previous output:',
        botPlan,
      ].join('\n')
      botPlan = await ask(botSystem, retry, 16000)
      botErrors = lintQaYaml(botPlan, lintOpts).errors
    }
  } catch (err) {
    console.error('Claude bot QA generation failed:', err)
    botPlan = null
    botErrors = [`generation error: ${err.message}`]
  }

  // ── Pass 2 — human checklist, told what the runner already covers ──────────
  const humanSystem =
    (await readFile(promptPath('qa-common.md'), 'utf-8')) +
    '\n\n---\n\n' +
    (await readFile(promptPath('qa-human.md'), 'utf-8'))

  const botPlanForHuman =
    botPlan && !botErrors.length
      ? botPlan
      : '(le plan robot n\'a pas pu être généré pour cette PR — couvre toi-même le parcours principal de la feature, en plus du reste)'

  const humanPrompt = [
    'Plan de test du robot (déjà couvert automatiquement — ne le recopie pas ; traduis seulement ses doutes `regression` en langage simple) :',
    botPlanForHuman,
    '',
    '---',
    '',
    humanUserPrompt,
  ].join('\n')

  let checklist = null
  try {
    checklist = await ask(humanSystem, humanPrompt, 8000)
    if (!checklist || !checklist.trim()) throw new Error('empty response')

    let humanErrors = lintQaHuman(checklist).errors
    if (humanErrors.length) {
      console.log(`Human lint failed (${humanErrors.length} error(s)), retrying once with feedback`)
      const retry = [
        humanPrompt,
        '',
        'Ta checklist précédente ne respecte pas les règles. Corrige chaque point ci-dessous et renvoie la checklist complète :',
        ...humanErrors.map((e) => `- ${e}`),
        '',
        'Checklist précédente :',
        checklist,
      ].join('\n')
      checklist = await ask(humanSystem, retry, 8000)
      humanErrors = lintQaHuman(checklist).errors
    }
    if (humanErrors.length) {
      // Not fatal: an over-long checklist still helps a tester, unlike an invalid
      // YAML which the runner cannot execute at all. Log it and post anyway.
      console.error('Human checklist still failing lint after retry:')
      for (const e of humanErrors) console.error(`- ${e}`)
    }
  } catch (err) {
    console.error('Claude human QA generation failed:', err)
    checklist = null
  }

  // ── Publish ────────────────────────────────────────────────────────────────
  if (process.env.QA_OUT) {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(process.env.QA_OUT, { recursive: true })
    await writeFile(path.join(process.env.QA_OUT, 'bot.md'), botPlan || '(failed)')
    await writeFile(path.join(process.env.QA_OUT, 'human.md'), checklist || '(failed)')
    console.log(`QA artifacts written to ${process.env.QA_OUT}`)
  }
  if (process.env.DRY_RUN) {
    console.log('DRY_RUN set — not posting, not labelling')
    console.log(`bot lint: ${botErrors.length ? botErrors.join('; ') : 'clean'}`)
    return
  }

  // Re-labelling regenerates: drop our previous artifacts so the PR never shows
  // two plans or two checklists, one of them stale.
  const cleared = await deleteOwnComments(
    REPO,
    PR_NUMBER,
    /^:warning: Instructions QA générées mais non conformes|^```yaml\s*\nqa:|^## 👤 Checklist QA humaine/
  )
  if (cleared) console.log(`Removed ${cleared} previous QA comment(s)`)

  if (botPlan && !botErrors.length) {
    await postComment(REPO, PR_NUMBER, botPlan)
    await addLabel(REPO, PR_NUMBER, 'qa-generated')
  } else {
    await postComment(
      REPO,
      PR_NUMBER,
      [
        ':warning: Instructions QA générées mais non conformes après relance : label `qa-generated` non posé, la QA automatique ne tournera pas sur ce YAML.',
        '',
        'Erreurs de validation :',
        ...botErrors.map((e) => `- ${e}`),
        '',
        botPlan || '',
      ].join('\n')
    )
  }

  if (checklist) {
    await postComment(REPO, PR_NUMBER, checklist)
    await addLabel(REPO, PR_NUMBER, 'human-qa-generated')
  } else {
    await postComment(
      REPO,
      PR_NUMBER,
      'La génération de la checklist QA humaine a échoué — merci d’ajouter les étapes manuellement.'
    )
    await addLabel(REPO, PR_NUMBER, 'human-qa-generated')
  }

  console.log(`QA generated for ${REPO}#${PR_NUMBER} (bot: ${botPlan && !botErrors.length ? 'ok' : 'FAILED'}, human: ${checklist ? 'ok' : 'FAILED'}) at ${timestamp}`)

  if (botErrors.length) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
