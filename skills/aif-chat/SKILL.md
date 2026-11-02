---
name: aif-chat
description: Show AI Factory/AIFHub versions, workflow buttons, selected plan tasks and QA evidence in BB chat. Also inspect existing CI for the selected revision. Use for a workflow status request or at the end of an AI Factory stage.
---

# AI Factory Chat

The persistent **AI Factory** button in the thread header opens the workflow tab in the right panel; on narrow layouts BB moves it into the header menu. Opening this panel only reads status and never dispatches a workflow. Users do not need to find a previous transcript card. The panel follows the owning thread and its stored selection/phase.

Use native tool `aif_chat_status` with the selected project-relative plan/change entrypoint and the phase actually reached (`explore`, `plan`, `improve`, `implement`, `verify`, `fix`, `done`). Emit its `previewDirective` exactly once on its own line, outside code. It renders an interactive card in this chat. Do not repeat unchanged cards. The tool reads files; it never executes workflow commands, tests or installs updates.

CLI fallback:

```text
bb plugin run aif-chat show --target <relative-entrypoint> --phase <phase>
bb plugin run aif-chat status --json
bb plugin run aif-chat check-updates --json
```

The CLI uses the current BB thread; `--thread <id>` is available for an explicit read-only status target. `check-updates` queries the configured GitHub upstream only when requested. Settings: `bb plugin config aif-chat` (`sourceRepo`, `runtime`, `upstreamRepo`, `upstreamRef`, `enabled`). A blank upstreamRef checks the latest stable release.

Treat phase as a declaration, not evidence. Read actual canonical task progress. PASS in a report is not proof of fresh verification. The plugin never edits tasks, generates gate evidence, installs AI Factory or dispatches background workers. Preserve source-of-truth ownership and the selected profile: upstream, AIFHub classic, OpenSpec or legacy ultra. Do not add this directive after a required final gate block or to an exact-handoff-only response.

Buttons send an explicit user-selected command into the same thread. Before executing it, recheck the selected artifacts and project rules. Existing user authorization persists; do not add confirmation ceremonies. Additional unrelated actions are not authorized by one button.

The maintenance controls work independently of plan selection: **Обновить AI Factory** explicitly asks the current agent to update the existing CLI through its owning package manager and then refresh initialized project skills with `ai-factory update`; preserve links, source checkouts and local edits, avoid `--force`, do not start init or implementation implicitly. **Запустить aif** is used without AIFHub; **Запустить aif-analyze** is selected for a healthy installed `aifhub-extension`. A missing setup skill stays disabled. Setup never receives the selected plan as an argument.

## CI subcommand

If invoked as `aif-chat ci`, inspect the existing CI pipeline/run for the current Git HEAD through the project's existing connector/CLI. Report commit SHA, run URL and per-job outcome. Do not generate pipeline configuration, push commits or trigger/retry workflows just to inspect their status. If no provider or run is available, say UNKNOWN/NOTRUN and give the smallest next action. Then refresh the card without inventing a green CI result.

## Delivery recovery

`bb plugin run aif-chat reset` clears only this thread's UI selection/declared phase. `reset-dispatch` clears delivery history only after the user has inspected an uncertain send and explicitly requested recovery. Never reset it automatically or retry an ambiguous message delivery. Project artifacts are unaffected.
