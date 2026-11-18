# Self-update recovery / 自更新修复

Stop DSH before repairing an installed package so its auto-updater and HMR do not race the repair.

```sh
node <profile>/node_modules/dsh-remote/lib/self-heal.js
```

The command reads the installed `package.json` version, re-applies the complete package tree and reports the changed file count. Restart DSH afterwards. It does not require a `node_modules/.bin` shim and does not import the broken plugin entry.

For an explicit version or an offline tarball:

```sh
node <profile>/node_modules/dsh-remote/lib/self-heal.js --version 1.2.1 --tarball /path/to/dsh-remote-1.2.1.tgz
```

`--dir <package dir>` selects another installed package root. If `self-heal.js` or `update.js` itself is missing or damaged, reinstall with the package manager instead:

```sh
dsh plugin --profile <profile> add dsh-remote@latest
```

---

先停止 DSH，再修复已安装的包，避免自动更新器或 HMR 与修复并发写入。

```sh
node <profile>/node_modules/dsh-remote/lib/self-heal.js
```

命令读取已安装 `package.json` 的版本，重新应用完整文件树并报告变更文件数。完成后重启 DSH。它不依赖 `node_modules/.bin` shim，也不需要先导入已经损坏的插件入口。

显式指定版本或使用离线 tarball：

```sh
node <profile>/node_modules/dsh-remote/lib/self-heal.js --version 1.2.1 --tarball /path/to/dsh-remote-1.2.1.tgz
```

`--dir <package dir>` 可指定另一个安装根目录。如果 `self-heal.js` 或 `update.js` 本身也已缺失或损坏，请改用包管理器重装：

```sh
dsh plugin --profile <profile> add dsh-remote@latest
```
