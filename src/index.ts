/**
 * @dsh-external/dsh-proof — PROOF 工具包
 *
 * 模型（0.8）：**项目 = 一个根目录**，发送 = 往项目里写一条相对子树。
 * 根由最近的 `.git` / `package.json` 锚点推断：同一个根下的不同路径
 * （比如 `prototype/` 和 `out/x.png`）会归到同一个项目，按相对路径各就各位。
 * 没有锚点的路径退化为“这一次的路径”，与 0.7 行为一致。
 *
 * 工具面：
 * - proof_send    发送一个目录或文件（按项目根归并，覆盖同一条子树）
 * - proof_remove  删除一个项目
 * - proof_status  服务与项目状态（只读）
 * - proof_serve   手动启停静态服务
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-proof'
export const inject = ['tools']

export interface Config {
  port: number
  root: string
  idleMinutes: number
}

export const Config = z.object({
  port: z.natural().default(8321),
  root: z.string().default(''),
  idleMinutes: z.natural().default(60),
})

const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.proof'])

/** 与 server.py 的护城墙对齐：这些目录/文件不进投放目录（copy 会真占盘，link 只是没必要） */
const SKIP_DIRS = new Set(['__pycache__', 'venv', '.venv', '.next', 'dist_node'])
const SECRET_EXT = /\.(pem|key|p12|pfx|keystore)$/i

/** 是否跳过这个条目：依赖/缓存/点文件/密钥一律不发（HTTP 层本来就 404，copy 还会白占盘） */
function skipEntry(name: string): boolean {
  return SKIP.has(name) || SKIP_DIRS.has(name) || name.startsWith('.') || SECRET_EXT.test(name)
}

/** 未配置 root 时的默认投放目录（每个用户各自的 home 下） */
function defaultRoot(): string {
  return path.join(os.homedir(), '.proof')
}

/** 随包发布的界面目录 */
function packagedUi(): string {
  return fileURLToPath(new URL('../ui', import.meta.url))
}

function ensureData(dir: string): void {
  const f = path.join(dir, 'data.json')
  if (!fs.existsSync(f)) writeJson(f, { updated: null, totals: {}, projects: [] })
}

type Kind = 'web' | 'image' | 'video' | 'doc' | 'asset' | 'file'
type Mode = 'link' | 'copy'

interface FileRec {
  p: string
  kind: Kind
  bytes: number
  mtime: number
}

/** 一条“子树贡献”：项目里 rel 这条路径来自 abs，用 link 还是 copy 落的 */
interface SourceRec {
  rel: string
  abs: string
  mode: Mode
}

interface ProjectRec {
  slug: string
  name: string
  /** 项目根（绝对路径）：锚点目录，或没有锚点时那一次发送的路径 */
  root: string
  dir: string
  kind: Kind
  bytes: number
  count: number
  ts: number
  at: string
  counts: Record<string, number>
  files: FileRec[]
  /** 全 link → link；全 copy → copy；混着用 → mixed */
  mode: Mode | 'mixed'
  sources: SourceRec[]
}

interface Registry {
  projects: Record<string, ProjectRec>
}

function lanIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return undefined
}

function probe(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned || 'item'
}

function kindOfFile(p: string): Kind {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'web'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.heic'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.webm', '.m4v', '.ogv'].includes(ext)) return 'video'
  if (['.pdf', '.md', '.txt', '.csv'].includes(ext)) return 'doc'
  if (['.js', '.mjs', '.css', '.json', '.wasm', '.map', '.woff', '.woff2', '.ttf'].includes(ext)) return 'asset'
  return 'file'
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipEntry(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

/** 采集文件清单（相对路径 + 类型 + 大小），最多 400 条；跟随软链接，限制深度防环 */
function collectFiles(dir: string): FileRec[] {
  const out: FileRec[] = []
  const walk = (base: string, rel: string, depth: number) => {
    if (out.length >= 400 || depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skipEntry(entry.name)) continue
      const r = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(base, r)
      let st: fs.Stats
      try {
        st = fs.statSync(full) // 跟随软链接
      } catch {
        continue
      }
      if (st.isDirectory()) walk(base, r, depth + 1)
      else if (st.isFile()) {
        out.push({ p: r, kind: kindOfFile(r), bytes: st.size, mtime: Math.round(st.mtimeMs) })
        if (out.length >= 400) return
      }
    }
  }
  walk(dir, '', 0)
  return out
}

function projectKind(files: FileRec[]): Kind {
  if (files.some((f) => f.p.toLowerCase().endsWith('index.html'))) return 'web'
  if (files.length && files.every((f) => f.kind === 'image')) return 'image'
  if (files.length && files.every((f) => f.kind === 'video')) return 'video'
  return files.length === 1 ? files[0].kind : 'file'
}

/** 项目根锚点：最近的含 .git 或 package.json 的祖先目录 */
function anchorOf(p: string): string | null {
  let cur = path.resolve(p)
  while (true) {
    if (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, 'package.json'))) return cur
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

interface Target {
  root: string
  rel: string
  name: string
  anchored: boolean
}

/** 这条源路径属于哪个项目、在项目里的相对位置是什么 */
function resolveTarget(src: string, st: fs.Stats, reg: Registry, opts: { project?: string; name?: string }): Target {
  if (opts.project) {
    const rec = reg.projects[slugify(opts.project)]
    if (!rec) throw new Error(`没有这个项目：${opts.project}`)
    const rel = path.relative(rec.root, src)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`源不在项目根下：${src}（项目根 ${rec.root}）`)
    return { root: rec.root, rel, name: rec.name, anchored: true }
  }
  const seed = st.isDirectory() ? src : path.dirname(src)
  const anchor = anchorOf(seed)
  if (anchor) {
    const rel = path.relative(anchor, src)
    return { root: anchor, rel, name: opts.name || path.basename(anchor), anchored: true }
  }
  // 没有锚点：退化为“这一次的路径”，与 0.7 的行为一致
  if (st.isDirectory()) {
    return { root: src, rel: '', name: opts.name || path.basename(src), anchored: false }
  }
  return { root: path.dirname(src), rel: path.basename(src), name: opts.name || path.basename(src), anchored: false }
}

/** 按根找已有项目；没锚点的按名字找（避免把同一目录下的散落文件合并） */
function findProject(reg: Registry, t: Target): ProjectRec | undefined {
  if (t.anchored) {
    const byRoot = Object.values(reg.projects).find((p) => p.root && path.resolve(p.root) === path.resolve(t.root))
    if (byRoot) return byRoot
  }
  return reg.projects[slugify(t.name)]
}

function uniqueSlug(reg: Registry, base: string, root: string): string {
  let slug = slugify(base)
  let i = 1
  while (reg.projects[slug] && path.resolve(reg.projects[slug].root || '') !== path.resolve(root)) {
    i += 1
    slug = `${slugify(base)}-${i}`
  }
  return slug
}

function modeLabel(mode: Mode | 'mixed'): string {
  return mode === 'copy' ? '副本' : mode === 'mixed' ? '混合' : '软链接'
}

function deriveMode(sources: SourceRec[], fallback: Mode): Mode | 'mixed' {
  if (!sources.length) return fallback
  if (sources.every((s) => s.mode === 'link')) return 'link'
  if (sources.every((s) => s.mode === 'copy')) return 'copy'
  return 'mixed'
}

/**
 * 把一条源落进项目的某条相对子树：先在同卷的隐藏暂存里搭好，再一步换上。
 * 失败只留暂存（会被 sweepStaging 清），不会留下半个项目，也不会先毁掉旧内容。
 */
function materializeInto(fDir: string, destDir: string, rel: string, src: string, mode: Mode): void {
  const target = rel ? path.join(destDir, rel) : destDir
  const staging = path.join(fDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const st = fs.statSync(src)
  try {
    fs.mkdirSync(staging, { recursive: true })
    if (st.isDirectory()) {
      if (mode === 'copy') copyTree(src, staging)
      else {
        for (const entry of fs.readdirSync(src)) {
          if (skipEntry(entry)) continue
          fs.symlinkSync(path.join(src, entry), path.join(staging, entry))
        }
      }
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(staging, target)
    } else {
      const base = path.basename(src)
      const staged = path.join(staging, base)
      if (mode === 'copy') fs.copyFileSync(src, staged)
      else fs.symlinkSync(src, staged)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(staged, target)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

interface BrokenInfo {
  slug: string
  name: string
  missing: string[]
}

/** 按登记清单检查 link/mixed 项目：记录里的文件此刻还在不在（能发现嵌套的断链） */
function checkLinks(root: string, reg: Registry): BrokenInfo[] {
  const out: BrokenInfo[] = []
  for (const p of Object.values(reg.projects)) {
    if (p.mode === 'copy') continue
    const dir = path.join(root, p.dir)
    if (!fs.existsSync(dir)) {
      out.push({ slug: p.slug, name: p.name, missing: ['（项目目录不存在）'] })
      continue
    }
    const missing: string[] = []
    for (const f of p.files ?? []) {
      try {
        fs.statSync(path.join(dir, f.p)) // 跟随链接，目标没了就抛
      } catch {
        missing.push(f.p)
      }
    }
    if (missing.length) out.push({ slug: p.slug, name: p.name, missing })
  }
  return out
}

/** 把断链状态写回 data.json，界面据此显示「链接失效」 */
function markBroken(root: string, broken: BrokenInfo[]): void {
  const file = path.join(root, 'data.json')
  const data = readJson<{ projects?: Array<Record<string, unknown>> } | null>(file, null)
  if (!data || !Array.isArray(data.projects)) return
  const set = new Set(broken.map((b) => b.slug))
  let changed = false
  for (const proj of data.projects) {
    const should = set.has(String(proj.slug))
    if (Boolean(proj.broken) !== should) {
      proj.broken = should
      changed = true
    }
  }
  if (changed) writeJson(file, data)
}

function rebuildData(dir: string, reg: Registry): void {
  const brokenSet = new Set(checkLinks(dir, reg).map((b) => b.slug))
  const projects = Object.values(reg.projects)
    .sort((a, b) => b.ts - a.ts)
    .map((p) => ({ ...p, broken: brokenSet.has(p.slug) }))
  const totals: Record<string, number> = {}
  for (const p of projects) for (const k of Object.keys(p.counts)) totals[k] = (totals[k] ?? 0) + p.counts[k]
  writeJson(path.join(dir, 'data.json'), {
    updated: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    totals,
    projects,
  })
}

function serverScript(): string {
  return fileURLToPath(new URL('../server.py', import.meta.url))
}

async function ensureServer(root: string, port: number, idleMinutes: number, uiDir: string): Promise<boolean> {
  if (await probe('127.0.0.1', port)) return true
  const sd = path.join(root, '.proof')
  fs.mkdirSync(sd, { recursive: true })
  const child = spawn(
    'python3',
    [serverScript(), root, String(port), String(idleMinutes), path.join(sd, 'activity'), uiDir],
    {
      detached: true,
      stdio: 'ignore',
    },
  )
  child.unref()
  // server.json 只在确认起来之后再写：启动失败不留指向死进程的状态文件
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (await probe('127.0.0.1', port)) {
      if (child.pid) writeJson(path.join(sd, 'server.json'), { pid: child.pid, port, startedAt: new Date().toISOString() })
      return true
    }
  }
  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
  return false
}

function stopServer(root: string): boolean {
  const sf = path.join(root, '.proof', 'server.json')
  const state = readJson<{ pid?: number }>(sf, {})
  if (!state.pid) return false
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch {
    /* 已自行退出 */
  }
  fs.rmSync(sf, { force: true })
  return true
}

/** 端口没监听时，清掉上一次留下的 server.json（死 PID 不该一直挂在状态文件里） */
function cleanServerState(root: string): void {
  fs.rmSync(path.join(root, '.proof', 'server.json'), { force: true })
}

/** 发包中途崩溃会留下 `.tmp-*` 暂存目录：超过 1 小时没人动的按垃圾清掉 */
function sweepStaging(root: string): void {
  const dir = path.join(root, 'f')
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.startsWith('.tmp-')) continue
    const full = path.join(dir, entry)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* 已经被清掉了 */
    }
  }
}

/**
 * link 项目的文件清单是发送那一刻的快照：源文件被改过，清单里的大小/mtime 就过时了。
 * mixed 里可能既有链接也有副本，重扫一遍是安全的（副本会拿到真实值）。
 */
function refreshLinks(root: string, reg: Registry): boolean {
  let changed = false
  for (const p of Object.values(reg.projects)) {
    if (p.mode === 'copy') continue
    const files = collectFiles(path.join(root, p.dir))
    if (!files.length) continue
    if (JSON.stringify(files) === JSON.stringify(p.files)) continue
    const counts: Record<string, number> = {}
    for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1
    p.files = files
    p.counts = counts
    p.count = files.length
    p.bytes = files.reduce((s, f) => s + f.bytes, 0)
    p.kind = projectKind(files)
    changed = true
  }
  return changed
}

/**
 * 0.7 → 0.8 迁移：旧登记是“一次发送一个项目”（扁平、basename 当名字）。
 * 这里按新的根规则重建：同一个根下的多个旧项目合并成一个，内容按相对路径归位。
 * 先备份 items.json / data.json；任何一步失败就保留旧数据，不半途而废。
 */
function migrateRegistry(root: string, regFile: string): boolean {
  const raw = readJson<{ projects?: Record<string, LegacyRec> }>(regFile, { projects: {} })
  const legacy = Object.values(raw.projects ?? {})
  if (!legacy.length) return false
  const needs = legacy.some((p) => !p.root || !Array.isArray(p.sources))
  if (!needs) return false

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sd = path.join(root, '.proof')
  // items.json 在 .proof/ 里，data.json 在根上 —— 分别备份
  for (const srcFile of [regFile, path.join(root, 'data.json')]) {
    try {
      fs.copyFileSync(srcFile, path.join(sd, `${path.basename(srcFile)}.bak-pre080-${stamp}`))
    } catch {
      /* data.json 可能还不存在 */
    }
  }

  const next: Registry = { projects: {} }
  const oldDirs: string[] = []
  try {
    for (const p of legacy) {
      if (!p.src || !fs.existsSync(p.src)) continue
      const st = fs.statSync(p.src)
      const t = resolveTarget(p.src, st, next, {})
      if (!t.anchored && p.name) t.name = p.name // 无锚点的旧项目保留原名（如「QR 码」）
      const slug = uniqueSlug(next, t.name, t.root)
      const rec =
        next.projects[slug] ??
        ({
          slug,
          name: t.name,
          root: t.root,
          dir: `f/${slug}`,
          kind: 'file',
          bytes: 0,
          count: 0,
          ts: p.ts ?? Math.round(Date.now() / 1000),
          at: p.at ?? '',
          counts: {},
          files: [],
          mode: p.mode === 'copy' ? 'copy' : 'link',
          sources: [],
        } as ProjectRec)
      materializeInto(path.join(root, 'f'), path.join(root, rec.dir), t.rel, p.src, p.mode === 'copy' ? 'copy' : 'link')
      rec.sources = rec.sources.filter((s) => s.rel !== t.rel && !s.rel.startsWith(t.rel ? `${t.rel}/` : '\u0000'))
      rec.sources.push({ rel: t.rel, abs: p.src, mode: p.mode === 'copy' ? 'copy' : 'link' })
      rec.mode = deriveMode(rec.sources, 'link')
      rec.root = t.root
      next.projects[slug] = rec
      if (p.dir && p.dir !== rec.dir) oldDirs.push(p.dir)
    }
    for (const rec of Object.values(next.projects)) {
      const files = collectFiles(path.join(root, rec.dir))
      const counts: Record<string, number> = {}
      for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1
      rec.files = files
      rec.counts = counts
      rec.count = files.length
      rec.bytes = files.reduce((s, f) => s + f.bytes, 0)
      rec.kind = projectKind(files)
    }
    writeJson(regFile, next)
    rebuildData(root, next)
    // 旧目录只在内容已经搬到新位置后才删，避免半途丢东西
    for (const dir of new Set(oldDirs)) {
      try {
        fs.rmSync(path.join(root, dir), { recursive: true, force: true })
      } catch {
        /* 留着也无害 */
      }
    }
    return true
  } catch {
    try {
      fs.copyFileSync(path.join(sd, `items.json.bak-pre080-${stamp}`), regFile)
    } catch {
      /* 备份也没了就只能这样 */
    }
    return false
  }
}

/** 0.7 的旧登记形状（只用于迁移） */
interface LegacyRec {
  slug: string
  name: string
  dir: string
  src: string
  ts?: number
  at?: string
  mode?: Mode
  root?: string
  sources?: SourceRec[]
  files?: FileRec[]
}

export function apply(ctx: Context, config: Config): void {
  const root = config.root ? path.resolve(config.root) : defaultRoot()
  const regFile = () => path.join(root, '.proof', 'items.json')
  const uiDir = packagedUi()

  try {
    fs.mkdirSync(root, { recursive: true })
    ensureData(root)
    migrateRegistry(root, regFile())
  } catch {
    /* 首次运行失败不该阻塞插件加载，工具调用时会再报 */
  }
  const requireRoot = (): string => {
    if (!root) throw new Error('插件未配置投放目录（config.root）')
    return root
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_send',
          description:
            '把目录或文件发送到 iPad，自动起服务。项目身份 = 项目根（最近的 .git 或 package.json 祖先）：同一个根下的不同路径会自动归到同一个项目、按相对路径摆放，重发只替换对应子树。mode 默认 link（软链接，改完刷新即见）：不要自行改判为 copy——只有用户明确要求“拷一份 / 副本 / 冻结快照”时才传 mode:"copy"。源可能在临时目录或外接盘时先提醒用户，由用户决定。',
          parameters: {
            source: { type: 'string', required: true, description: '要发送的目录或文件绝对路径' },
            name: { type: 'string', description: '项目名（默认取项目根目录名；已存在同根项目时忽略）' },
            mode: { type: 'string', description: 'link（默认，软链接不复制）或 copy（真复制一份；仅当用户明确要求时使用）' },
            project: { type: 'string', description: '强制归入某个已有项目（slug），用于没有锚点的散落文件' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { source: string; name?: string; mode?: string; project?: string }) {
            const r = requireRoot()
            const src = path.resolve(args.source)
            if (!fs.existsSync(src)) throw new Error(`路径不存在：${src}`)
            const st = fs.statSync(src)
            const mode: Mode = (args.mode || 'link').toLowerCase() === 'copy' ? 'copy' : 'link'
            sweepStaging(r)

            const reg = readJson<Registry>(regFile(), { projects: {} })
            const target = resolveTarget(src, st, reg, { name: args.name, project: args.project })
            const existing = findProject(reg, target)
            const slug = existing ? existing.slug : uniqueSlug(reg, target.name, target.root)
            const name = existing ? existing.name : target.name
            const destDir = path.join(r, 'f', slug)

            // 暂存 → 一步换上：失败只清暂存，已发布内容保持完整
            materializeInto(path.join(r, 'f'), destDir, target.rel, src, mode)

            const files = collectFiles(destDir)
            const counts: Record<string, number> = {}
            for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1
            const ts = Math.round(Date.now() / 1000)
            const at = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')

            const rec: ProjectRec =
              existing ??
              ({
                slug,
                name,
                root: target.root,
                dir: `f/${slug}`,
                kind: 'file',
                bytes: 0,
                count: 0,
                ts,
                at,
                counts: {},
                files: [],
                mode,
                sources: [],
              } as ProjectRec)

            if (target.rel === '') rec.sources = [{ rel: '', abs: src, mode }]
            else {
              rec.sources = (rec.sources ?? []).filter((s) => s.rel !== target.rel && !s.rel.startsWith(`${target.rel}/`))
              rec.sources.push({ rel: target.rel, abs: src, mode })
            }
            rec.mode = deriveMode(rec.sources, mode)
            rec.root = target.root
            rec.files = files
            rec.counts = counts
            rec.count = files.length
            rec.bytes = files.reduce((s, f) => s + f.bytes, 0)
            rec.kind = projectKind(files)
            rec.ts = ts
            rec.at = at
            reg.projects[slug] = rec
            writeJson(regFile(), reg)
            rebuildData(r, reg)

            const up = await ensureServer(r, config.port, config.idleMinutes, uiDir)
            const ip = lanIPv4()
            const url = `http://${ip ?? '127.0.0.1'}:${config.port}`
            const kindLabel: Record<string, string> = {
              web: '网页', image: '图片', video: '视频', doc: '文档', asset: '产物', file: '文件',
            }
            return [
              `已发送 ${name}（${kindLabel[rec.kind] ?? rec.kind} · ${modeLabel(rec.mode)}）`,
              `归属：项目 ${name} · ${target.rel ? `子树 ${target.rel}` : '整个项目'}（根 ${target.root}）`,
              `文件：${files.length} 个 · ${(bytesOf(files) / 1024).toFixed(0)} KB`,
              `项目页：${url}/proof/home-v1/project.html?p=${slug}`,
              `直接打开：${url}/${rec.dir}/`,
              `服务：${up ? '运行中' : '启动失败'}`,
            ].join('\n')
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_send',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_remove',
          description: '删除一个已发送的项目（连同它的所有子树）。',
          parameters: {
            project: { type: 'string', required: true, description: '项目 slug（见项目页地址 ?p=）' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { project: string }) {
            const r = requireRoot()
            const reg = readJson<Registry>(regFile(), { projects: {} })
            const slug = slugify(args.project)
            const rec = reg.projects[slug]
            if (!rec) throw new Error(`没有这个项目：${args.project}`)
            fs.rmSync(path.join(r, rec.dir), { recursive: true, force: true })
            delete reg.projects[slug]
            writeJson(regFile(), reg)
            rebuildData(r, reg)
            return `已删除 ${rec.name}（释放 ${(rec.bytes / 1024).toFixed(0)} KB）`
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_remove',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_status',
          description: '查看 PROOF 服务状态、局域网地址与已发送项目。',
          parameters: { verbose: { type: 'boolean', description: '附带详情' } },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { verbose?: boolean }) {
            const ip = lanIPv4()
            const running = await probe('127.0.0.1', config.port)
            if (!running) cleanServerState(root)
            const lan = ip ? `http://${ip}:${config.port}/` : '（未找到局域网地址）'
            const reg = readJson<Registry>(regFile(), { projects: {} })
            if (refreshLinks(root, reg)) {
              writeJson(regFile(), reg)
              rebuildData(root, reg)
            }
            const list = Object.values(reg.projects)
            const broken = checkLinks(root, reg)
            markBroken(root, broken)
            const brokenNote = broken.length ? ` · ${broken.length} 个链接失效` : ''
            if (!args.verbose) {
              return running
                ? `PROOF 运行中 · ${lan} · ${list.length} 个项目${brokenNote}`
                : `PROOF 未运行（端口 ${config.port} 无监听）${brokenNote}`
            }
            const total = list.reduce((s, p) => s + p.bytes, 0)
            return [
              `状态：${running ? '运行中' : '未运行'}`,
              `局域网：${lan}`,
              `投放目录：${root}${config.root ? '' : '（默认）'}`,
              `界面位置：${uiDir}（随插件）`,
              `项目：${list.length} 个 · ${(total / 1048576).toFixed(2)} MB`,
              `首页：${lan}proof/home-v1/`,
              `空闲停止：${config.idleMinutes} 分钟`,
              broken.length
                ? '断链：' + broken.map((b) => `${b.slug}（缺 ${b.missing.slice(0, 3).join(', ')}${b.missing.length > 3 ? ' …' : ''}）`).join('；')
                : '断链：无',
              list.length
                ? '项目根：\n' + list.map((p) => `  ${p.slug} ← ${p.root}（${p.sources.length} 条子树 · ${modeLabel(p.mode)}）`).join('\n')
                : '',
            ]
              .filter(Boolean)
              .join('\n')
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_status',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_serve',
          description: '手动启停 PROOF 静态服务。',
          parameters: { action: { type: 'string', required: true, description: 'start | stop | status' } },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { action: string }) {
            const r = requireRoot()
            const act = (args.action || '').toLowerCase()
            if (act === 'stop') {
              stopServer(r)
              await new Promise((res) => setTimeout(res, 300))
              return (await probe('127.0.0.1', config.port)) ? '停止失败' : '服务已停止'
            }
            if (act === 'status') {
              return (await probe('127.0.0.1', config.port))
                ? `服务运行中（:${config.port}）`
                : `服务未运行（:${config.port}）`
            }
            if (act !== 'start') throw new Error(`未知动作：${args.action}`)
            return (await ensureServer(r, config.port, config.idleMinutes, uiDir))
              ? `服务已启动（:${config.port}）`
              : '启动失败（端口可能被占用）'
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_serve',
  )
}

function bytesOf(files: FileRec[]): number {
  return files.reduce((s, f) => s + f.bytes, 0)
}
