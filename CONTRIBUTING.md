# Contributing to dsh-remote

Thanks for taking the time to help. This is a small, focused plugin; the goal is to keep it predictable and safe to point at machines you actually care about.

## Ways to help

- **Bug reports** — open an [issue](https://github.com/flymysql/dsh-remote/issues) with your OS, DSH version, `dsh-remote` version (`npm ls dsh-remote`), the remote host's OS, and the exact steps. Please scrub credentials and hostnames.
- **Questions / setups / "does this work with X?"** — use [Discussions](https://github.com/flymysql/dsh-remote/discussions) instead of issues, so issues stay actionable.
- **Pull requests** — welcome. Small and focused beats large and sweeping.

## Before you open a PR

- One logical change per PR. If you're also fixing unrelated formatting, split it.
- For anything non-trivial (new transport, changed defaults, new config keys), **open an issue first** so we agree on the shape before you write it.
- Keep the diff minimal in unrelated areas — the maintainer reviews these by hand.

## Development

The plugin is sandbox-developed; see the **Development** section of the [README](./README.md) for the local workflow. In short:

```bash
npm ci
npm test                   # must stay green
npm run test:coverage      # union coverage over lib/*.js (see docs/testing.md)
node --check <changed files>
```

Please make sure `npm test` passes before you push. If a test fails on `main` before your change, say so in the PR so we can separate the two.

**Adding a feature? Read [docs/testing.md](./docs/testing.md) first** — it lists which layer a new route / tool / panel needs
(a route that isn't in `routes-matrix.test.js`'s inventory fails the suite on purpose), and the invariants that exist so that a
"green suite" actually means "the UI is usable" (a real SSH server for end-to-end paths, a real-React driver for panels, and the
rule that tests must never touch your real `~/.ssh/config`).

## Style

- Match the surrounding code — indentation, quoting and naming.
- No new runtime dependencies unless there's a strong reason; explain it in the PR description.
- Comments in English in code; the user-facing strings follow the existing zh/en pattern in the UI layer.
- **Do not** reformat files you aren't otherwise changing. Large whitespace-only diffs will be asked to be reverted.
- Line endings: the repo stores **LF**. Do not commit CRLF.

## Things we will not merge

- Anything that silently overwrites remote files or bypasses the conflict / mtime checks.
- Anything that weakens the "connect out, don't expose the harness" model (e.g. a default that binds the Web UI to a public interface).
- Telemetry, analytics, or phone-home of any kind.
- Bundled credentials, keys, or hostnames of real machines.

## Reporting a security issue

Please **do not** open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree your contribution is licensed under the MIT License (see [LICENSE](./LICENSE)).


## Agent and workspace changes

A direct tool-handler test does not prove the Agent loop or conversation UI. For Agent execution changes, run the opt-in real-host harness and Web acceptance described in [docs/testing.md](docs/testing.md), and distinguish scripted-model results from live-model results. Include native/PTC mode, diagnostics, cancellation and file navigation where relevant. Test fixtures must isolate DSH_HOME and SSH configuration and must never write to the contributor's real SSH config.

Start with a minimal reproduction, a small regression test, a documentation fix or a focused patch. Support channels and reporting guidance are listed in [SUPPORT.md](SUPPORT.md). Discussion forms in `.github/DISCUSSION_TEMPLATE` apply to matching enabled category slugs; adding files alone does not configure categories on GitHub.
