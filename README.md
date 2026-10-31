# PROOF — 本地原型工作台

当前是插件骨架，只提供只读工具 `proof_status`：检查本地服务、局域网地址和投放目录中的 `feed.json` 条目数。发布、版本管理、构建、自动打开功能尚未实现。

## 构建与验证

```sh
bash scripts/build.sh
npm run typecheck
```

在 DSH 中调用 `proof_status {"verbose":true}`。成功的验收条件是插件处于 active、工具已注册，而且实际调用返回服务状态。服务未启动时报告“未运行”是正常结果；该工具不会启动静态服务器。

## 安装位置

安装必须针对当前运行的 profile。桌面版使用 `~/.dsh/profiles/desktop`，旧 `web` profile 中的登记不会让桌面版加载插件。注入器修复后会从运行时 `profileContext.dir` 选择目录，显式指定的目录仍优先。

持久安装需要同时具备：

- 当前 profile 的 `dependencies` 中有本地包依赖，`dsh.profile.bundles` 中有包名；
- 当前 profile 的 `node_modules` 中有正确链接；
- 本包 `package.json` 中的 `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`；
- `lib/index.js` 已构建。

## 故障排查

先检查 `dev_plugin_status`，再调用 `proof_status`；不要用重载探测一个从未激活的插件。修复后的注入器会直接报告这种情况，并在导入失败时返回原始异常和使用的 profile。热重载超过 6 秒应返回转后台的警告，继续通过状态查看收口结果；警告不代表已成功。

2026-10-31 的记录包含一次长期未返回的重载，以及后续把“未激活”误报为“OK”的安装。2026-11-01 修复确认的配置错位：进程实际使用 desktop，注入器和安装操作却指向 web。原 README 中关于“apply 必然抛错”“热重载一定死锁”“touch 无反应证明必须重启”的断言均缺少充分证据，已删除。

## 目录

- `src/index.ts`：插件源码；资源注册由 `ctx.effect` 管理，卸载时清理。
- `cordis.patch.yml`：bundle 装配声明。
- `scripts/build.sh`：链接构建依赖并编译。
- `smoke-test.mjs`：通过实际 TCP 服务验证状态工具。
