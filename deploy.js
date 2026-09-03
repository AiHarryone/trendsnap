#!/usr/bin/env node
// Deploy a static site folder to GitHub Pages via the GitHub API git trees batch.
// Usage: node deploy.js <repo> <path-to-files> [commit-message]
// Auth: env GH_PAT or first arg fallback
const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;
if (!PAT) { console.error('Set GH_PAT env var first.'); process.exit(1); }
const REPO = process.argv[2];                 // "AiHarryone/pixelfix"
const DIR = process.argv[3];                  // absolute path to files
const MSG = process.argv[4] || 'deploy: static site update';

if (!REPO || !DIR) { console.error('usage: node deploy.js <repo> <dir> [msg]'); process.exit(1); }

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com',
      path: url,
      method,
      headers: {
        'Authorization': 'Bearer ' + PAT,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'claude-deploy',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { j = d; }
        if (res.statusCode >= 400) reject(new Error(JSON.stringify(j) || (res.statusCode + ' ' + d)));
        else resolve(j);
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. collect files recursively (skip .git, node_modules, test)
  const SKIP = new Set(['.git', 'node_modules', 'test', '.wrangler', 'wrangler.toml', 'worker-cf.js']);
  const files = [];
  (function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (SKIP.has(ent.name)) continue;
      if (ent.isDirectory()) walk(full, r);
      else files.push({ path: r.replace(/\\/g, '/'), full });
    }
  })(DIR, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  console.log('files:', files.map(f => f.path).join(', '));

  // 2. create blobs (batch)
  const blobPromises = files.map(f =>
    api('POST', '/repos/' + REPO + '/git/blobs', {
      content: fs.readFileSync(f.full, 'base64'),
      encoding: 'base64'
    }).then(b => ({ path: f.path, sha: b.sha, mode: '100644', type: 'blob' }))
  );
  const treeItems = await Promise.all(blobPromises);

  // 3. create tree
  const tree = await api('POST', '/repos/' + REPO + '/git/trees', { tree: treeItems });

  // 4. get current head (if any)
  let baseSha = null;
  try {
    const ref = await api('GET', '/repos/' + REPO + '/git/ref/heads/main');
    baseSha = ref.object.sha;
  } catch (e) { /* empty repo */ }

  // 5. create commit
  const commit = await api('POST', '/repos/' + REPO + '/git/commits', {
    message: MSG,
    tree: tree.sha,
    ...(baseSha ? { parents: [baseSha] } : {})
  });

  // 6. update ref
  if (baseSha) {
    await api('PATCH', '/repos/' + REPO + '/git/refs/heads/main', { sha: commit.sha, force: false });
  } else {
    await api('POST', '/repos/' + REPO + '/git/refs', { ref: 'refs/heads/main', sha: commit.sha });
  }
  console.log('✅ deployed to main @', commit.sha.slice(0, 8));
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
