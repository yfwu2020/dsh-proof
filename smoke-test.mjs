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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
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

/** 临时 root（不在这里注册清理：清理由 cleanup 统一做，顺序才对） */
function tempRoot(tag) {
  return mkdtempSync(join(tmpdir(), `proof-${tag}-`));
}

/**
 * 统一收尸：**先停服务、再删目录**，放在同一个 after 钩子里。
 * node:test 的 after 按注册顺序执行；拆成两个钩子会先删目录、把 server.json 一起删掉，
 * 于是停服务时找不到 pid，后台进程就变成孤儿（实测过）。
 */
function cleanup(t, root, tools) {
  t.after(async () => {
    if (tools) await tools.get('proof_serve').execute({ action: 'stop' }).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
}

test('注册四个工具', async (t) => {
  const root = tempRoot('surface');
  const tools = mount(root, await freePort());
  cleanup(t, root);
  assert.deepEqual([...tools.keys()].sort(), ['proof_remove', 'proof_send', 'proof_serve', 'proof_status']);
});

test('服务没起来时报「未运行」，且不会顺手拉起服务', async (t) => {
  const root = tempRoot('cold');
  const port = await freePort();
  const tools = mount(root, port);
  cleanup(t, root, tools);
  const out = await tools.get('proof_status').execute({});
  assert.match(out, /PROOF 未运行/);
  assert.equal(await listening(port), false);
});

test('发送目录 → 服务可用 → 实时大小 → 护城墙 → 删除', async (t) => {
  const root = tempRoot('e2e');
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'index.html'), '<h1>proof-e2e</h1>');
  writeFileSync(join(src, 'style.css'), 'a{color:red}');
  writeFileSync(join(src, '.env'), 'SECRET=1');

  const port = await freePort();
  const tools = mount(root, port);
  cleanup(t, root, tools);
  const base = `http://127.0.0.1:${port}`;

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
  // after 钩子靠 server.json 里的 pid 收尸：停完必须把它删掉，否则钩子找不到 pid 会孤儿化
  assert.equal(existsSync(join(root, '.proof', 'server.json')), false);
});

test('发送不存在的路径要报错，且不留下项目', async (t) => {
  const root = tempRoot('missing');
  const tools = mount(root, await freePort());
  cleanup(t, root, tools);
  await assert.rejects(() => tools.get('proof_send').execute({ source: join(root, 'nope') }), /路径不存在/);
  const status = await tools.get('proof_status').execute({ verbose: true });
  assert.match(status, /项目：0 个/);
});

test('同一项目根下的不同路径归入同一个项目，重发只替换对应子树', async (t) => {
  const root = tempRoot('roots');
  const proj = join(root, 'dsh-demo');
  mkdirSync(join(proj, 'prototype', 'assets'), { recursive: true });
  mkdirSync(join(proj, 'out'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"dsh-demo"}');
  writeFileSync(join(proj, 'prototype', 'index.html'), '<h1>proto</h1>');
  writeFileSync(join(proj, 'prototype', 'assets', 'a.png'), 'png');
  writeFileSync(join(proj, 'out', 'preview.png'), 'png2');

  const port = await freePort();
  const tools = mount(root, port);
  cleanup(t, root, tools);

  // 第一次：发目录 prototype/
  const first = await tools.get('proof_send').execute({ source: join(proj, 'prototype') });
  assert.match(first, /归属：项目 dsh-demo · 子树 prototype（根 /);

  // 第二次：发项目根之外的产物文件 out/preview.png —— 应归到同一个项目
  const second = await tools.get('proof_send').execute({ source: join(proj, 'out', 'preview.png') });
  assert.match(second, /归属：项目 dsh-demo · 子树 out\/preview\.png/);

  const data = await (await fetch(`http://127.0.0.1:${port}/data.json`)).json();
  assert.equal(data.projects.length, 1, '同一个根的两次发送只能有一个项目');
  const p = data.projects[0];
  assert.equal(p.slug, 'dsh-demo');
  assert.equal(p.root, proj);
  assert.deepEqual([...p.sources.map((s) => s.rel)].sort(), ['out/preview.png', 'prototype']);
  const paths = p.files.map((f) => f.p);
  assert.ok(paths.includes('prototype/index.html'));
  assert.ok(paths.includes('prototype/assets/a.png'));
  assert.ok(paths.includes('out/preview.png'));

  // 重发 prototype：只替换这条子树，out/preview.png 必须还在
  writeFileSync(join(proj, 'prototype', 'index.html'), '<h1>proto v2</h1>');
  await tools.get('proof_send').execute({ source: join(proj, 'prototype') });
  const after = (await (await fetch(`http://127.0.0.1:${port}/data.json`)).json()).projects[0];
  assert.ok(after.files.some((f) => f.p === 'out/preview.png'), '另一条子树不该被删');
  assert.deepEqual(readdirSync(join(root, 'f')).sort(), ['dsh-demo']);
  assert.deepEqual(readdirSync(join(root, 'f', 'dsh-demo')).sort(), ['out', 'prototype']);
});

test('旧登记（一次发送一个项目）迁移成按根合并', async (t) => {
  const root = tempRoot('migrate');
  const proj = join(root, 'legacy-app');
  mkdirSync(join(proj, 'proto'), { recursive: true });
  mkdirSync(join(proj, 'out'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{}');
  writeFileSync(join(proj, 'proto', 'index.html'), 'x');
  writeFileSync(join(proj, 'out', 'p.png'), 'y');

  // 伪造 0.7 的成品：两个扁平项目目录 + 旧式登记
  mkdirSync(join(root, 'f', 'legacy-a'), { recursive: true });
  mkdirSync(join(root, 'f', 'legacy-b'), { recursive: true });
  symlinkSync(join(proj, 'proto', 'index.html'), join(root, 'f', 'legacy-a', 'index.html'));
  symlinkSync(join(proj, 'out', 'p.png'), join(root, 'f', 'legacy-b', 'p.png'));
  mkdirSync(join(root, '.proof'), { recursive: true });
  writeFileSync(
    join(root, '.proof', 'items.json'),
    JSON.stringify({
      projects: {
        'legacy-a': { slug: 'legacy-a', name: 'legacy-a', dir: 'f/legacy-a', src: join(proj, 'proto'), mode: 'link', ts: 1, at: 'x', bytes: 0, count: 1, counts: {}, files: [] },
        'legacy-b': { slug: 'legacy-b', name: 'legacy-b', dir: 'f/legacy-b', src: join(proj, 'out', 'p.png'), mode: 'link', ts: 2, at: 'x', bytes: 0, count: 1, counts: {}, files: [] },
      },
    }),
  );

  const tools = mount(root, await freePort()); // apply() 时迁移
  cleanup(t, root, tools);
  const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf8'));
  assert.equal(data.projects.length, 1, '同一个根的旧项目应合并成一个');
  const p = data.projects[0];
  assert.equal(p.slug, 'legacy-app');
  assert.deepEqual([...p.sources.map((s) => s.rel)].sort(), ['out/p.png', 'proto']);
  assert.deepEqual(readdirSync(join(root, 'f')).sort(), ['legacy-app'], '旧目录应清掉');
  assert.ok(readdirSync(join(root, 'f', 'legacy-app')).sort().includes('out'));
  assert.ok(readdirSync(join(root, '.proof')).some((f) => f.startsWith('items.json.bak-pre080-')));
  assert.ok(existsSync(join(root, 'f', 'legacy-app', 'proto', 'index.html')));
});

test('entry：只发成品网页那一版，调试/草稿/旧版本都不进项目', async (t) => {
  const root = tempRoot('final');
  const proj = join(root, 'game');
  mkdirSync(join(proj, 'old-proto'), { recursive: true });
  mkdirSync(join(proj, 'proto3d', 'assets'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{}');
  writeFileSync(join(proj, 'old-proto', 'index.html'), 'old');
  writeFileSync(join(proj, 'proto3d', 'index.html'), '<script src="main.js"></script>');
  writeFileSync(join(proj, 'proto3d', 'main.js'), '// game');
  writeFileSync(join(proj, 'proto3d', '_debug-shadow.html'), 'debug');
  writeFileSync(join(proj, 'proto3d', 'draft.html'), 'draft');
  writeFileSync(join(proj, 'proto3d', 'assets', 'a.png'), 'png');

  const port = await freePort();
  const tools = mount(root, port);
  cleanup(t, root, tools);

  const msg = await tools.get('proof_send').execute({
    source: join(proj, 'proto3d'),
    entry: 'index.html',
  });
  assert.match(msg, /整体替换/);

  const data = await (await fetch(`http://127.0.0.1:${port}/data.json`)).json();
  assert.equal(data.projects.length, 1);
  const p = data.projects[0];
  assert.equal(p.slug, 'game');
  // 成品目录被提到项目根：/f/<slug>/ 直接就是那一版网页
  assert.deepEqual(p.files.map((f) => f.p).sort(), ['assets/a.png', 'index.html', 'main.js']);
  assert.equal((await fetch(`http://127.0.0.1:${port}/f/game/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/f/game/_debug-shadow.html`)).status, 404);

  // 再发一版别的目录（仍是 entry）：整体替换，旧内容不残留
  mkdirSync(join(proj, 'proto4d'), { recursive: true });
  writeFileSync(join(proj, 'proto4d', 'index.html'), '<h1>v2</h1>');
  await tools.get('proof_send').execute({ source: join(proj, 'proto4d'), entry: 'index.html' });
  const again = (await (await fetch(`http://127.0.0.1:${port}/data.json`)).json()).projects[0];
  assert.deepEqual(again.files.map((f) => f.p), ['index.html']);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/f/game/`)).text(), /v2/);

  // 删单条子树；删空后项目随之移除
  assert.match(await tools.get('proof_remove').execute({ project: 'game', path: 'index.html' }), /最后一条子树|已删除/);
  const empty = await (await fetch(`http://127.0.0.1:${port}/data.json`)).json();
  assert.equal(empty.projects.length, 0);
});
