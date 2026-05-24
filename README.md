<p align="center">
  <a href="https://github.com/anomalyco/opencode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent — stable fork with bug fixes and token optimizations.</p>

> **Stable Fork** — This is a community-maintained stable fork based on [opencode](https://github.com/anomalyco/opencode) **v1.14.41**, with critical bug fixes, prompt optimizations (~3300 tokens saved per request), and quality-of-life improvements. See [Changes from upstream](#changes-from-upstream) below.
>
> ⚠️ This fork is **not** affiliated with, endorsed by, or connected to the opencode team. For the official project, see [anomalyco/opencode](https://github.com/anomalyco/opencode).

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-stable"><img alt="npm" src="https://img.shields.io/npm/v/opencode-stable?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode"><img alt="upstream" src="https://img.shields.io/badge/upstream-v1.14.41-blue?style=flat-square" /></a>
</p>

---

### Installation

```bash
# This fork (stable)
npm i -g opencode-stable           # or bun/pnpm/yarn

# Official opencode (upstream, latest)
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
```

<details>
<summary><strong>Other installation methods (upstream only)</strong></summary>

```bash
# curl install script (installs upstream, NOT this fork)
curl -fsSL https://opencode.ai/install | bash

# Package managers (upstream)
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux
brew install opencode              # macOS and Linux (official brew formula)
sudo pacman -S opencode            # Arch Linux
paru -S opencode-bin               # Arch Linux (AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode
```
</details>

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Changes from upstream

This fork tracks **opencode v1.14.41** and applies the following patches:

#### Bug Fixes

| # | Description |
|---|-------------|
| 1 | Handle GLM-5.1 `model_context_window_exceeded` error as context overflow instead of crashing |
| 2 | Break infinite compaction loop after 2 consecutive attempts (prevents token waste) |
| 3 | Allow ESC key to interrupt through permission dialogs |
| 4 | Prevent session DB bloat from per-message diffs |
| 5 | Fix TUI timestamp locale detection and snapshot diff display |

#### Optimizations

| # | Description | Savings |
|---|-------------|---------|
| 6 | Trim `todowrite.txt` prompt (8845 → 854 chars) | ~2280 tokens/req |
| 7 | Trim `task.txt` prompt (3732 → 1158 chars) | ~736 tokens/req |
| 8 | Trim `default.txt` prompt (8661 → 7638 chars) | ~292 tokens/req |

Total token savings: **~3300 tokens per request**.

#### New Features

| # | Description |
|---|-------------|
| 9 | `pluginAutoInstall` config option + `OPENCODE_DISABLE_PLUGIN_INSTALL` env var to control plugin auto-installation |
| 10 | `disableQuestionTool` config option, session ID in sidebar, improved todowrite rules |

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Documentation

For configuration and usage, see the [upstream docs](https://opencode.ai/docs).

### License

[MIT](./LICENSE) — same as upstream opencode.
