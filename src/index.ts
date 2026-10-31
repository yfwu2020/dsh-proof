/**
 * @dsh-external/dsh-proof — PROOF 工具包
 *
 * 模型（0.3）：**一次发送 = 一个项目**，不留版本历史。
 * 项目页 = 该项目的文件浏览器，按类型分类（网页 / 图片 / 视频 / 文档 / 产物 / 其他）。
 *
 * 工具面：
 * - proof_send    发送一个目录或文件到 iPad（同名覆盖）
 * - proof_remove  删除一个已发送的项目
 * - proof_status  服务与投放目录状态（只读）
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

interface FileRec {
  p: string
  kind: Kind
  bytes: number
}

interface ProjectRec {
  slug: string
  name: string
  kind: Kind
  dir: string
  src: string
  bytes: number
  count: number
  ts: number
  at: string
  counts: Record<string, number>
  files: FileRec[]
  mode: 'link' | 'copy'
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
    if (SKIP.has(entry.name)) continue
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
      if (SKIP.has(entry.name)) continue
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
        out.push({ p: r, kind: kindOfFile(r), bytes: st.size })
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

function rebuildData(dir: string, reg: Registry): void {
  const projects = Object.values(reg.projects).sort((a, b) => b.ts - a.ts)
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
  })
  child.unref()
  if (child.pid) writeJson(path.join(sd, 'server.json'), { pid: child.pid, port, startedAt: new Date().toISOString() })
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (await probe('127.0.0.1', port)) return true
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

export function apply(ctx: Context, config: Config): void {
  const root = config.root ? path.resolve(config.root) : defaultRoot()
  const regFile = () => path.join(root, '.proof', 'items.json')
  const uiDir = packagedUi()

  try {
    fs.mkdirSync(root, { recursive: true })
    ensureData(root)
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
          description: '把目录或文件发送到 iPad（同名项目覆盖），自动起服务。',
          parameters: {
            source: { type: 'string', required: true, description: '要发送的目录或文件绝对路径' },
            name: { type: 'string', description: '项目名（默认取文件名/目录名）' },
            mode: { type: 'string', description: 'link（默认，软链接不复制）或 copy（真复制一份）' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { source: string; name?: string; mode?: string }) {
            const r = requireRoot()
            const src = path.resolve(args.source)
            if (!fs.existsSync(src)) throw new Error(`路径不存在：${src}`)

            const base = args.name || path.basename(src)
            const slug = slugify(base)
            const destDir = path.join(r, 'f', slug)
            fs.rmSync(destDir, { recursive: true, force: true })

            const mode = (args.mode || 'link').toLowerCase() === 'copy' ? 'copy' : 'link'
            const st = fs.statSync(src)
            if (mode === 'copy') {
              if (st.isDirectory()) copyTree(src, destDir)
              else {
                fs.mkdirSync(destDir, { recursive: true })
                fs.copyFileSync(src, path.join(destDir, path.basename(src)))
              }
            } else {
              // 软链接：只指路，不搬家。目录里逐条建链接（跳过 node_modules/.git）
              fs.mkdirSync(destDir, { recursive: true })
              if (st.isDirectory()) {
                for (const entry of fs.readdirSync(src)) {
                  if (SKIP.has(entry)) continue
                  fs.symlinkSync(path.join(src, entry), path.join(destDir, entry))
                }
              } else {
                fs.symlinkSync(src, path.join(destDir, path.basename(src)))
              }
            }

            const files = collectFiles(destDir)
            const counts: Record<string, number> = {}
            for (const f of files) counts[f.kind] = (counts[f.kind] ?? 0) + 1
            const bytes = files.reduce((s, f) => s + f.bytes, 0)
            const ts = Math.round(Date.now() / 1000)
            const at = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')

            const reg = readJson<Registry>(regFile(), { projects: {} })
            const rec: ProjectRec = {
              slug,
              name: base,
              kind: projectKind(files),
              dir: `f/${slug}`,
              src,
              bytes,
              count: files.length,
              ts,
              at,
              counts,
              files,
              mode,
            }
            reg.projects[slug] = rec
            writeJson(regFile(), reg)
            rebuildData(root, reg)

            const up = await ensureServer(r, config.port, config.idleMinutes, uiDir)
            const ip = lanIPv4()
            const url = `http://${ip ?? '127.0.0.1'}:${config.port}`
            const kindLabel: Record<string, string> = {
              web: '网页', image: '图片', video: '视频', doc: '文档', asset: '产物', file: '文件',
            }
            return [
              `已发送 ${base}（${kindLabel[rec.kind] ?? rec.kind} · ${mode === 'link' ? '软链接' : '副本'}）`,
              `文件：${files.length} 个 · ${(bytes / 1024).toFixed(0)} KB`,
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
          description: '删除一个已发送到 iPad 的项目。',
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
            rebuildData(root, reg)
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
            const lan = ip ? `http://${ip}:${config.port}/` : '（未找到局域网地址）'
            const reg = readJson<Registry>(regFile(), { projects: {} })
            const list = Object.values(reg.projects)
            if (!args.verbose) {
              return running
                ? `PROOF 运行中 · ${lan} · ${list.length} 个项目`
                : `PROOF 未运行（端口 ${config.port} 无监听）`
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
            ].join('\n')
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
