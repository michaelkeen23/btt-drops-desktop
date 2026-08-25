// Publishes the built installer as a GitHub Release — the same channel TaskFire ships on, and the one
// electron-updater reads (package.json -> build.publish points at this repo).
//
//   $env:GITHUB_TOKEN='<token with repo scope>'; node scripts/upload.js     (PowerShell)
//   set GITHUB_TOKEN=... && node scripts/upload.js                          (cmd)
//
// Publishes three assets under tag v<version>:
//   BTTDrops-Setup-<version>.exe            the installer (the website's download button resolves this)
//   BTTDrops-Setup-<version>.exe.blockmap   differential-update map
//   latest.yml                              electron-updater feed
//
// Supabase Storage was the obvious home for these and is NOT usable: the project's global upload limit
// rejects an ~80 MB object (413 EntityTooLarge) no matter what the bucket's own limit says. Release
// assets have no such ceiling and are public on a public repo, which is what the download button needs.

const fs = require('fs')
const path = require('path')

const OWNER = 'michaelkeen23'
const REPO = 'btt-drops-desktop'
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!TOKEN) { console.error('Missing GITHUB_TOKEN env var (needs `repo` scope)'); process.exit(1) }

const pkg = require('../package.json')
const version = pkg.version
const tag = 'v' + version
const releaseDir = path.join(__dirname, '..', 'release')
const exeName = `BTTDrops-Setup-${version}.exe`
const assets = [
  [exeName, path.join(releaseDir, exeName), 'application/octet-stream'],
  [`${exeName}.blockmap`, path.join(releaseDir, `${exeName}.blockmap`), 'application/octet-stream'],
  ['latest.yml', path.join(releaseDir, 'latest.yml'), 'text/yaml'],
]
if (!fs.existsSync(assets[0][1])) { console.error('Installer not found:', assets[0][1], '\nRun `npm run dist` first.'); process.exit(1) }

const gh = (url, init = {}) => fetch(url, {
  ...init,
  headers: {
    Authorization: 'Bearer ' + TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'btt-drops-desktop-publisher',
    ...(init.headers || {}),
  },
})

;(async () => {
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`

  // Reuse the release for this tag if it exists, so re-running after a failed asset upload is safe.
  let rel
  const found = await gh(`${api}/releases/tags/${encodeURIComponent(tag)}`)
  if (found.ok) { rel = await found.json(); console.log('reusing release', tag) }
  else {
    const made = await gh(`${api}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: version, body: `BTT Drops ${version} for Windows.`, draft: false, prerelease: false }),
    })
    if (!made.ok) throw new Error(`create release failed: ${made.status} ${await made.text()}`)
    rel = await made.json()
    console.log('created release', tag)
  }

  for (const [name, file, type] of assets) {
    if (!fs.existsSync(file)) { console.warn('  ! missing', name, '— skipped'); continue }
    // Same-named assets can't coexist on a release; replace so a re-publish of the same version works.
    const dupe = (rel.assets || []).find((a) => a.name === name)
    if (dupe) await gh(`${api}/releases/assets/${dupe.id}`, { method: 'DELETE' })
    const buf = fs.readFileSync(file)
    const up = await gh(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': type, 'content-length': String(buf.length) }, body: buf,
    })
    if (!up.ok) throw new Error(`upload ${name} failed: ${up.status} ${await up.text()}`)
    console.log('  uploaded', name.padEnd(36), `${(buf.length / 1048576).toFixed(1)} MB`)
  }

  console.log(`\nPublished BTT Drops ${version}.`)
  console.log(`Release:  https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
  console.log('The DESKTOP APP button on /btt/drops resolves this automatically.')
})().catch((e) => { console.error(e); process.exit(1) })
