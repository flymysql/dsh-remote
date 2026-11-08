# D · allowBuilds 双写入器腐坏（pnpm-workspace.yaml）｜Competing writers corrupt `allowBuilds` with duplicate keys

- 状态 Status：DRAFT，2026-11-08，待终审后投递
- **投递渠道＝Discussions/Ideas（主仓 issues 关闭）**：`deepseek-ai/deepseek-harness` `has_issues=false`；Discussions 开启
- Target：`deepseek-ai/deepseek-harness` → npm `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`
- Reporter project：[`flymysql/dsh-remote`](https://github.com/flymysql/dsh-remote)（现场：[issue #94](https://github.com/flymysql/dsh-remote/issues/94)，OPEN）

---

## 现象｜Observed

**中文**：用户 `dsh plugin add github:flymysql/dsh-remote` 安装失败，pnpm 报 `duplicated mapping key (17:3)`。损坏的是**宿主 profile 的** `<profile>/pnpm-workspace.yaml`，其 `allowBuilds` 同时含有（引自 #94 原文）：

```yaml
14 |   koffi: false          # 裸 key
17 |   "koffi": true         # 带引号 key（同行块还有 "@google/genai"/"node-pty"/"protobufjs" 均带引号）
```

此后该 profile 上**任何** `dsh plugin add` 都在依赖解析阶段死掉。

**English**: An install died on pnpm's `duplicated mapping key (17:3)`: the harness profile's `pnpm-workspace.yaml` carried BOTH a bare `koffi: false` and a quoted `"koffi": true` in `allowBuilds` (quote pasted from [#94](https://github.com/flymysql/dsh-remote/issues/94)). Every subsequent `dsh plugin add` in that profile fails during dependency resolution.

## 证据与分析｜Evidence & analysis

管理器侧（`@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`，npm pack 解开 `lib/types/build-approval.js`；同代码内联于 `lib/index.js:1210-1269`）：

- `build-approval.js:24-51` — `readPolicy()`：`yaml` 库 `parseDocument` 往返解析；**有任何解析错误即抛**（`:35-36`）；禁 anchors/aliases（`:42-46`）；key 按**标量值**收集（`:47-50`）。
- `:62-72` — `recordPendingBuilds()`：先按值去重（`known.has(name)`，`:64-65`）再 `document.setIn(['allowBuilds',name], UNDECIDED)`（`:69`），`writeFileAtomic` 0600 落盘（`:70`）。
- `:89-98` — `approveBuilds()`：`setIn(...,true)`（`:96`）原子写（`:97`）；JSDoc（`:84`）注明"调用方持有 profile manifest 锁"，但 `recordPendingBuilds` 无此注。
- 推论（单写入器不可能造出双格式重复）：`yaml` Document 往返保留原有样式；`setIn` 新建的 key 是普通标量 ⇒ 写出来必是裸 `koffi:`；且去重按**值**比较（引号与否不影响）。所以这个模块自己永远不会同时写出 `koffi: false` 和 `"koffi": true`。**必然存在第二个写入器**，用着不同的序列化器（怀疑面：GUI 审批对话框/另一个审批链路/旧的 alpha 版写入逻辑/用户照着提示手工编辑）。
- **放大效应（本次新增要点）**：`yaml` v2 默认 `uniqueKeys` 严格 ⇒ 文件一旦出现重复 key，`readPolicy()` 在 `:35-36` 每次都抛——**管理器在这个 profile 上永久卡死且无法自愈**：它既不能读、也就永远没机会把文件修好；用户只能手工定位并编辑 yaml。且报错把矛头指向"正在被安装的插件"（#94 报告者据此认定是 dsh-remote 的包配置坏了），生态信任连带受损。

## 影响｜Impact

**中文**：一次坏写 ⇒ profile 级砖化：所有插件装/卸/更新全灭，恢复要靠用户徒手修 YAML；报错文案误导性强（怪罪无辜插件）；只要第二写入器没被找出来，腐坏还会持续散发。

**English**: One bad write bricks the profile for every plugin install/remove/update; recovery means hand-editing YAML; the error message frames an innocent plugin; and until the second writer is found, corruptions will keep occurring.

## 诉求与建议方向｜Ask & suggested fix

1. **枚举全部写入器**：清点所有会写 `<profile>/pnpm-workspace.yaml` `allowBuilds` 的代码路径（CLI 审批、GUI 对话框、模板/迁移、测试夹具……），收敛到**单一写入器+单一序列化器**（同一个 `yaml` Document 往返 + 按值 upsert）。／ Enumerate every writer of `allowBuilds` and funnel them through one serializer with value-level upsert.
2. **读取端容忍自愈**：`readPolicy` 遇重复 key 时不要抛死，按确定规则（如 last-wins）合并后继续，并在下一次原子写回中自然清掉重复——让腐坏 profile 跑一次即愈，而非永远砖化。／ Make `readPolicy` tolerate duplicate keys (deterministic last-wins merge) so a corrupted profile self-heals on the next run.
3. 顺手可做：提供 `dsh plugin doctor`（或等价物）一键体检/修复 profile yaml；并为"写入前后各做一次严格 parse"加回归测试。／ Optionally a doctor command, plus regression tests asserting strict-parse cleanliness after every write.

## 复现与佐证｜Repro & links

- 最小复现：往某 profile 的 `pnpm-workspace.yaml` 手工写入上文两种格式的 `koffi` 各一行 ⇒ `dsh plugin add <anything>` 立即报 `duplicated mapping key`，且此后管理器对该 profile 的所有操作同错（自愈不存在）。
- 现场：<https://github.com/flymysql/dsh-remote/issues/94>（OPEN；DSH 0.2.2-rc.1 / pnpm v11 / Windows）。
- 上游：<https://github.com/deepseek-ai/deepseek-harness>（Discussions 开启）；npm `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`（`lib/types/build-approval.js`）。
