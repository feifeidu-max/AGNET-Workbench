// One-off: sync the running .runtime Hermes home skills to match the bundled
// source skill set (only the two required llm-wiki skills). Mirrors the
// Web UI skill injector's copy + manifest behavior, but also prunes orphans
// the injector itself never removes.
import { cp, rm, readdir, readFile, writeFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, resolve } from 'path'

const ROOT = resolve(process.cwd(), '.runtime/hermes-home')
const SOURCE = resolve(process.cwd(), 'apps/hermes-studio/dist/skills')
const HASH_IGNORED = new Set(['.DS_Store', 'Thumbs.db', '.wui-managed.json'])
const OWNER = 'hermes-web-ui'
const BUNDLED = ['llm-wiki-search', 'llm-wiki-graph']
const ORPHANS = ['apikey-image-gen', 'grok-image-to-video', 'hyperframes', 'markdown-viewer', 'remotion']

async function isDir(p) { try { return (await stat(p)).isDirectory() } catch { return false } }

async function hashDirInto(hash, dir, rel) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter(e => !HASH_IGNORED.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const rp = rel ? `${rel}/${e.name}` : e.name
    const fp = join(dir, e.name)
    if (e.isDirectory()) {
      hash.update(`dir\0${rp}\0`)
      await hashDirInto(hash, fp, rp)
    } else if (e.isFile()) {
      hash.update(`file\0${rp}\0`)
      hash.update(await readFile(fp))
      hash.update('\0')
    }
  }
}
async function hashDir(dir) {
  const h = createHash('sha256')
  await hashDirInto(h, dir, '')
  return h.digest('hex')
}

const targets = [join(ROOT, 'skills'), join(ROOT, 'profiles', 'research', 'skills')]

for (const target of targets) {
  await mkdir(target, { recursive: true })
  // 1. prune orphans
  for (const o of ORPHANS) {
    const p = join(target, o)
    if (existsSync(p)) { await rm(p, { recursive: true, force: true }); console.log(`pruned orphan: ${target}/${o}`) }
  }
  // 2. install bundled
  const manifest = {}
  for (const name of BUNDLED) {
    const src = join(SOURCE, name)
    const dst = join(target, name)
    if (!(await isDir(src))) { console.warn(`source missing: ${src}`); continue }
    await rm(dst, { recursive: true, force: true })
    await cp(src, dst, { recursive: true })
    const h = await hashDir(dst)
    manifest[name] = { owner: OWNER, source_hash: h, installed_hash: h }
    console.log(`installed: ${target}/${name} (${h.slice(0, 12)})`)
  }
  // 3. write manifest (sorted)
  const sorted = {}
  for (const k of Object.keys(manifest).sort()) sorted[k] = manifest[k]
  await writeFile(join(target, '.webui-managed-skills.json'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8')
  console.log(`wrote manifest: ${target}/.webui-managed-skills.json`)
}
console.log('DONE')
