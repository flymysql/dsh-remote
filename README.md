[English](https://github.com/flymysql/dsh-remote/blob/main/README.en.md) · **中文**

# dsh-remote

[![npm](https://img.shields.io/npm/v/dsh-remote)](https://www.npmjs.com/package/dsh-remote) [![MIT](https://img.shields.io/github/license/flymysql/dsh-remote)](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)

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

[主页](https://flymysql.github.io/dsh-remote/) · [讨论区](https://github.com/flymysql/dsh-remote/discussions) · [反馈问题](https://github.com/flymysql/dsh-remote/issues) · [贡献指南](https://github.com/flymysql/dsh-remote/blob/main/CONTRIBUTING.md) · [贡献者与致谢](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.zh.md#参与贡献与致谢)

由 [@flymysql](https://github.com/flymysql) 与社区共同维护 · [MIT](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
