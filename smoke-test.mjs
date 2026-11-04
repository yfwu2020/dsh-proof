/**
 * PROOF 冒烟测试 —— 只走公开工具面 + 真实 HTTP，不 mock 服务端行为。
 *
 * 跑法：
 *   bash scripts/build.sh     # 先建 node_modules 链接并编译 lib/
 *   npm test                  # = node --test smoke-test.mjs
 *
 * 覆盖：工具面 · 未运行状态 · 发送 → 服务 → 文件可达 · link 模式实时大小 ·
 *       护城墙（点文件/依赖目录 404）· 删除 · 路径不存在时的报错。
 *
 * 清理约定：每个用例都用 t.after 注册清理（临时 root 目录 + 后台服务），
 * 断言失败时也照样收尸，`npm test` 不该在系统临时目录里留下任何东西。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import * as proof from './lib/index.js';

// cordis 从本包 node_modules 的链接解析（build.sh 建的），不再硬编码 asar 路径
const { Context } = await import('@deepseek-ai/cordis');

/** 拿一个当前空闲的端口 */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 端口上是否有人在监听 */
function listening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/** 用一个临时 root 挂载插件，返回工具表 */
function mount(root, port) {
  const tools = new Map();
  const ctx = new Context();
  ctx.provide('tools', {
    register(tool) {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
  });
  proof.apply(ctx, proof.Config({ port, root, idleMinutes: 1 }));
  return tools;
}

/** 临时 root + 自动删除（断言失败也删） */
function tempRoot(t, tag) {
  const root = mkdtempSync(join(tmpdir(), `proof-${tag}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('注册四个工具', async (t) => {
  const tools = mount(tempRoot(t, 'surface'), await freePort());
  assert.deepEqual([...tools.keys()].sort(), ['proof_remove', 'proof_send', 'proof_serve', 'proof_status']);
});

test('服务没起来时报「未运行」，且不会顺手拉起服务', async (t) => {
  const root = tempRoot(t, 'cold');
  const port = await freePort();
  const tools = mount(root, port);
  const out = await tools.get('proof_status').execute({});
  assert.match(out, /PROOF 未运行/);
  assert.equal(await listening(port), false);
});

test('发送目录 → 服务可用 → 实时大小 → 护城墙 → 删除', async (t) => {
  const root = tempRoot(t, 'e2e');
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'index.html'), '<h1>proof-e2e</h1>');
  writeFileSync(join(src, 'style.css'), 'a{color:red}');
  writeFileSync(join(src, '.env'), 'SECRET=1');

  const port = await freePort();
  const tools = mount(root, port);
  const base = `http://127.0.0.1:${port}`;
  // 无论断言成败，都要把这个端口上的服务收掉
  t.after(async () => {
    await tools.get('proof_serve').execute({ action: 'stop' }).catch(() => {});
  });

  const sent = await tools.get('proof_send').execute({ source: src, name: 'demo' });
  assert.match(sent, /已发送 demo/);
  assert.match(sent, /服务：运行中/);

  const page = await fetch(`${base}/f/demo/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /proof-e2e/);

  const sizeOf = (proj, name) => proj.files.find((f) => f.p === name).bytes;
  const first = (await (await fetch(`${base}/data.json`)).json()).projects.find((p) => p.slug === 'demo');
  assert.ok(first, 'data.json 里应有 demo 项目');
  assert.equal(first.mode, 'link');
  assert.equal(sizeOf(first, 'style.css'), statSync(join(src, 'style.css')).size);

  // link 模式：源文件改了，/data.json 立刻是新的，而不是发送时的快照
  writeFileSync(join(src, 'style.css'), 'a{color:blue}' + ' '.repeat(64));
  const after = (await (await fetch(`${base}/data.json`)).json()).projects.find((p) => p.slug === 'demo');
  assert.equal(sizeOf(after, 'style.css'), statSync(join(src, 'style.css')).size);
  assert.ok(sizeOf(after, 'style.css') > sizeOf(first, 'style.css'));

  // 护城墙：点文件、依赖目录一律不通过 HTTP 暴露
  assert.equal((await fetch(`${base}/f/demo/.env`)).status, 404);
  assert.equal((await fetch(`${base}/f/demo/node_modules/x`)).status, 404);

  // copy 模式不抄点文件/构建缓存：副本里只该有正常内容
  assert.match(await tools.get('proof_send').execute({ source: src, name: 'demo', mode: 'copy' }), /副本/);
  assert.deepEqual(readdirSync(join(root, 'f', 'demo')).sort(), ['index.html', 'style.css']);

  const verbose = await tools.get('proof_status').execute({ verbose: true });
  assert.match(verbose, /状态：运行中/);
  assert.match(verbose, /项目：1 个/);
  assert.match(verbose, /断链：无/);

  // 重发同名项目：覆盖成功，f/ 里只有成品，不残留 .tmp-* 暂存目录
  assert.match(await tools.get('proof_send').execute({ source: src, name: 'demo' }), /已发送 demo/);
  assert.deepEqual(readdirSync(join(root, 'f')), ['demo']);

  assert.match(await tools.get('proof_remove').execute({ project: 'demo' }), /已删除 demo/);
  assert.equal((await (await fetch(`${base}/data.json`)).json()).projects.length, 0);

  await tools.get('proof_serve').execute({ action: 'stop' });
  assert.equal(await listening(port), false);
});

test('发送不存在的路径要报错，且不留下项目', async (t) => {
  const root = tempRoot(t, 'missing');
  const tools = mount(root, await freePort());
  await assert.rejects(() => tools.get('proof_send').execute({ source: join(root, 'nope') }), /路径不存在/);
  const status = await tools.get('proof_status').execute({ verbose: true });
  assert.match(status, /项目：0 个/);
});
