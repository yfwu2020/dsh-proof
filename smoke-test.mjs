import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {test} from 'node:test';
import * as proof from './lib/index.js';
const {Context}=await import('file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js');
test('proof_status reports a live service and feed count through its registered tool', async()=>{
  const root=mkdtempSync(join(tmpdir(),'proof-status-test-'));writeFileSync(join(root,'feed.json'),JSON.stringify({items:[{},{}]}));
  const server=net.createServer(socket=>socket.end());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;const tools=new Map();const ctx=new Context();
  ctx.provide('tools',{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}});
  proof.apply(ctx,proof.Config({port,root}));
  try {
    const tool=tools.get('proof_status');assert.ok(tool);
    assert.match(await tool.execute({}),/PROOF 服务运行中/);
    const verbose=await tool.execute({verbose:true});
    assert.match(verbose,/状态：运行中/);assert.match(verbose,/收件箱条目：2/);
    assert.ok(verbose.includes('端口：'+port));
  } finally {await new Promise(resolve=>server.close(resolve));}
});
