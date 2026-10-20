# Security policy

Cat-AgentUI is a self-hosted, multi-user AI chat panel maintained by one person. This policy covers vulnerabilities in this repository. It does not describe a bug bounty, an audit, or any previously assigned CVE.

## Supported versions

This repository has no version tags and no GitHub Releases. The only supported line is the latest commit on the `main` branch.

| Version | Supported |
| --- | --- |
| Latest `main` | Yes |
| Older commits and any other branch | No |

The `version` field in `package.json` is not a release. When you report an issue, include the commit SHA of the checkout you tested.

## Reporting a vulnerability

Report suspected vulnerabilities in private. Do not open a public GitHub issue, pull request, or discussion for a vulnerability, and do not post exploit details in public comments.

Preferred channel: [GitHub private vulnerability reporting](https://github.com/Shalistera/Cat-AgentUI/security/advisories/new) (Security Advisories). If that form is unavailable, email [totoria.helmold@gmail.com](mailto:totoria.helmold@gmail.com).

## What to include

Please include:

- The affected version: the commit SHA on `main`, or enough detail to identify the checkout.
- Steps to reproduce.
- The impact you believe the issue has (for example, who can reach data or actions they should not).
- A proof of concept, if you have one.
- Whether you want to be credited or prefer to stay anonymous.

## Response targets

These are best-effort targets for a single maintainer, not a service commitment:

- Acknowledge the report within 3 days.
- Provide an initial assessment within 7 days.
- For a confirmed issue, share a fix or a mitigation plan within 30 days.

A complex fix may take longer. You will be told if the target will be missed.

## Disclosure

Disclosure is coordinated. Please give the maintainer time to ship a fix before publishing details.

Fixed issues are published as GitHub Security Advisories. Where a CVE is appropriate, the identifier is requested through GitHub, which acts as the CVE Numbering Authority. Reporters are credited in the advisory unless they prefer anonymity.

## Scope

### In scope

Vulnerabilities in this repository's own code, including:

- Escape from the command sandbox. Commands run under bubblewrap with `--unshare-all` (separate mount, PID, network, IPC, UTS, and user namespaces, so the command has no network), a read-only `/usr`, and only that chat's workspace mounted read-write. On x64 and arm64 a seccomp denylist blocks symlink creation, `mknod`/`mknodat` (FIFOs and device nodes), mount operations, and namespace operations. When the host's systemd user instance is available, each command also runs in a cgroup with memory, CPU, process-count, and runtime limits.
- Workspace path traversal or symlink bypass. Host-side workspace access walks one path component at a time from an open directory descriptor, uses `O_NOFOLLOW` / `O_DIRECTORY`, and requires a regular file before reading. Writes and sandbox runs share a per-workspace lock. Non-regular entries such as symlinks and FIFOs are removed before and after a command.
- Bypass of MCP tool access control or of the confirmation gate. Each MCP server is shared or granted to specific users, and that check is repeated when a tool is used. Administrators can require confirmation before a server's tools run, and a user can require confirmation before every MCP tool call.
- Prompt injection that drives an unauthorized tool action or exfiltrates data through this application's tools. That includes MCP tools (access is checked again on each call), workspace file tools, sandboxed commands, current-project document tools (`project_search` and `project_read_doc`, which are offered only after `projectAccess` succeeds for that turn), and cross-project library tools (which re-check project access and the per-project opt-in on each call). It also includes bypassing the redaction that keeps configured secrets out of streamed replies, errors, and tool results.
- Authentication, session, CSRF, or rate-limit bypass. Sessions use an HttpOnly, `SameSite=Lax` cookie; the token is stored only as a SHA-256 hash. State-changing requests must send `x-csrf: 1`, and a present `Origin` must match the request host. Login, registration, and password changes are rate-limited. Passwords are hashed with scrypt on a bounded queue.
- Weaknesses in secret storage. Provider API keys, Vertex service-account JSON, custom provider headers, and MCP environment variables and headers are encrypted at rest with AES-256-GCM and are not returned to the browser.

### Out of scope

- Vulnerabilities in third-party model providers, or in upstream dependencies. Report those to the upstream maintainer.
- Issues that require an already-compromised host, or root on the machine running the panel.
- Social engineering of the maintainer or of users.
- Denial of service by volumetric flooding.
- Self-XSS, where a user attacks only their own browser session.
- Missing best-practice response headers, unless you demonstrate a concrete impact.

## Safe harbor

Good-faith research on an instance you run yourself is welcome. Do not test against instances you do not own or administer. Limit access to other people's data to what is necessary to demonstrate the issue, stop if you encounter data you did not expect, and report it without retaining copies. Do not use a finding to disrupt the service or to access data beyond the proof of concept.
