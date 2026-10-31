/**
 * @dsh-external/dsh-proof — PROOF 工具包（骨架 v0.0.1）
 *
 * 当前只提供一个**只读**工具 `proof_status`：报告本地 PROOF 服务是否在跑。
 * 发布 / 版本 / 构建 / 自动打开等业务逻辑尚未实现。
 *
 * 资源注册一律挂 ctx.effect：fiber dispose 时自动注销，热重载不残留。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = '@dsh-external/dsh-proof'
export const inject = ['tools']

export interface Config {
  /** PROOF 本地服务端口 */
  port: number
  /** 投放目录（静态服务的 --directory），留空则只报连接状态 */
  root: string
}

export const Config = z.object({
  port: z.natural().default(8321),
  root: z.string().default(''),
})

/** 取第一个非回环 IPv4，用于拼局域网地址 */
function lanIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return undefined
}

/** TCP 探活：能连上就算在跑 */
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

function countFeedItems(root: string): number | null {
  if (!root) return null
  try {
    const raw = fs.readFileSync(path.join(root, 'feed.json'), 'utf8')
    const data = JSON.parse(raw) as { items?: unknown[] }
    return Array.isArray(data.items) ? data.items.length : null
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'proof_status',
          description: '查看 PROOF 本地服务是否在跑、局域网地址与投放目录状态。',
          parameters: {
            verbose: {
              type: 'boolean',
              description: '附带路径、端口与条目数',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
          },
          async execute(args: { verbose?: boolean }) {
            const ip = lanIPv4()
            const running = await probe('127.0.0.1', config.port)
            const items = countFeedItems(config.root)
            const lan = ip ? `http://${ip}:${config.port}/` : '（未找到局域网地址）'

            if (!args.verbose) {
              return running
                ? `PROOF 服务运行中 · ${lan}`
                : `PROOF 服务未运行（端口 ${config.port} 无监听）`
            }

            return [
              `状态：${running ? '运行中' : '未运行'}`,
              `端口：${config.port}`,
              `局域网：${lan}`,
              `投放目录：${config.root || '（未配置）'}`,
              `收件箱条目：${items === null ? '—' : String(items)}`,
            ].join('\n')
          },
        }),
      ),
    '@dsh-external/dsh-proof: proof_status',
  )
}
