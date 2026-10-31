/**
 * @dsh-external/dsh-proof — PROOF 工具包
 *
 * 工具面：
 * - proof_status  查看服务/投放目录状态（只读）
 * - proof_publish 把一个目录或文件发布成新版本，自动起服务并写收件箱
 * - proof_serve   手动启停静态服务（发布时会自动启动）
 *
 * 资源注册一律挂 ctx.effect：fiber dispose 时自动注销。
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
  /** 静态服务端口 */
  port: number
  /** 投放目录（静态服务的根） */
  root: string
  /** 空闲多少分钟后自动停服务 */
  idleMinutes: number
  /** 首页应用目录（发布后写 data.json 给它读） */
  appDir: string
}

export const Config = z.object({
  port: z.natural().default(8321),
  root: z.string().default(''),
  idleMinutes: z.natural().default(60),
  appDir: z.string().default(''),
})

const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.proof'])

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

function stateDir(root: string): string {
  const d = path.join(root, '.proof')
  fs.mkdirSync(d, { recursive: true })
  return d
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
  return cleaned || 'project'
}

function dirBytes(dir: string): number {
  let total = 0
  const walk = (p: string) => {
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) walk(path.join(p, e))
    } else {
      total += st.size
    }
  }
  walk(dir)
  return total
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

interface VersionRec {
  v: number
  ts: number
  at: string
  note: string
  dir: string
  src: string
  bytes: number
}

interface Registry {
  projects: Record<string, VersionRec[]>
}

function rebuildData(appDir: string, reg: Registry): string {
  const projects = Object.keys(reg.projects).map((slug) => {
    const list = reg.projects[slug].slice().sort((a, b) => b.v - a.v)
    return {
      slug,
      name: slug,
      versions: list,
      latest: list[0]?.v ?? 0,
      count: list.length,
      bytes: list.reduce((sum, x) => sum + (x.bytes || 0), 0),
    }
  })
  projects.sort((a, b) => (b.versions[0]?.ts ?? 0) - (a.versions[0]?.ts ?? 0))
  const data = {
    updated: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    projects,
  }
  const file = path.join(appDir, 'data.json')
  writeJson(file, data)
  return file
}

function serverScript(): string {
  return fileURLToPath(new URL('../server.py', import.meta.url))
}

async function ensureServer(root: string, port: number, idleMinutes: number): Promise<boolean> {
  if (await probe('127.0.0.1', port)) return true
  const sd = stateDir(root)
  const activity = path.join(sd, 'activity')
  const child = spawn(
    'python3',
    [serverScript(), root, String(port), String(idleMinutes), activity],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  if (child.pid) {
    writeJson(path.join(sd, 'server.json'), {
      pid: child.pid,
      port,
      startedAt: new Date().toISOString(),
    })
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (await probe('127.0.0.1', port)) return true
  }
  return false
}

function stopServer(root: string): boolean {
  const sd = stateDir(root)
  const state = readJson<{ pid?: number }>(path.join(sd, 'server.json'), {})
  if (!state.pid) return false
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch {
    /* 进程可能已经自己退了 */
  }
  fs.rmSync(path.join(sd, 'server.json'), { force: true })
  return true
}

export function apply(ctx: Context, config: Config): void {
  const root = config.root

  const requireRoot = (): string => {
    if (!root) throw new Error('插件未配置投放目录（config.root）')
    return root
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_status',
          description: '查看 PROOF 本地服务是否在跑、局域网地址与投放目录状态。',
          parameters: {
            verbose: { type: 'boolean', description: '附带路径、端口与条目数' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { verbose?: boolean }) {
            const ip = lanIPv4()
            const running = await probe('127.0.0.1', config.port)
            const lan = ip ? `http://${ip}:${config.port}/` : '（未找到局域网地址）'
            const appDir = config.appDir || path.join(root, 'proof', 'home-v1')
            const dataRec = readJson<{ updated?: string; projects?: unknown[] }>(
              path.join(appDir, 'data.json'),
              {},
            )
            const items = Array.isArray(dataRec.projects) ? dataRec.projects.length : null
            if (!args.verbose) {
              return running
                ? `PROOF 服务运行中 · ${lan}`
                : `PROOF 服务未运行（端口 ${config.port} 无监听）`
            }
            const reg = readJson<Registry>(path.join(root, '.proof', 'versions.json'), { projects: {} })
            const projects = Object.keys(reg.projects).length
            return [
              `状态：${running ? '运行中' : '未运行'}`,
              `端口：${config.port}`,
              `局域网：${lan}`,
              `投放目录：${root || '（未配置）'}`,
              `首页项目数：${items === null ? '—' : String(items)}`,
              `数据更新：${dataRec.updated ?? '—'}`,
              `已发布项目：${projects}`,
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
          name: 'proof_publish',
          description: '把目录发布成新版本并送到 iPad（自动起服务、写收件箱）。',
          parameters: {
            source: { type: 'string', required: true, description: '要发布的目录或文件绝对路径' },
            project: { type: 'string', description: '项目名（默认取目录名）' },
            note: { type: 'string', description: '这一版的说明，一句话' },
            auto: { type: 'boolean', description: 'iPad 是否自动打开（默认是）' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { source: string; project?: string; note?: string; auto?: boolean }) {
            const r = requireRoot()
            const src = path.resolve(args.source)
            if (!fs.existsSync(src)) throw new Error(`源路径不存在：${src}`)

            const slug = slugify(args.project || path.basename(src))
            const regFile = path.join(r, '.proof', 'versions.json')
            const reg = readJson<Registry>(regFile, { projects: {} })
            const list = reg.projects[slug] ?? []
            const v = list.reduce((m, x) => Math.max(m, x.v), 0) + 1

            const rel = `p/${slug}/v${v}`
            const destDir = path.join(r, rel)
            fs.rmSync(destDir, { recursive: true, force: true })

            const stat = fs.statSync(src)
            if (stat.isDirectory()) copyTree(src, destDir)
            else {
              fs.mkdirSync(destDir, { recursive: true })
              fs.copyFileSync(src, path.join(destDir, path.basename(src)))
            }

            const bytes = dirBytes(destDir)
            const ts = Math.round(Date.now() / 1000)
            const at = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            const rec: VersionRec = { v, ts, at, note: args.note ?? '', dir: rel, src, bytes }
            list.push(rec)
            reg.projects[slug] = list
            writeJson(regFile, reg)

            const appDir = config.appDir || path.join(r, 'proof', 'home-v1')
            rebuildData(appDir, reg)

            const up = await ensureServer(r, config.port, config.idleMinutes)
            const ip = lanIPv4()
            const base = ip ? `http://${ip}:${config.port}` : `http://127.0.0.1:${config.port}`

            return [
              `已发布 ${slug} v${v}`,
              `版本目录：${rel}/（${(bytes / 1024).toFixed(0)} KB）`,
              `版本地址：${base}/${rel}/`,
              `首页：${base}/proof/home-v1/（刷新即见 v${v}）`,
              `服务：${up ? '运行中' : '启动失败（端口可能被占用）'}`,
            ].join('\n')
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_publish',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_serve',
          description: '手动启停 PROOF 静态服务（发布时会自动启动，一般不用调）。',
          parameters: {
            action: { type: 'string', required: true, description: 'start | stop | status' },
          },
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
          },
          async execute(args: { action: string }) {
            const r = requireRoot()
            const act = (args.action || '').toLowerCase()
            if (act === 'stop') {
              const ok = stopServer(r)
              await new Promise((res) => setTimeout(res, 300))
              const still = await probe('127.0.0.1', config.port)
              return ok || !still ? '服务已停止' : '停止失败（进程可能不是本插件启动的）'
            }
            if (act === 'status') {
              const running = await probe('127.0.0.1', config.port)
              return running ? `服务运行中（:${config.port}）` : `服务未运行（:${config.port}）`
            }
            if (act !== 'start') throw new Error(`未知动作：${args.action}（start | stop | status）`)
            const ok = await ensureServer(r, config.port, config.idleMinutes)
            return ok ? `服务已启动（:${config.port}）` : '启动失败（端口可能被占用）'
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_serve',
  )
}
