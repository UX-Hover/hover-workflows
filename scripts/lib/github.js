const API_BASE = 'https://api.github.com'

function authHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  }
}

async function request(url, { headers = {}, ...options } = {}) {
  const res = await fetch(url, { headers: authHeaders(headers), ...options })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${url} failed: ${res.status} ${body}`)
  }
  return res
}

export async function fetchPR(repo, prNumber) {
  const res = await request(`${API_BASE}/repos/${repo}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  const data = await res.json()
  return {
    title: data.title,
    body: data.body,
    head: { ref: data.head.ref },
    base: { ref: data.base.ref },
  }
}

export async function fetchDiff(repo, prNumber) {
  const res = await request(`${API_BASE}/repos/${repo}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  })
  return res.text()
}

export async function fetchChangedFiles(repo, prNumber) {
  const res = await request(`${API_BASE}/repos/${repo}/pulls/${prNumber}/files`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  const data = await res.json()
  return data.map(({ filename, additions, deletions, status }) => ({
    filename,
    additions,
    deletions,
    status,
  }))
}

export async function fetchFileContent(repo, filePath, ref) {
  const url = `${API_BASE}/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`
  const res = await request(url, { headers: { Accept: 'application/vnd.github+json' } })
  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf-8')
}

export async function fetchDirectoryListing(repo, dirPath, ref) {
  const url = `${API_BASE}/repos/${repo}/contents/${dirPath}?ref=${encodeURIComponent(ref)}`
  const res = await request(url, { headers: { Accept: 'application/vnd.github+json' } })
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter((entry) => entry.type === 'file').map((entry) => entry.path)
}

export async function postComment(repo, prNumber, body) {
  await request(`${API_BASE}/repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
}

export async function updatePRBody(repo, prNumber, body) {
  await request(`${API_BASE}/repos/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
}

export async function removeLabel(repo, prNumber, label) {
  try {
    await request(
      `${API_BASE}/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE', headers: { Accept: 'application/vnd.github+json' } }
    )
  } catch {
    // label may already be removed — ignore
  }
}

export async function addLabel(repo, prNumber, label) {
  await request(`${API_BASE}/repos/${repo}/issues/${prNumber}/labels`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: [label] }),
  })
}
