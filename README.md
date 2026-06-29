# hover-workflows

Central GitHub Actions automation for Hover PRs, running on a self-hosted runner.

- Add label `description` to a PR → its body is auto-generated from the diff.
- Add label `ready for qa` to a PR → a QA comment (human checklist + QA bot YAML) is posted.

No web server, no database, no Docker. GitHub Actions is the runtime; logic lives here and is
called by every client repo via `workflow_call`.

## How it works

```
UX-HOVER/hover-workflows/          ← this repo
├── .github/workflows/
│   ├── pr-description.yml         ← reusable workflow (workflow_call)
│   └── pr-qa.yml                  ← reusable workflow (workflow_call)
├── scripts/
│   ├── generate-description.js
│   ├── generate-qa.js
│   └── lib/
│       ├── github.js              ← GitHub REST API calls (native fetch)
│       └── claude.js              ← Claude API wrapper
├── prompts/
│   ├── description.md
│   └── qa.md
└── examples/client-repo/.github/workflows/hover-automation.yml
```

Each client repo only needs a single caller file
(`.github/workflows/hover-automation.yml`, see `examples/client-repo/`) that references this
repo's reusable workflows. Updating logic here propagates to every client repo automatically —
no per-repo changes needed.

Jobs run on `runs-on: self-hosted`, against the runner installed on the VPS
(`167.233.53.77`, install path `/home/mehdi/actions-runner/`). This gives unlimited
minutes and a consistent environment; no inbound ports are opened.

## Onboarding a new client repo

1. Copy `examples/client-repo/.github/workflows/hover-automation.yml` into the client repo at the
   same path.
2. Add the `ANTHROPIC_API_KEY` secret to the client repo: Settings → Secrets and variables →
   Actions → New repository secret.
3. Create the labels `description`, `ready for qa`, and `qa-generated` in the client repo (or
   bulk-create across repos via the GitHub API/CLI).

To bulk-add the secret across many repos:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

gh repo list UX-HOVER --json name -q '.[].name' | xargs -I{} \
  gh secret set ANTHROPIC_API_KEY --repo UX-HOVER/{} --body "$ANTHROPIC_API_KEY"
```

## Labels

| Label | Triggers | Added after | Removed after |
|---|---|---|---|
| `description` | PR description generation | — | ✅ after generation (prevents re-trigger loop) |
| `ready for qa` | QA steps generation | — | kept — human removes once QA is done |
| `qa-generated` | downstream signal | ✅ after QA comment posted | — |

## Limits

| Content | Limit |
|---|---|
| PR diff | 80k chars (description) / 60k chars (QA) |
| Single related file (QA) | 8k chars |
| Total related files context (QA) | 30k chars |
| Claude response | 2000 tokens (description) / 3000 tokens (QA) |

## Local development

```bash
npm ci
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... REPO=org/repo PR_NUMBER=123 \
  node scripts/generate-description.js

GITHUB_TOKEN=... ANTHROPIC_API_KEY=... REPO=org/repo PR_NUMBER=123 HEAD_REF=my-branch \
  node scripts/generate-qa.js
```

## Runner setup (VPS)

Org-level self-hosted runner for `UX-HOVER`, installed under the `mehdi` user's home directory.
Get a registration token from `github.com/orgs/UX-HOVER/settings/actions/runners` → New runner.

```bash
mkdir -p /home/mehdi/actions-runner && cd /home/mehdi/actions-runner
curl -o actions-runner-linux-x64.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
tar xzf ./actions-runner-linux-x64.tar.gz
./config.sh --url https://github.com/UX-HOVER --token RUNNER_TOKEN_FROM_GITHUB
sudo ./svc.sh install mehdi
sudo ./svc.sh start
```

Verify status with `sudo ./svc.sh status` (should show `active (running)`) and confirm the
runner shows **Idle** under the org's Settings → Actions → Runners.
