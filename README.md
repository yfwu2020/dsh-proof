# @dsh-external/dsh-proof

PROOF —— 把本地原型发布到同一局域网内的 iPad，并在设备上自动打开。

当前状态：**骨架 v0.0.1**。只有一个只读工具 `proof_status`（探活 + 局域网地址 + 投放目录状态）；
发布 / 版本 / 构建 / 自动打开等业务逻辑尚未实现。

---

## 构建与注入

```bash
# 构建（需要 DSH 源码 checkout 提供 tsc 与依赖）
bash scripts/build.sh

# 注入器环境内
#   dev_build_plugin  <本目录>
#   dev_inject_plugin <本目录>
```

### 构建环境要求

`scripts/build.sh` 从 `$DSH_CHECKOUT`（或 `~/dsh-harness`、`~/dsh`、`~/.dsh/dsh-harness`）里
链接依赖并调用它的 `tsc`。

如果 checkout **不完整**（例如只有 `packages/core/tools`，缺 `packages/llm` 或
`packages/core/system-prompt`），脚本会**跳过缺失的可选依赖并打印警告**，但
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@types/node`
这四项仍然强校验 —— 缺任何一个直接失败。

---

## ⚠️ 已知坑：不要在工具调用里热重载本插件

**现象**：调用 `dev_reload_package` 重载本插件后，宿主整机挂死 —— 不只是这个工具没返回，
是整个 DSH 无响应，只能重启。2026-10-31 实测挂了 **70 多分钟**才靠重启恢复。

**原因**（注入器文档原文）：

> 工具栈内 `await dispose` 与工具调度器成环，挂死宿主需重启

热重载要在**工具调用栈内部**等旧 fiber 卸载完成，而卸载又依赖工具调度器让出控制权 ——
两者互等，形成环。宿主卡进去之后没有任何超时能救。

**正确做法**：

```bash
# 改完代码后：卸载 + 重新注入，不要用 reload
dev_uninject_plugin  {"match": "dsh-proof"}
dev_inject_plugin    {"dir": ".../dsh-proof"}
```

- `uninject` / `inject` 不涉及 `await dispose`，不会成环；
- 注入是幂等的，重复执行无害；
- 如果只是想确认插件是否已加载，用 `dev_plugin_status`（只读），**不要**用 reload 去“试探”。

**为什么写在这里**：这个坑不是配置问题，是并发模型问题 —— 它不报错、不超时、不留栈，
只留下一个安静的挂死。README 是唯一能让下一个人提前看到的地方。

---

## ⚠️ 已知坑二：`uninject` 会写 `disabled` 条目，挡住下一次注入

`dev_uninject_plugin` 除了卸载 entry，还会往 profile patch 里写：

```yaml
- id: dsh-proof
  disabled: true     # 阻断 bundle patch 自装配，防 refresh 加回
```

之后 `dev_inject_plugin` 创建的同名 entry 会被这条 `disabled` 压住，表现为
**`host ✗` / `[no-fiber]`，且没有任何报错**。

处理：注入前先把这条从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 删掉；
或者干脆用 `dev_install_package`（写 package.json + bundles）后**重启**，走正常装配路径。

---

## ⚠️ 已知坑三：运行时 `loader.create({name})` 解析不到本包

`dev_inject_plugin` 内部是 `ctx.loader.create({ name: pkgName, config: {} })`。
实测该路径**没有真正 import 模块** —— loader entry 里没有 `file://` 行，插件里的启动埋点
一行都不会写（对比：能正常加载的插件 entry 都是 `file:///…/lib/index.js` 绝对路径）。

结论：**运行时按包名创建 entry 这条路对本包无效**，可靠路径是
`dev_install_package` 写进 profile 的 `dependencies` + `dsh.profile.bundles`，
然后**重启宿主**，由启动时的 include 装配加载。

---

## 代码约定

- 资源注册一律挂 `ctx.effect(...)`：fiber dispose 时自动注销，热重载/卸载不残留。
- 工具 schema 精简：description 用短句点明用途，细节放 tool result，别堆进 schema
  （工具目录按字符计入首轮 prefill）。
- 参数选填就**省略** `required` 字段；`required: false` 在类型上不合法（只允许 `true`）。

---

## 目录

```
src/index.ts        插件源码（apply + 工具注册）
scripts/build.sh    构建脚本（链接 checkout 依赖 → tsc）
lib/                构建产物（git 忽略）
```
