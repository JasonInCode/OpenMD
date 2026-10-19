# Matt Pocock Engineering Skills 配置

- 本文件是本仓 repo-level 配置的唯一落点：upstream 的 `docs/agents/issue-tracker.md`、`docs/agents/domain.md`、`docs/agents/triage-labels.md` 不创建，对应配置读本文件相应章节。
- 只写本仓特有的路径与偏差，其余语义读 upstream 的 `setup-matt-pocock-skills`（`issue-tracker-local.md`、`domain.md`、`triage-labels.md`）与 `triage` skill。

## Issue tracker

- 固定 **Local Markdown**，不询问用户，不接入 GitHub / GitLab / Jira / Linear。
- 存储根目录为当前 Feature Workspace `.lazy-boss/mattpocock/YYYYMMDD-<feature-slug>/`；`<feature-slug>` 用 kebab-case，同一功能的多个 Session 复用同一 Feature Workspace。
- upstream `setup-matt-pocock-skills` 的 `issue-tracker-local.md` 原样适用，只把其中的 `.scratch/<feature-slug>/` 替换为 Feature Workspace：spec 为 `<feature-workspace>/spec.md`，ticket 为 `<feature-workspace>/issues/NN-<slug>.md`（从 `01` 起编号，一个 ticket 一个文件），对话历史追加到文件末尾 `## Comments` 段。
- `/wayfinder` 的 map 为 `<feature-workspace>/map.md`，child ticket 在同一 `issues/` 目录，`Type:` / `Status:` / `Blocked by:` 行沿用 upstream 约定。

## Triage

- state 角色记在 issue 文件顶部的 `Status:` 行，取值与 canonical role 同名：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`；不引入别名。
- 每个 triaged issue 恰好带一个 category 角色（`bug` / `enhancement`）和一个 state 角色；state 角色冲突时上报维护者裁决，不自行选择。

## Domain Context

- 布局为 single-context。判据：`package.json` 无 `workspaces`，`pnpm-workspace.yaml` 只声明 `allowBuilds` 不声明 `packages`，仓库无 `packages/`；`installer/`、`uninstaller/`、`msix/` 是打包工程，不构成独立 context。
- glossary：`.lazy-boss/mattpocock/CONTEXT.md`（upstream `GLOSSARY.md` 的落位）；ADR：`.lazy-boss/mattpocock/docs/adr/`（upstream `docs/adr/` 的落位）。
- 禁止在仓库根创建 `GLOSSARY.md`、`GLOSSARY-MAP.md`、`CONTEXT.md`、`CONTEXT-MAP.md` 或 `docs/adr/`。
- 探索前读 `.lazy-boss/mattpocock/CONTEXT.md` 与相关 ADR；文件缺失静默继续，不提示创建。
- 输出命名领域概念时用 `CONTEXT.md` 定义的术语，不漂移到 glossary 明确避免的同义词。
- 输出与现有 ADR 矛盾时显式标注来源 ADR，不静默覆盖。

## 不变量

- 不创建或修改仓库根 `AGENTS.md` / `CLAUDE.md` 的 `## Agent skills` 配置块。
- 不修改 upstream Matt Pocock skill 文件本身。
