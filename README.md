# PROOF — 本地原型工作台

把本地原型发到同一局域网的 iPad 上，按类型归档，刷新即见。

v0.3.0 起是**文件管理模式**：**一次发送 = 一个项目，不留版本历史**。同名重发即覆盖。

- 发一个目录或文件 → 落到 `<root>/f/<slug>/` → 重写首页 `data.json`
- 项目页 = 该项目的**文件浏览器**，按类型分类：网页 / 图片 / 视频 / 文档 / 产物 / 文件
- 根路径 `/` 直接 302 到首页；没有收件箱

## 四个工具

| 工具 | 作用 |
|---|---|
| `proof_status` | 服务状态、局域网地址、已发布项目与断链情况（只读；不会拉起服务） |
| `proof_send` | 发送目录/文件到 iPad（同名覆盖），自动起服务。`mode: "link"`（默认）建软链接不复制；`mode: "copy"` 真复制一份 |
| `proof_remove` | 删除一个已发送的项目 |
| `proof_serve` | 手动 `start` / `stop` / `status`（发送时会自动启动） |

发送语义：

```
mode=link（默认）   <root>/f/<slug>/ 里逐条建软链接 → 源码，不复制，改完刷新即见
mode=copy           <root>/f/<slug>/ 是真复制（跳过依赖/构建缓存/点文件/密钥，见下）
        ↓
<root>/data.json    项目清单与文件树（界面读它）
```

**界面不复制进投放目录。** 服务器按路径映射：

| 路径 | 来自 |
|---|---|
| `/` | 302 → `/proof/home-v1/` |
| `/proof/home-v1/*` | 包内 `ui/*`（随插件升级） |
| `/data.json` | `<root>/data.json`，每次请求实时重算 |
| `/f/*` | `<root>/f/*` |

`/data.json` 是实时视图，不是静态文件：每次请求都会重算 link 项目的断链状态与文件清单（大小、mtime、类型、合计）。

### link 模式的文件清单

link 项目里放的是软链接，所以 `items.json` 里记的大小只是**发送那一刻**的快照。源文件改过之后：

- **界面**：`/data.json` 每次请求按源文件现扫，大小/类型/合计立刻是新值；
- **工具**：`proof_status` 调用时会把过期的清单写回 `items.json` 与 `data.json`。

两处规则一致：跟随软链接、跳过 `node_modules`/`.git`/`.proof`/`.DS_Store`、最多 400 条、深度 8 层。

### 护城墙（软链接模式的必要配套）

以下一律 404，源码目录不会被 HTTP 暴露出去：

- 任何**点文件/点目录**：`.env`、`.npmrc`、`.git`、`.ssh`、`.vscode` …
- 依赖与缓存目录：`node_modules`、`__pycache__`、`venv`、`.venv`、`.next`
- 密钥类扩展名：`.pem`、`.key`、`.p12`、`.pfx`、`.keystore`

（0.5.1 起：此前只拦了 `node_modules`/`.git`，`.env`、`.npmrc` 能被直接下载，已封堵。）

发送时同样跳过这些，不让它们进投放目录：`node_modules`、`__pycache__`、`venv`、`.venv`、`.next`、`dist_node`、任何点开头的条目、`.pem/.key/.p12/.pfx/.keystore`。copy 模式因此不会把 `.env` 或构建缓存真抄一份进 `f/`；`dist/` 这类**构建产物是正常内容，照发**。

### 不留垃圾（0.7.5）

发送/启动路径都按“要么成品、要么什么都没有”处理：

- **原子发送**：先在 `f/.tmp-<slug>-<pid>` 里搭好，成功才 `rename` 到 `f/<slug>`。中途失败只会清掉暂存目录，不会留下半个项目，也不会先毁掉上一次的成品。
- **崩溃残留自清**：崩在 `rename` 之前的 `.tmp-*` 目录，下次发送时把超过 1 小时的清掉（点开头，护城墙也不让 HTTP 访问）。
- **状态文件不撒谎**：`server.json` 只在服务确认起得来之后才写；启动失败会顺手 SIGTERM 掉子进程。端口没监听时 `proof_status` 会清掉陈旧的 `server.json`。
- **测试不留尾**：每个用例用 `t.after` 收尸（临时 root + 后台服务），断言失败也照删，`npm test` 不在系统临时目录里留东西。

## 访问入口

- `http://<ip>:8321/` → 302 → 首页
- `/proof/home-v1/` → 首页（项目数、文件数、占用、按类型、最近发送）
- `/proof/home-v1/projects.html` → 全部项目
- `/proof/home-v1/project.html?p=<slug>` → 项目页（文件浏览器 + 可预览文件的实时预览）
- `/proof/home-v1/files.html?kind=<kind>` → 按类型的文件列表
- `/proof/home-v1/design.html` → 界面规范（色板/组件）
- `/f/<slug>/` → 项目内容本体，直接打开

服务由插件以 detached 子进程拉起（`python3 server.py <root> <port> <idleMinutes> <activityFile> <uiDir>`），每 30 秒检查一次活动时间，空闲超过 `idleMinutes`（默认 60）自动退出。

## 构建与验证

```sh
bash scripts/build.sh   # 建 node_modules 链接 + tsc 编译 src → lib
npm test                # node --test smoke-test.mjs（4 个用例，真实 HTTP）
npm run typecheck
```

测试只走公开工具面和真实 HTTP，不 mock 服务端：工具是否齐、未运行是否报未运行且不自启、发送后页面可达、link 大小是否实时、护城墙是否 404、删除是否生效、坏路径是否报错。

在 DSH 中调用 `proof_status {"verbose":true}`。成功验收的条件是插件 active、四个工具已注册，且实际调用返回状态。服务未启动时报告「未运行」是正常结果；`proof_status` 不会启动服务器。

## 数据与代码放哪

**未配置 `root` 时默认落在 `~/.proof`** —— 每个用户各自的 home 下，装上就能用：

```
~/.proof/                     ← 只有用户数据
├── f/<项目>/                 软链接或副本
├── data.json                 项目清单（界面读它，按请求实时重算）
└── .proof/
    ├── items.json            项目登记（发送时的文件清单快照）
    └── server.json           服务进程状态（服务没在跑时会被清掉）

dsh-proof/                    ← 代码和界面只有这一个地方
├── src/index.ts             插件源码（四个工具）
├── server.py                静态服务（按需启动、空闲自停）
├── ui/                      界面（直接映射，改完刷新即生效）
├── smoke-test.mjs           冒烟测试
└── cordis.patch.yml         bundle 装配声明（port / root / idleMinutes）
```

`cordis.patch.yml` 里**不写绝对路径**；要换位置再显式填 `root`。

`lib/` 是构建产物、`node_modules/` 是链接，都在 `.gitignore` 里；`ui/` 是**源码，纳入 git**。

## 安装

安装必须针对**当前运行**的 profile（桌面版是 `~/.dsh/profiles/desktop`；旧 `web` profile 里的登记不会让桌面版加载插件）。

持久安装需要同时具备：

- 当前 profile 的 `dependencies` 里有本地包依赖（`link:<本目录>`），`dsh.profile.bundles` 里有包名；
- 当前 profile 的 `node_modules` 里有正确链接；
- 本包 `package.json` 的 `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`；
- `lib/index.js` 已构建。

热装配走 `dev_install_package`，改完源码后 `dev_reload_package` 即可生效（不需要重启宿主）。

## 故障排查

先 `dev_plugin_status` 看插件是否 active，再调用 `proof_status`；不要用重载探测一个从未激活的插件。

- **工具不存在**：插件没装配或被 disable —— 查 profile 的 `bundles` 与 `node_modules` 链接。
- **状态「未运行」**：正常。发送一次或 `proof_serve {"action":"start"}`。
- **页面 404**：确认 `/f/<slug>/` 存在；link 项目源目录被删会显示「链接失效」。
- **改了源文件但页面没变**：硬刷新；大小类信息由 `/data.json` 现算，内容由浏览器缓存决定。

热重载超过 6 秒应返回「已转后台」的警告，再用状态查看收口结果；警告不代表已成功。

## 已知限制

- 中文项目名会进 slug（路径里出现中文，部分老设备 URL 编码可能别扭）
- 不接入构建：发布的是**目录现状**，`vite build` 之类的产物需要先构建再发布
- 没有版本回退：文件管理模型下只有「当前这一份」，历史版本不在设计内
- 文件清单上限 400 条、深度 8 层（防软链接环）
