[English](https://github.com/flymysql/dsh-remote/blob/main/README.en.md) · **中文**

# dsh-remote

[![npm version](https://img.shields.io/npm/v/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dw/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![downloads](https://img.shields.io/npm/dm/dsh-remote)](https://www.npmjs.com/package/dsh-remote)
[![license](https://img.shields.io/github/license/flymysql/dsh-remote)](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

由 [@flymysql](https://github.com/flymysql) 维护 · [主页](https://flymysql.github.io/dsh-remote/) · [用量统计](https://flymysql.github.io/dsh-remote/stats/) · [博客](https://gitpull.cn) · [讨论区](https://github.com/flymysql/dsh-remote/discussions) · [Issue](https://github.com/flymysql/dsh-remote/issues) · [English](https://github.com/flymysql/dsh-remote/blob/main/README.en.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中，把 SSH 主机变成日常开发工作区：浏览远程文件、编辑代码、运行终端，让 Agent 在同一远端完成任务。多个工作区可并行连接不同主机。

**IDE 模式：左侧文件，中间编辑器，右侧原生 Agent 会话。** 可调整栏宽；窄屏切换文件、编辑器与会话。切回普通布局保留任务和未保存编辑。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-ide.png" alt="DSH 远程工作区 IDE 模式：远程文件树、代码编辑器和原生 Agent 会话三栏" width="1200"/>

## 安装

```bash
dsh plugin --profile web add dsh-remote
```

安装或升级后，重启 DSH Web 并刷新页面。自动更新状态在设置 → 远程工作区 → 插件偏好中查看。

## 3 步开始

1. **配置主机**：设置 → 远程工作区，编辑 SSH 配置或保存主机凭据；打开设置会自动检查连通性，无需手动“连接”。
2. **创建工作区**：添加工作区 → 远程，选择主机与目录。每个工作区独立绑定主机，设置页不选目录或“当前远程机”。
3. **开始开发**：打开工作区文件或切换 IDE 模式，在远端编辑、搜索、运行命令并与 Agent 协作。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workspace-picker-browse.png" alt="选择远程目录：固定路径与确认栏，目录列表占据弹窗主要区域" width="720"/>

## 日常开发

### 搜索远端文件与内容

文件、目录和内容递归搜索，无需先展开目录或同步镜像。默认界面只显示搜索范围与进度摘要；按需展开搜索选项、扫描详情，支持大小写、忽略项、停止与重试。点击结果进入目录或文件对应行。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-search-results.png" alt="简洁远程搜索：名称搜索结果包含嵌套目录与文件" width="675"/>

### 查看远端 Git 改动

分别查看工作区和已暂存 diff，筛选文件，点击改动行定位源码。面板只读，不提交或修改暂存区。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-git.png" alt="远端 Git 工作区与已暂存改动、文件列表和源码 diff" width="675"/>

### 在远端运行终端

终端进入当前会话的远程目录；像素鱼欢迎图后接真实 SSH shell。已保存凭据可自动应答，支持多终端并行。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-terminal.png" alt="DSH 远程终端：像素鱼欢迎图与实际 SSH 命令输出" width="1000"/>

### 与 Agent 一起修改和构建

工具卡展示已应用改动、实际退出码和构建输出，编译诊断可跳转源码。编辑器保存会检测远端冲突、保留 CRLF，并保护保存期间继续输入的内容。

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-applied-diff.png" alt="Agent 远程编辑成功后的已应用 diff、路径与增删行数" width="485"/>

## 兼容与边界

- 主要面向 **DSH Web 0.2.x**；0.2.2 需要 **Node.js ≥24.9**。旧版宿主回退、Desktop/TUI 与 Agent diff 差异见[兼容说明](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.zh.md#dsh-版本兼容性)。
- 文件栏直接访问远端；镜像按需同步。草稿在当前页面内存，崩溃或强制退出仍可能丢失。
- 不提供远端语言服务、扩展宿主或调试器。Agent 使用配置的 SSH 身份执行命令，请只配置可信主机。

## 文档与社区

[完整工具与配置参考](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.zh.md) · [排障](https://github.com/flymysql/dsh-remote/blob/main/docs/troubleshooting.md) · [升级指南](https://github.com/flymysql/dsh-remote/blob/main/docs/migration-1.0.md) · [更新记录](https://github.com/flymysql/dsh-remote/blob/main/CHANGELOG.md)

[主页](https://flymysql.github.io/dsh-remote/) · [讨论区](https://github.com/flymysql/dsh-remote/discussions) · [反馈问题](https://github.com/flymysql/dsh-remote/issues) · [贡献指南](https://github.com/flymysql/dsh-remote/blob/main/CONTRIBUTING.md) · [贡献者与致谢](#贡献者与致谢)

由 [@flymysql](https://github.com/flymysql) 与社区共同维护 · [MIT](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)

### 贡献者与致谢

感谢每一位让这个项目更好的朋友（头像可点进主页；按提交数排序，机器人不计）：

<p align="left">
  <a href="https://github.com/flymysql"><img src="https://avatars.githubusercontent.com/u/37113068?s=80&v=4" width="40" height="40" alt="@flymysql" title="@flymysql" /></a>
  <a href="https://github.com/baiseraku"><img src="https://avatars.githubusercontent.com/u/139727690?s=80&v=4" width="40" height="40" alt="@baiseraku" title="@baiseraku" /></a>
  <a href="https://github.com/glzhangzhi"><img src="https://avatars.githubusercontent.com/u/36995275?s=80&v=4" width="40" height="40" alt="@glzhangzhi" title="@glzhangzhi" /></a>
  <a href="https://github.com/hjwsm1989"><img src="https://avatars.githubusercontent.com/u/1067541?s=80&v=4" width="40" height="40" alt="@hjwsm1989" title="@hjwsm1989" /></a>
  <a href="https://github.com/j10ha0"><img src="https://avatars.githubusercontent.com/u/72346906?s=80&v=4" width="40" height="40" alt="@j10ha0" title="@j10ha0" /></a>
  <a href="https://github.com/FoolishWiser"><img src="https://avatars.githubusercontent.com/u/104308087?s=80&v=4" width="40" height="40" alt="@FoolishWiser" title="@FoolishWiser" /></a>
  <a href="https://github.com/kakaa-nju"><img src="https://avatars.githubusercontent.com/u/79886619?s=80&v=4" width="40" height="40" alt="@kakaa-nju" title="@kakaa-nju" /></a>
  <a href="https://github.com/4FMTWRV"><img src="https://avatars.githubusercontent.com/u/190457700?s=80&v=4" width="40" height="40" alt="@4FMTWRV" title="@4FMTWRV" /></a>
  <a href="https://github.com/dahaipeng"><img src="https://avatars.githubusercontent.com/u/25660610?s=80&v=4" width="40" height="40" alt="@dahaipeng" title="@dahaipeng" /></a>
  <a href="https://github.com/davidlin2k"><img src="https://avatars.githubusercontent.com/u/17074619?s=80&v=4" width="40" height="40" alt="@davidlin2k" title="@davidlin2k" /></a>
  <a href="https://github.com/FlintyLemming"><img src="https://avatars.githubusercontent.com/u/19165511?s=80&v=4" width="40" height="40" alt="@FlintyLemming" title="@FlintyLemming" /></a>
  <a href="https://github.com/GDWhisper"><img src="https://avatars.githubusercontent.com/u/129148123?s=80&v=4" width="40" height="40" alt="@GDWhisper" title="@GDWhisper" /></a>
  <a href="https://github.com/YiHui-Liu"><img src="https://avatars.githubusercontent.com/u/30190271?s=80&v=4" width="40" height="40" alt="@YiHui-Liu" title="@YiHui-Liu" /></a>
  <a href="https://github.com/Minggle"><img src="https://avatars.githubusercontent.com/u/35053182?s=80&v=4" width="40" height="40" alt="@Minggle" title="@Minggle" /></a>
  <a href="https://github.com/nekomona"><img src="https://avatars.githubusercontent.com/u/25474483?s=80&v=4" width="40" height="40" alt="@nekomona" title="@nekomona" /></a>
  <a href="https://github.com/shis23"><img src="https://avatars.githubusercontent.com/u/189869650?s=80&v=4" width="40" height="40" alt="@shis23" title="@shis23" /></a>
</p>

<details>
<summary>贡献记录与早期贡献者</summary>

近期的亮点贡献（欢迎随时加入这个名单）：

| 贡献者 | 做了什么 |
| --- | --- |
| [@baiseraku](https://github.com/baiseraku) | 整个 dsh-tui 适配层（[#92](https://github.com/flymysql/dsh-remote/pull/92)）+ 底栏机器名修正（[#98](https://github.com/flymysql/dsh-remote/pull/98)） |
| [@hjwsm1989](https://github.com/hjwsm1989) | 远程 .md 渲染连环两道：memo 守卫（[#102](https://github.com/flymysql/dsh-remote/pull/102)）+ labels 契约（[#107](https://github.com/flymysql/dsh-remote/pull/107)） |
| [@shis23](https://github.com/shis23) | rw_sync 路径映射纠偏 + SFTP 超时韧性（[#105](https://github.com/flymysql/dsh-remote/pull/105)） |
| [@davidlin2k](https://github.com/davidlin2k) | 无凭据机器走用户自有 ssh（[#100](https://github.com/flymysql/dsh-remote/pull/100)） |
| [@GDWhisper](https://github.com/GDWhisper) | 目录补全逐字符重连修复（[#42](https://github.com/flymysql/dsh-remote/pull/42)，issue #41） |
| [@glzhangzhi](https://github.com/glzhangzhi) | 多远端会话的连接池隔离（issue #25 的主体修复） |

早期已合并 PR 的贡献者（考古名单）：



[@dahaipeng](https://github.com/dahaipeng) (#31) ·
[@YiHui-Liu](https://github.com/YiHui-Liu) (#28) ·
[@nekomona](https://github.com/nekomona) (#24) ·
[@zhz1667](https://github.com/zhz1667) (#43) ·
[FoolishWiser](https://github.com/FoolishWiser) (#17) ·
[@jace1cch](https://github.com/jace1cch) (#16) ·
[@Minggle](https://github.com/Minggle) (#10) ·
[4FMTWRV](https://github.com/4FMTWRV) (#6) ·
[glzhangzhi](https://github.com/glzhangzhi)（per-session SSH 连接池修复）

> 名单随版本更新；头像墙之外的每一份 issue 报告、复现步骤、根因线索同样珍贵——
> 本仓库近半修复的起点都是一条写清楚的 issue。

</details>
