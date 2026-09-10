import { DIFF_REFERENTIAL_RE } from './lint-qa-yaml.js'

// The human checklist had no gate at all: ask() → post. Everything the prompt
// asked for was advisory, so the model padded (rez-energy#39: 1781 words, 28
// template lines for a feature that lives on one product). These are the rules
// that are cheap to check mechanically — the ones that were actually broken.

const REQUIRED_HEADINGS = ['## 👤 Checklist QA humaine', "### Ce qu'on teste", '### Parcours à faire']

// Words the tester does not know. Each entry is [label, regex].
const TECHNICAL = [
  ['un code de template `?view=`', /\?view=/i],
  ['un nom de fichier', /\b[\w-]+\.(?:liquid|scss|css|js|json)\b/i],
  ['le mot « snippet »', /\bsnippets?\b/i],
  ['le mot « métachamp » / « metafield »', /\bm[ée]tachamps?\b|\bmetafields?\b|\bmetaobjects?\b/i],
  ['un attribut data-', /\bdata-[a-z][\w-]*/i],
  ['de la syntaxe Liquid', /\{\{|\{%/],
  ['une balise HTML', /<\/?(?:div|span|button|section|ul|li|img|a)\b/i],
  ['le mot « schema » / « sélecteur »', /\bschemas?\b|\bs[ée]lecteurs?\b/i],
  ['une instruction console JS', /\bconsole\.|querySelector|customElements/i],
  ['une classe CSS', /(?:^|[\s(`])[.#][a-zA-Z][\w-]{2,}__[\w-]+/],
  ['un fichier de réglages', /settings_data|settings_schema/i],
]

// The developer hands over the preview link. Explaining how to preview a theme
// is filler that appeared in every checklist.
const PREVIEW_EXPLAINER =
  /pr[ée]visualis|th[èe]me de pr[ée]view|Boutique en ligne\s*(?:→|->|>)\s*Th[èe]mes|\[boutique\]\.com/i

const MAX_WORDS = 900
const MAX_JOURNEYS = 6
const MAX_TEMPLATE_LINES = 2

export function lintQaHuman(markdown) {
  const errors = []
  const text = (markdown || '').trim()
  if (!text) return { errors: ['empty checklist'] }

  for (const h of REQUIRED_HEADINGS) {
    if (!text.includes(h)) errors.push(`missing required heading: ${h}`)
  }

  if (!/^>\s*Checklist QA g[ée]n[ée]r[ée]e par Hover/m.test(text)) {
    errors.push('missing the footer line `> Checklist QA générée par Hover · PR #… · …`')
  }

  const words = text.split(/\s+/).filter(Boolean).length
  if (words > MAX_WORDS) {
    errors.push(`checklist is ${words} words — hard cap is ${MAX_WORDS} (target 700). Cut the generic journeys, keep what this PR actually changes`)
  }

  // Body only: the fenced example inside a quoted PR body is not our text.
  const body = text.replace(/```[\s\S]*?```/g, '')

  for (const [label, re] of TECHNICAL) {
    const m = body.match(re)
    if (m) errors.push(`the tester cannot read ${label} — found ${JSON.stringify(m[0].trim().slice(0, 40))}; describe its visible effect instead`)
  }

  const preview = body.match(PREVIEW_EXPLAINER)
  if (preview) {
    errors.push(`drop the preview explainer (${JSON.stringify(preview[0].slice(0, 40))}) — the developer sends the preview link; only reuse URLs from the PR's qa block`)
  }

  // The rez-energy#39 failure mode: a section that 28 templates include becomes
  // 28 lines of "Template produit — code : x".
  const templateLines = (body.match(/^\s*[-*]?\s*\**Template\s+(?:produit|collection|accueil|page|article)/gim) || []).length
  if (templateLines > MAX_TEMPLATE_LINES) {
    errors.push(`${templateLines} template lines listed — the template list is a scope signal, not a test list. Name at most ${MAX_TEMPLATE_LINES} pages, in plain words`)
  }

  const journeys = (body.match(/^\s*(?:\*\*|###\s*)\d+[.)]/gm) || []).length
  if (journeys > MAX_JOURNEYS) {
    errors.push(`${journeys} journeys — cap is ${MAX_JOURNEYS}. Drop the ones not grounded in this PR's diff`)
  }

  for (const line of body.split('\n')) {
    if (DIFF_REFERENTIAL_RE.test(line)) {
      errors.push(`describes the change instead of the expected result: ${JSON.stringify(line.trim().slice(0, 90))} — say what a correct page shows`)
      break
    }
  }

  return { errors }
}
