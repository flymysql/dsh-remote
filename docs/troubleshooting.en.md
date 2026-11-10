# Troubleshooting (dsh-remote)

> Moved here from the README: every "fixed" entry carries its root-cause story and
> the design trade-offs. For one-line answers see the [README FAQ](../README.en.md#faq--troubleshooting).

**`@` lists remote files but the built-in read tool cannot open them** — the harness's own file tools see the **local mirror**, which stays empty until `rw_sync` downloads it. Read remote files with `rw_read_file` or the sidebar remote tab.

**A file link in a remote Session does not open** (issue #55) — fixed. When a link is clicked the harness turns it into `dsh-resource://file/session/<session>/<path>` and hands it to the built-in text preview, which reads the **local** filesystem; a remote Session's cwd is a **local mirror directory** (empty until `rw_sync`), so the open simply failed. The plugin now registers a higher-priority handler for that address and opens it over SFTP through the same editor as the sidebar "Remote Files" tab. The safety rule is deliberately conservative: it takes over only when the Session's cwd is **provably inside a mirror** and the mirror registry has loaded, so local Sessions — and the instant right after a page load — keep the built-in preview and no local file is ever mistaken for a remote one. The two cases that still cannot be mapped say so instead of showing a blank page: an address with no mirror mapping, and a Session whose workspace is not a remote mirror directory.

**The sidebar terminal in a remote Session is a LOCAL one** (issue #55, the terminal half) — solved in 0.8.75, no clicks needed. The shell menu has long carried the plugin's **remote ssh** entry: a cwd-aware launcher that ssh'es into the remote workspace when the session sits in a remote mirror and falls back to a local shell otherwise. As of 0.8.75 it also becomes the **default shell**: unless the host administrator configured a default (`config.shell`) or you picked a shell from the menu yourself, "open terminal" in a remote session lands on the remote host directly, while local sessions keep opening a local shell (the launcher routes by cwd). Two safeguards: a shell you picked manually from the menu always wins, and `remoteTerminalDefault: false` restores menu-only behaviour. For a heavier-weight answer there is still the "remote DSH UI" above — your browser opens the remote machine's OWN harness, whose terminals natively run on the far side. To just run one remote command, `rw_exec` (add `pty: true` for an interactive pty).

`.md`/`.markdown` links in a remote session take the same SFTP path and preview in the tab (issue #74). They used to be handed back to the built-in Markdown renderer (issue #64), which reads the local mirror and fails with `ENOENT` until `rw_sync`. The preview is now the remote bytes, rendered with the host Markdown component; builds without that component show the source. Local sessions still use the built-in preview. Images render inline in the sidebar remote tree for png/jpg/gif/webp/svg/bmp (issue #66; files over 2MB fall back to the download button).

**One SFTP timeout wedged every SFTP tool on that machine** (issue #65) — fixed (0.8.52+). A single operation hitting the 20s timeout used to poison the whole process for that machine (every later SFTP call paid its own 20s, while `rw_exec` stayed fine) until a disconnect/reconnect. Now a timeout kills the channel so later requests fail fast; the native backend tears the connection down and re-handshakes after two consecutive timeouts, and the openssh backend rebuilds its sftp child — a transient network blip no longer ends with "disconnect and reconnect". As a bonus, `rw_edit` now writes atomically (temp file + rename), so an interrupted write can no longer truncate the remote file to zero bytes, and the original permission bits are preserved.

**Are remote operations subject to the local sandbox?** (0.8.54+) — yes. They were not before: a local session has `ctx.sandboxPolicy` (read-only / workspace-write / danger-full-access), while every `rw_*` tool ran remote operations with NO policy at all — so a read-only session could still mutate any file on any reachable host. The sandbox was not bypassed; it simply had no say over a different machine. The plugin now applies the same resolved mode at the TOOL boundary:

- `read-only` refuses remote writes, refuses running commands, refuses opening port forwards (reads and connections stay available, or the machine could not even be inspected);
- `workspace-write` requires remote writes to land inside the workspace root (a path fence) and allows commands and forwards;
- `danger-full-access` allows everything.

Why a tool-layer fence rather than `ctx.sandbox.confine()`: the latter wraps argv for a spawn on THIS machine, while our process runs on the far side of an SSH channel — the core docs say so themselves ("remote execution replaces the surrounding capability seam"). A denial therefore carries the OFFICIAL `FS_SANDBOX_DENIED` shape (with the `[sandbox: …]` marker and the escalation hint), so the model's escalation path still works.

**The threat model, stated plainly**: this is CONTAINMENT, not a security boundary (the same wording the official `dsh-fs-sandbox` header uses). Paths are compared lexically, so symlinks and TOCTOU inside the remote host can escape, and once bash runs it holds that user's own privileges. What it does buy: a confined session can no longer change remote files outside its workspace BY ACCIDENT, and a read-only session cannot quietly run commands. Deployments needing a hard boundary must confine on the REMOTE side (containers, per-user accounts, filesystem ACLs). Set `remoteSandbox: 'off'` to disable the fence.

**Does a password land in plaintext when the keychain fails?** (0.8.54+) — by default, no. Previously a failed secure-store write (locked keychain / missing secret-tool / Windows DPAPI without the assembly) fell back to PLAINTEXT in `machines.json` with a warning — you asked for encryption and got something less safe than if you had not asked, and a broken keychain is exactly when nobody notices. The default is now `credentialFallback: 'refuse'`: the password is NOT saved, the machine is still saved without a credential, and the UI reports the store failure. Set `credentialFallback: 'plain'` for the legacy behaviour. Turning encryption off explicitly (`backend: 'plain'`) is unaffected.

**How do I stop picking the wrong machine once I have many?** (0.8.54+) — give machines GROUP LABELS: `environment` (prod/staging…), `location` (shanghai/gpu-lab…), `description`, and `tags` (free-form). They are pure labels and change no connection behaviour. `rw_machines` filters on them (AND across dimensions, OR within a tag list): `rw_machines(environment="prod", tags="gpu")`. An empty result lists the groups that DO exist, so you never have to guess a spelling. The settings page edits them too. Past a dozen machines, "pick the right host" stops being a memory problem.

**What about multi-level bastions?** (0.8.54+) — **multi-hop chains** are supported (OpenSSH `ProxyJump a,b,c` semantics): a bastion may carry its own `proxy`, and the chain is built from the FARTHEST hop inward, each hop dialed through the already-open connection to the previous one. Two constraints matter: credentials do NOT inherit across hops (the target's private key is never presented to an intermediate host — it is usually not authorized there, and handing it over would leak a secret that host should never see), and a chain deeper than 8 hops is reported as an error, which turns a config CYCLE into a clear message instead of unbounded recursion. Each hop may carry its own `privateKeyPath` / `useAgent` / `hostKeyMode`.

**Can I open a remote terminal inside DSH?** (0.8.54+) — yes: an **embedded PTY terminal**. `rw_exec` runs one command and closes — no PTY, no stdin once the writer returns — so `vim`, `top`, a `sudo` prompt or any full-screen TUI is impossible. `pool.shell()` now opens a PERSISTENT PTY channel, and terminal sessions are host-owned: closing the browser does not kill the remote shell (a half-finished vim survives a reload), each session is reclaimed after 30 idle minutes, at most 8 live per process (so a UI cannot exhaust the remote `MaxSessions`), and unloading the plugin hangs up every one of them.

The transport is deliberately boring: the remote session lives on the HOST and the browser POLLS for output deltas (input is a separate request written immediately, so typing never waits for the poll cadence). That avoids depending on whether the host exposes a WebSocket upgrade path. The routes are `/dsh-remote/term/{open,input,output,resize,close,list}`, and each resolves the binding from the SESSION first — a terminal opened on host A can be neither seen nor driven by a request bound to host B.

**The machine's IP / username changed — must every workspace be recreated?** (issue #67) — no (0.8.52+). Edit the machine's new address on the settings page and save, or call `rw_connect(machineId=…, host=…, username=…, port=…)` with the new address: every workspace mirror bound to that machine is **rebound in place** (its `.dsh-remote-meta.json` is rewritten) — local content is kept, no re-sync needed, and the save response says how many mirrors were rebound. The mirror directory name does not follow (live Sessions hold cwd paths inside it); the name is a display label only and does not affect connectivity.

**Remote Sessions could not see the workspace AGENTS.md** (issue #68) — fixed (0.8.52+). The core instruction loader only knows the local filesystem, and a remote Session's cwd is the local mirror, so the remote repo's AGENTS.md never reached the model's context. Now, when `rw_pick_workspace` succeeds, the remote workspace gets a shallow scan (root + at most two levels down, matching `AGENTS.md`/`CLAUDE.md` only); the found files are synced into the local mirror under a three-way guard (root-level copies thus enter the core's own injection path, exactly like a local Session), and an index of paths + headings is rendered into the system prompt, telling the model to read nested instruction files with `rw_read_file` before editing. Full-tree recursion and plugin-side full-text injection are deliberately **not** done (the former would scan through multi-project roots; the latter would run a second injection pipeline in parallel with the core's).

**Does reading a file in a remote subdirectory pull that subdirectory's AGENTS.md into context?** (issue #71) — yes (0.8.53+). #68 fixed only the static half (workspace shallow scan + index line); the dynamic half was still broken, because the core's incremental injection recognizes only `read`/`write`/`edit` with a `file_path` argument — `rw_read_file` matches on neither name nor argument — and it expands scopes using LOCAL paths, so a remote absolute path maps onto no mirror cwd. Any one of those three gaps was enough to stop the injection from ever happening. The plugin now hooks `rw_*` file touches itself on `tools/result`, takes the WHOLE ancestor chain from the touched directory up to the workspace root (not just the deepest level, matching local Sessions: reading `a/b/c.ts` brings in both `a/AGENTS.md` and `a/b/AGENTS.md`), stats each level, and injects the current contents as ONE user message. Boundaries that matter: the cwd's own level is not re-scanned (the core baseline covers it, so reading a file directly in the workspace root triggers no extra scan); delivery is deduplicated per session by content digest, so the same content is injected once; a remote edit is re-injected on the next touch; a previously injected file that disappears produces a "removed" notice; one batch has a 16 KB budget; and an offline machine degrades silently — it hangs neither the tool call nor the prompt assembly. The message carries the plugin's own `source.kind` (`dsh-remote-instructions`), while the core's state machine claims only its own `agent-instructions`, so the two injection paths cannot fight.

**Can `rw_exec` take a per-call timeout, be cancelled, and move to the background like the built-in shell?** (issue #70) — yes (0.8.53+). The transport (`pool.exec`) already supported `timeoutMs` and `AbortSignal`; what was missing was the wiring, and all three pieces are now in place: (1) a `timeoutMs` argument (clamped to 1000-600000, defaulting to `commandTimeoutMs`) whose timeout message prints the value ACTUALLY APPLIED rather than the config value; (2) `exec.signal` is forwarded, so pressing "stop" really SIGTERMs the remote process and returns at once instead of waiting out the timeout; (3) `run_in_background: true` returns a job id immediately (read with the existing `job_output`, stop with `job_kill`), and a command that outlives its timeout is PROMOTED to a background job instead of being killed (`promoteOnTimeout`, on by default). Background execution and promotion need the core `jobs` service; a composition without it (minimal embedding, test double) degrades to foreground-only execution — the 0.8.52 behaviour — rather than failing to load.

**The terminal in a remote Session is still the local one** (issue #55) — that is **by design, and a plugin cannot change it**, but there is an equivalent: DSH's sidebar terminal is core, its PTY comes from the **context-global** `subprocess` service, and its cwd is the Session's own workspace directory (the local mirror for a remote Session). A plugin can neither replace that service nor retarget the core terminal onto SSH. For a **genuine remote terminal** use the "Remote DSH Web UI" (above): it opens the **remote machine's own** DSH in this browser, and that interface's terminal runs on the remote host, with no extra configuration. To run a single remote command instead, use `rw_exec` (add `pty: true` for an interactive PTY).

**The built-in Files panel shows a LOCAL directory?** — not a bug: a remote Session's cwd IS the local mirror under `$DSH_HOME/remote-workspaces/…` (edits and the `rw_*` tools work on that copy, then sync back). For the live remote tree use the **Remote Files** tab — since 0.8.82 it opens automatically when a remote Session comes on screen, in both the better-sidebar and the stock right-column worlds (a settings toggle turns this off). If it did not appear, open "Remote Files" from the right column's guide card once.

**Does the remote terminal still ask for the password?** — no (0.8.81+). A password you saved for the machine (plaintext registry or the OS keychain) is answered through the local credential bridge when ssh prompts; key/agent/`~/.ssh/config`-alias machines never prompted anyway. OTP (keyboard-interactive) machines still ask every time — one-time codes cannot be stored for you.

**Host key changed** — `/remote forget-key` (or Settings → machine → trust again).

**"Authentication failed"** — check the username/password/key path; fill in the passphrase for an encrypted key; enable keyboard-interactive when the host requires OTP.

**Cannot reach an internal machine** — set a jump host (or add the bastion as its own machine first).

**The host only allows GSSAPI/Kerberos (`ssh` works after `kinit`, the plugin does not)** — in Settings → 远程工作区 → Advanced, switch **Backend** to `openssh` (drive the local `ssh`) and tick "use a ~/.ssh/config alias", with Host set to the **alias** in `~/.ssh/config` (not the IP). The login is then performed by your local ssh with your Kerberos ticket, and `ProxyCommand`, `GSSAPIAuthentication` etc. all apply per `~/.ssh/config` — **one source of truth for the configuration** (issues #50/#51). Command-line equivalent: `rw_connect(host="<alias>", useSshConfig=true, backend="openssh")`.

**Can a docker container on the remote host be the workspace?** (issue #56) — Yes, and **no plugin change is needed**. There is no container-specific code anywhere in the plugin, yet the two configurations below already cover the request. Pick by whether the container **publishes a port**:

- **A: the container maps its sshd** (e.g. `docker run -p 127.0.0.1:2222:22 …`) — a plain "jump host" configuration: Host `127.0.0.1`, Port `2222`, the container's user/key, and the **remote host** as the jump host. Why the files really land in the container: `proxy` means "connect to `<host>:<port>` **as resolved by the bastion**" (`lib/pool.js`: `pclient.forwardOut(...this.config.host, this.config.port...)`), and the resulting channel becomes the main connection's own transport (`opts.sock`), so SFTP rides the **container's** sshd — `rw_list_dir`/`rw_read_file`/`rw_write_file`/`rw_sync` all read and write container files. Command-line equivalent: `rw_connect(host="127.0.0.1", port=2222, username="<container user>", privateKeyPath="<key>")`. Requires `AllowTcpForwarding` on the remote sshd (the default).
- **B: the container publishes nothing** — pure `~/.ssh/config` plus the system-OpenSSH backend, on **your** machine:

```sshconfig
Host devbox
    HostName devbox.invalid
    User dev
    IdentityFile ~/.ssh/id_ed25519
    ProxyCommand ssh <remote-host> docker exec -i <container> sh -c 'exec socat - TCP:127.0.0.1:22'
```

  then `rw_connect(host="devbox", useSshConfig=true, backend="openssh")`. Why **both** commands and file operations reach the container: the `openssh` backend hands the alias to `ssh` verbatim and deliberately never emits its own `ProxyCommand` (`lib/openssh.js` omits it so that `~/.ssh/config` decides), while `ssh -s <dest> sftp` and `ssh -- <dest> <cmd>` travel the same stream. Requires an sshd inside the container plus `socat` (or an `nc` that speaks stdio).
  ⚠️ **A Windows caveat**: POSIX OpenSSH shell-expands `ProxyCommand`, but **Windows' own OpenSSH 9.5 does not** (measured: it passes the whole string through as literal argv). So on a Windows host either keep the `ProxyCommand` a single command with no shell metacharacters, or point "ssh path" at Git Bash's `ssh.exe`. (Also: whether `docker exec -i` carries binary data byte-for-byte is unverified here — no docker on this machine — so try a small file with B first.)

**`rw_sync`/`rw_push` reports conflicts** — files changed on both sides are skipped and listed (never silently overwritten); merge manually and retry, or pass `force=true`.

**Windows remotes** — everything goes over SFTP, no POSIX shell needed; read Chinese files with `encoding=gbk`.

**A directory is missing from the mirror** — the default ignore rules skip `.git`/`node_modules` and similar; adjust `$DSH_HOME/remote-workspaces/.dsh-remote-ignore` (gitignore syntax).

**Saving a remote file returns 409** — the remote file changed after you opened it; re-read and edit again.

**How are passwords stored?** — tick "encrypt password": macOS Keychain / Windows DPAPI / Linux secret-tool (libsecret); falls back to plaintext when unavailable.

**Why is the password box empty (where are the stars)?** — No secret is ever sent back to the browser, so the input stays empty; when a password IS saved its placeholder reads
`•••••••• (saved — leave blank to keep)` with a hint underneath. Saving with an empty box keeps the stored password; typing a new value replaces it. Same for the private-key
passphrase and the jump-host password. The password badge in the machine row means exactly this (a keychain-stored password counts as saved).

**Which password does "Test connection" use?** — The form in front of you, but a blank password / key / passphrase **falls back to the value saved for that machine**, so
"edit a machine that already connects → click test" now works (the success line says the saved password was used). After saving, the form stays bound to that machine so you can
test immediately; press "Cancel edit" to start over.

**"No credentials" even though you filled it in** — the password never actually landed on disk: when "encrypt password" is ticked and the OS store is unavailable the plugin
**refuses** to write plaintext and reports a warning (`credentialFallback` defaults to `refuse`). Look for the red warning after saving, fix the store and save again, or use
"Test connection" to verify on the spot. A machine with no password / key / agent is flagged in amber right inside the form.

**"SSH agent unavailable"** — the machine has "use SSH agent" ticked but the DSH host process has no `SSH_AUTH_SOCK` (Windows has no agent service by default). Start an agent
(and export `SSH_AUTH_SOCK`, or use Pageant) before launching DSH — or untick it and save a password / private key instead.

**The plugin vanished after a DSH upgrade** — DSH's compatibility check dropped the bundle; upgrade to **0.8.29+** (see "DSH version compatibility" above).

**"Remote DSH Web UI" will not connect / spins forever** — first check that `dsh web` starts on that
machine *at all*. Two known traps (the plugin names them in its error):
1. **dsh 0.1.0-rc.6 cannot start the web surface on Linux** — the `node-pty@1.1.0` it depends on ships
   macOS/Windows prebuilds but **no `linux-x64`**, so it fails with `Failed to load native module:
   pty.node`. Upgrade to 0.1.5-rc.2+ (its `node-pty@1.2.0-beta.15` ships the Linux build).
2. **dsh 0.1.0-rc.6 does not know `--no-open`** (the flag came later); the plugin drops it and retries
   once automatically, so there is nothing to do.
If the remote `dsh` is not on the SSH login PATH (a private prefix, say), point `webAttachCommand` at
its absolute path.


---

## "Open the remote DSH UI" fails to connect

**A failed connect is usually not the plugin's fault: the remote dsh is missing or too old.**
The classic case: dsh 0.1.0-rc.6 depends on `node-pty@1.1.0`, whose published package ships
**no `linux-x64` prebuild**, so `dsh web` cannot start on Linux at all.

The plugin no longer installs or health-checks dsh for you. Install it on the remote the way you
install anything else, then point the plugin at it: Settings → Remote workspaces → the machine row →
**Edit** → Advanced → **remote dsh command** (or the global `webAttachCommand`).

