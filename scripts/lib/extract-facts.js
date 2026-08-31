// Static fact extraction over the gathered component set.
//
// The model is good at describing code it can see and bad at guaranteeing it
// looked at all of it. These greps are cheap and exhaustive, so they become the
// agenda: every fact listed here is something the test plan must either cover or
// explicitly decline. That turns "did it notice the event?" from a hope into a
// checkable property.
//
// Deliberately regex, not a parser: theme JS is a mix of ES modules, inline
// `{% javascript %}`, and Liquid-interpolated JS that no JS parser accepts.

const PATTERNS = [
  {
    key: 'customElements',
    label: 'Custom elements defined',
    re: /customElements\.define\(\s*['"`]([\w-]+)['"`]/g,
  },
  {
    key: 'eventsDispatched',
    label: 'Events dispatched',
    re: /new\s+CustomEvent\(\s*['"`]([^'"`]+)['"`]/g,
  },
  {
    key: 'eventsListened',
    label: 'Events listened for',
    re: /addEventListener\(\s*['"`]([^'"`]+)['"`]/g,
  },
  {
    key: 'cartCalls',
    label: 'Cart endpoints called',
    re: /['"`/]((?:cart\/(?:add|change|update|clear))(?:\.js)?|cart\.js)['"`?]/g,
  },
  {
    key: 'deviceBranches',
    label: 'Device branches in JS',
    re: /matchMedia\(\s*['"`]([^'"`]+)['"`]|innerWidth\s*[<>]=?\s*(\d+)/g,
  },
  {
    key: 'stateAttributes',
    label: 'State attributes toggled',
    re: /(?:toggleAttribute|setAttribute|removeAttribute)\(\s*['"`]([\w-]+)['"`]/g,
  },
  {
    key: 'stateClasses',
    label: 'State classes toggled',
    re: /classList\.(?:add|remove|toggle)\(\s*['"`]([\w-]+)['"`]/g,
  },
  {
    key: 'timers',
    label: 'Timers',
    re: /(setTimeout|setInterval)\(\s*[^,]{0,80},\s*(\d+)/g,
  },
]

const JS_LIKE = /\.(js|js\.liquid)$/

function isJsLike(filePath) {
  return JS_LIKE.test(filePath)
}

// A custom element only matters if it is actually mounted. Finding `<my-el>` in
// the Liquid proves the behaviour is reachable; not finding it is itself a fact
// worth surfacing, because tests for an unmounted component always fail.
function findMounts(tag, entries) {
  const re = new RegExp(`<${tag}[\\s>]`)
  return entries.filter((e) => !isJsLike(e.filePath) && re.test(e.content)).map((e) => e.filePath)
}

export function extractFacts(entries) {
  const facts = {}
  for (const { key } of PATTERNS) facts[key] = new Map()

  for (const entry of entries) {
    // Cart calls and custom-element mounts appear in Liquid too; everything else
    // is behaviour and only means something in JS.
    const jsOnly = !isJsLike(entry.filePath)
    for (const { key, re } of PATTERNS) {
      if (jsOnly && key !== 'cartCalls') continue
      for (const m of entry.content.matchAll(new RegExp(re.source, re.flags))) {
        const value = key === 'timers' ? `${m[1]} ${m[2]}ms` : (m[1] ?? m[2])
        if (!value) continue
        if (!facts[key].has(value)) facts[key].set(value, new Set())
        facts[key].get(value).add(entry.filePath)
      }
    }
  }

  const mounts = new Map()
  for (const tag of facts.customElements.keys()) {
    mounts.set(tag, findMounts(tag, entries))
  }

  return { facts, mounts }
}

// Events a component listens for but nobody in the set dispatches come from
// elsewhere in the theme. That is not a bug, but it IS the boundary where this
// PR depends on code it does not contain — exactly what a reviewer wants flagged.
function crossFileEvents({ facts }) {
  const dispatched = new Set(facts.eventsDispatched.keys())
  const DOM_EVENTS =
    /^(click|submit|change|input|keydown|keyup|keypress|focus|blur|scroll|resize|load|DOMContentLoaded|mouse\w+|pointer\w+|touch\w+|drag\w+|wheel|transitionend|animationend|visibilitychange|popstate)$/
  return [...facts.eventsListened.keys()].filter((e) => !dispatched.has(e) && !DOM_EVENTS.test(e))
}

export function formatFacts(extracted) {
  const { facts, mounts } = extracted
  const sections = []

  for (const { key, label } of PATTERNS) {
    const map = facts[key]
    if (!map.size) continue
    const lines = [...map.entries()].map(([value, files]) => {
      const where = [...files].join(', ')
      if (key === 'customElements') {
        const mountedIn = mounts.get(value) ?? []
        const mountNote = mountedIn.length
          ? `mounted as \`<${value}>\` in ${mountedIn.join(', ')}`
          : `NO \`<${value}>\` tag found in the fetched markup — either it is mounted in a file outside this set, or it never renders (say which, and do not write steps that assume it renders)`
        return `- \`${value}\` (defined in ${where}) — ${mountNote}`
      }
      return `- \`${value}\` — ${where}`
    })
    sections.push(`**${label}:**\n${lines.join('\n')}`)
  }

  const external = crossFileEvents(extracted)
  if (external.length) {
    sections.push(
      `**Events listened for but NOT dispatched anywhere in this set:**\n${external
        .map((e) => `- \`${e}\` — dispatched elsewhere in the theme; this PR depends on code it does not contain`)
        .join('\n')}`
    )
  }

  if (!sections.length) return null
  return sections.join('\n\n')
}

// The machine-readable form, for a coverage check on the generated plan.
export function factInventory({ facts }) {
  return {
    customElements: [...facts.customElements.keys()],
    eventsDispatched: [...facts.eventsDispatched.keys()],
    eventsListened: [...facts.eventsListened.keys()],
    cartCalls: [...facts.cartCalls.keys()],
    deviceBranches: [...facts.deviceBranches.keys()],
  }
}
