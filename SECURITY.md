# Security Policy

## What this plugin does, from a security standpoint

`dsh-remote` connects **out** from your machine to SSH hosts you register, and lets an agent run shell commands there as your user. It deliberately does **not** expose the DSH Web UI on a public interface — that design is intentional (see the README's Safety section).

Practical implications you should be aware of:

- Adding a machine grants the agent **arbitrary command execution as your user on that host** over SSH. Only add machines you trust.
- Credentials (password or key passphrase) are stored **locally** in the machine file, or in the OS keychain when "加密保存密码" is enabled (macOS Keychain / Windows DPAPI / Linux `secret-tool`). If the secure backend fails, the default `credentialFallback: refuse` does not silently save plaintext. Plaintext fallback requires explicitly setting `credentialFallback: plain`; protect that file with appropriate ACLs.
- When `auditLog` is enabled, every executed command is recorded in the audit log; review it from the Settings page.
- Remote files are mirrored into a local workspace. A compromised remote host can therefore influence what lands in your local mirror.

## Supported versions

Only the latest published version on npm receives fixes. If you're on an older version, please upgrade before reporting.

## Reporting a vulnerability

Please **do not** open a public issue.

Report privately via GitHub's [private vulnerability reporting](https://github.com/flymysql/dsh-remote/security/advisories/new) on this repository. If that is unavailable to you, email **flyphp@outlook.com**.

Please include:

- affected version (`npm ls dsh-remote`),
- a description of the impact and the attacker model (who has to do what),
- reproduction steps or a proof of concept,
- any suggested fix.

**Do not** include real credentials, real private keys, or hostnames of machines you do not own. Redact them.

## What to expect

This is a spare-time project, so please allow a reasonable window. You'll get an acknowledgement, an assessment, and — for valid reports — a fix and credit in the release notes unless you prefer otherwise.

## Out of scope

- Misconfiguration on your side (weak passwords, exposing your own SSH agent, adding machines you shouldn't).
- Vulnerabilities in `ssh2`, Node.js, DeepSeek Harness, or the remote host's SSH daemon — please report those upstream.
- Anything that requires an attacker to already have local code execution or your keychain unlocked.
