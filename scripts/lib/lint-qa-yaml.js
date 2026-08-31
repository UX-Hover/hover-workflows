import { parse } from 'yaml'

const DEVICES = new Set(['desktop', 'mobile', 'both'])

// Wording that describes the diff instead of the expected user-facing result.
// Its presence proves the assertion was copied from the changed code rather than
// derived from intent — the artifact then passes on broken code and fails once fixed.
const DIFF_REFERENTIAL_RE = new RegExp(
  [
    'nouvelle?\\s+classe',
    'dans\\s+le\\s+diff',
    'renomm(?:é|ee|ée)s?\\s+depuis',
    'r(?:é|e)gressions?\\s+(?:depuis|visuelles?|intentionnelles?|volontaires?)',
    '(?:volontaire|intentionnel)(?:le)?s?\\b',
    'hardcod(?:é|ee|ée)s?\\b',
    '(?:modifi|ajout|appliqu|introduit)(?:é|ee|ée)s?\\s+(?:dans|par)\\s+(?:cette\\s+|la\\s+)?PR',
    'valeurs?\\s+(?:actuelles?|du\\s+diff)',
  ].join('|'),
  'i'
)

// Conditional steps are what needs/needs_absent routing exists to replace.
const CONDITIONAL_RE = /\bsi\s+le\s+produit\b|\bsinon\b|\bselon\s+(?:le|la|les)\b/i

// A browser cannot judge these.
const SUBJECTIVE_RE = /\bcorrectement\b|\blisible\b|\bbon\s+contraste\b|\bharmonieu/i

// Steps are natural-language prose — the runner translates to selectors itself.
// A selector inside a step means the generator leaked implementation details.
const SELECTOR_IN_STEP_RE = /querySelector|data-[a-z][\w-]*=|(^|[\s(])[.#][a-zA-Z][\w-]{2,}__[\w-]+/

const ABSENCE_RE =
  /\baucune?\b.*\b(?:affich|visible|présent)|\bne\s+(?:s'affiche|doit|doivent)\s+(?:pas|plus)\b|\bdispara/i

// Strip CSS decoration so a `needs` value can be checked against the raw code:
// `.hover-faq` -> hover-faq, `[data-pack-root]` -> data-pack-root.
function selectorCore(selector) {
  return selector.trim().replace(/^[.#[]/, '').replace(/[\]]$/, '').replace(/=.*$/, '')
}

export function lintQaYaml(markdown, { qaBlock = null, codeCorpus = '' } = {}) {
  const fence = markdown.match(/```ya?ml\n([\s\S]*?)```/)
  if (!fence) return { errors: ['no fenced YAML block found in the output'] }

  // The contract is "only the YAML block and the footer". Prose before the fence
  // is usually the model narrating its retry loop, and it ships to the PR comment.
  const preamble = markdown.slice(0, markdown.indexOf(fence[0])).trim()
  if (preamble.length > 0) {
    return {
      errors: [
        `output starts with ${preamble.length} chars of prose before the YAML fence — emit ONLY the fenced YAML block and the footer (offending start: "${preamble.slice(0, 80)}…")`,
      ],
    }
  }

  let doc
  try {
    doc = parse(fence[1])
  } catch (err) {
    return { errors: [`YAML parse error: ${err.message}`] }
  }
  if (!doc || typeof doc !== 'object') return { errors: ['empty YAML document'] }

  const errors = []

  // --- qa block: re-emitted verbatim from the PR body, never invented ---------
  if (!doc.qa || typeof doc.qa !== 'object') {
    errors.push('missing top-level `qa:` block (preview_theme_id + urls)')
  } else {
    const urls = doc.qa.urls
    if (!Array.isArray(urls)) {
      errors.push('`qa.urls` must be a list (empty list allowed when the dev has not provided preview URLs yet)')
    } else if (qaBlock) {
      const provided = new Set((qaBlock.urls ?? []).map(String))
      for (const u of urls) {
        if (!provided.has(String(u))) {
          errors.push(
            `qa.urls contains "${u}" which was NOT in the developer-provided qa block — re-emit the provided URLs verbatim, never invent one`
          )
        }
      }
      for (const u of provided) {
        if (!urls.map(String).includes(u)) {
          errors.push(`qa.urls is missing "${u}" from the developer-provided qa block — re-emit ALL provided URLs`)
        }
      }
      if (
        qaBlock.preview_theme_id != null &&
        String(doc.qa.preview_theme_id ?? '') !== String(qaBlock.preview_theme_id)
      ) {
        errors.push(
          `qa.preview_theme_id must be "${qaBlock.preview_theme_id}" as provided (got "${doc.qa.preview_theme_id}")`
        )
      }
    } else if (Array.isArray(urls) && urls.length > 0) {
      errors.push(
        'no qa block was provided by the developer, yet qa.urls is non-empty — you invented URLs; emit `urls: []` and let the dev fill them'
      )
    }
  }

  // --- features ---------------------------------------------------------------
  if (!Array.isArray(doc.features) || doc.features.length === 0) {
    errors.push('YAML has no `features` list')
    return { errors }
  }

  doc.features.forEach((f, i) => {
    const at = `features[${i}] ("${f?.name ?? 'sans nom'}")`
    if (!f || typeof f !== 'object') {
      errors.push(`${at}: must be a mapping`)
      return
    }
    if (!f.name || typeof f.name !== 'string') errors.push(`${at}: missing \`name\``)
    if (![1, 2, 3].includes(f.priority)) {
      errors.push(`${at}: \`priority\` must be 1, 2 or 3 (got ${JSON.stringify(f.priority)})`)
    }
    if (!DEVICES.has(f.device)) {
      errors.push(`${at}: \`device\` must be desktop, mobile or both (got ${JSON.stringify(f.device)})`)
    }
    if (!Array.isArray(f.steps) || f.steps.length === 0) {
      errors.push(`${at}: \`steps\` must be a non-empty list`)
    }

    if (f.needs != null && f.needs_absent != null) {
      errors.push(`${at}: carries BOTH \`needs\` and \`needs_absent\` — a feature routes on exactly one`)
    }
    for (const key of ['needs', 'needs_absent']) {
      const sel = f[key]
      if (sel == null) continue
      if (typeof sel !== 'string' || !sel.trim()) {
        errors.push(`${at}: \`${key}\` must be a non-empty selector string`)
        continue
      }
      if (/#shopify-section-/.test(sel)) {
        errors.push(`${at}: \`${key}\` uses a #shopify-section- instance id — generated per store, unknowable statically; use the component's own mount selector`)
      }
      // The selector must exist verbatim in the branch code we provided —
      // otherwise the runner's querySelector can never match and every routed
      // feature silently becomes "non applicable".
      if (codeCorpus && !codeCorpus.includes(selectorCore(sel))) {
        errors.push(
          `${at}: \`${key}: "${sel}"\` does not appear in the provided branch code — use a selector read verbatim from the code (custom element tag, wrapper class, or data- attribute)`
        )
      }
    }

    const steps = Array.isArray(f.steps) ? f.steps : []
    let absenceSteps = 0
    steps.forEach((step, j) => {
      const sAt = `${at} steps[${j}]`
      if (typeof step !== 'string' || !step.trim()) {
        errors.push(`${sAt}: each step is a plain French sentence (got ${JSON.stringify(step)})`)
        return
      }
      if (SELECTOR_IN_STEP_RE.test(step)) {
        errors.push(
          `${sAt}: contains a CSS selector or data- attribute ("${step.slice(0, 70)}") — steps are natural language; the runner resolves selectors itself. Selectors belong ONLY in needs/needs_absent`
        )
      }
      if (DIFF_REFERENTIAL_RE.test(step)) {
        errors.push(
          `${sAt}: describes the diff instead of the expected user-facing result ("${step.slice(0, 70)}") — assert the INTENDED state from schema labels, locales, PR intent`
        )
      }
      if (CONDITIONAL_RE.test(step)) {
        errors.push(
          `${sAt}: conditional step ("${step.slice(0, 70)}") — split into two features routed via needs/needs_absent instead`
        )
      }
      if (SUBJECTIVE_RE.test(step)) {
        errors.push(
          `${sAt}: subjective wording ("${step.slice(0, 70)}") — a browser cannot judge this; route to regression`
        )
      }
      if (ABSENCE_RE.test(step)) absenceSteps++
    })

    // A feature whose PRIMARY claim is an absence must be routed to a page
    // where that absence is the CORRECT state — that is what needs_absent is
    // for. Without routing, the runner may prove the absence on a page where
    // the element is simply broken. A single absence phrased as a mid-flow
    // consequence ("aucune redirection après l'ajout") on a global feature is
    // fine — only flag features that are ABOUT absence: the name says so, or
    // absence wording dominates the steps.
    const nameSignalsAbsence = typeof f.name === 'string' && /\bsans\b|\baucune?\b|\babsen|masqué|\bplus\s+de\b|ne\s+s'affiche/i.test(f.name)
    const absenceDominates = steps.length > 0 && absenceSteps / steps.length > 0.5
    if ((nameSignalsAbsence || absenceDominates) && f.needs == null && f.needs_absent == null) {
      errors.push(
        `${at}: is an absence check but has neither \`needs\` nor \`needs_absent\` — route it (needs_absent for "ça ne doit pas s'afficher" on a counter-example page; needs when the absence is a consequence on an eligible page)`
      )
    }
  })

  // --- regression -------------------------------------------------------------
  if (doc.regression != null) {
    if (!Array.isArray(doc.regression)) {
      errors.push('`regression` must be a list of plain one-line strings')
    } else {
      doc.regression.forEach((r, i) => {
        if (typeof r !== 'string') {
          errors.push(`regression[${i}]: must be a plain string (YAML parsed it as ${typeof r} — quote the whole line)`)
          return
        }
        if (DIFF_REFERENTIAL_RE.test(r)) {
          errors.push(
            `regression[${i}]: describes the diff as the expected result ("${r.slice(0, 90)}") — phrase it as a doubt about the intended behaviour`
          )
        }
        if (/\.(liquid|css|js|json|scss)\b/.test(r)) {
          errors.push(
            `regression[${i}]: names a source file ("${r.slice(0, 90)}") — name the section or the styled selector instead, never a file`
          )
        }
      })
    }
    // Unquoted `#` starts a YAML comment and silently truncates the line
    // (hover-workflows#11): require every regression list item to be quoted.
    const regSection = fence[1].match(/^regression:\n((?:[ \t]+-[^\n]*\n?)*)/m)
    if (regSection) {
      for (const line of regSection[1].split('\n')) {
        const m = line.match(/^[ \t]+-\s+(.*)$/)
        if (m && m[1] && !/^["']/.test(m[1])) {
          errors.push(
            `regression line not double-quoted ("${m[1].slice(0, 60)}") — always quote regression entries; an unquoted # would truncate the line`
          )
        }
      }
    }
  }

  return { errors }
}
