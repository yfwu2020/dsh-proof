# PROOF — 本地原型工作台

v0.3.0 起改为**文件管理模式**：**一次发送 = 一个项目，不留版本历史**。

- 发一个目录或文件 → 复制到 `<root>/f/<slug>/` → 重写首页 `data.json`
- 项目页 = 该项目的**文件浏览器**，按类型分类：网页 / 图片 / 视频 / 文档 / 产物 / 文件
- 同名重发 = 覆盖
- 根路径 `/` 直接 302 到首页；没有收件箱

三个工具：

| 工具 | 作用 |
|---|---|
| `proof_status` | 服务状态、局域网地址、收件箱条目、已发布项目数 |
| `proof_send` | 发送目录/文件到 iPad（同名覆盖），自动起服务 |
| `proof_remove` | 删除一个已发送的项目 |
| `proof_serve` | 手动 `start` / `stop` / `status`（发布时会自动启动） |

发布语义：

```
源目录  →  <root>/p/<slug>/v<N>/         （复制，跳过 node_modules/.git）
        →  <root>/.proof/versions.json   （版本登记，内部状态）
        →  <root>/proof/home-v1/data.json（首页数据，页面直接读）
```

访问入口：

- `http://<ip>:8321/` → 302 → 首页
- `http://<ip>:8321/proof/home-v1/` → 首页（项目数、版本数、最新发布、最近更新）
- `http://<ip>:8321/proof/home-v1/projects.html` → 全部项目
- `http://<ip>:8321/proof/home-v1/project.html?p=<slug>&v=<n>` → 项目页
- `http://<ip>:8321/p/<slug>/v<n>/` → 某一版本身（旧版永久可开）

服务：`server.py` 由插件以 detached 子进程拉起，每 30 秒检查一次活动时间，
空闲超过 `idleMinutes`（默认 60）自动退出。

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

- `src/index.ts`：插件源码；三个工具，资源注册由 `ctx.effect` 管理。
- `server.py`：静态服务（按需启动、空闲自停、记录活动时间）。
- `cordis.patch.yml`：bundle 装配声明（port / root / idleMinutes）。
- `scripts/build.sh`：链接构建依赖并编译。
- `smoke-test.mjs`：通过实际 TCP 服务验证状态工具。
- `<root>/.proof/`：运行状态（`versions.json` 版本登记、`server.json` 进程、`activity` 活动时间）。

## 已知限制

- 没有版本回退的 CLI（`versions.json` 里有全部记录，回退得手动切目录）
- 不接入构建：发布的是**目录现状**，`vite build` 之类的产物需要先构建再发布
- 中文项目名会进 slug（路径里出现中文，部分老设备 URL 编码可能别扭）
