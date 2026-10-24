# Torus Code

Principle packs, automated checks, and a Claude Code plugin that keep AI coding agents true to the design style you choose (security-first, readability-first, long-term maintainability, and so on) **from development through maintenance**.

- Policies are enforced by **mechanisms that run every time**, not by prompts alone: hooks fire at session start, on every request, on every file edit, and when the work ends.
- A principle is "data with a way to check it". Slogans that cannot be checked are not adopted.
- Settings live in `.torus/` inside your repository, and packs are copied into the project with pinned versions, so updating the plugin never changes behavior behind your back.

The design rationale is in [Torus-Code-設計書.md](Torus-Code-設計書.md) and the implementation contract is in [docs/実装仕様.md](docs/実装仕様.md) (both in Japanese). The CLI output and the messages shown inside Claude Code sessions are currently in Japanese as well.

## Requirements

- Node.js 23.6 or later (`.ts` files run directly without a build step; tested on Node 26)
- Claude Code (when used as a plugin)

```bash
npm install
```

## Using it with Claude Code

This directory is the plugin itself.

```bash
claude --plugin-dir /path/to/torus-code
```

The first time you send a message in a code folder that is not configured yet (a git repository, or a TypeScript / Python project), Claude asks you once, before working on your request, which design style to use (primary, secondary, and phase). If you choose "not now", you will not be asked again in that project. The fact that you were asked is recorded in `~/.torus-code/first-run.json`, not in your repository. You are never asked in your home directory itself or in folders without code.

To set up or change the configuration later, use these commands:

| Command | What it does |
|---|---|
| `/torus-code:init` | Choose the primary style, secondary styles, and phase (production / prototype) |
| `/torus-code:style` | Show or change the configuration |
| `/torus-code:check` | Check what you changed and fix violations |
| `/torus-code:audit` | Audit the whole project |
| `/torus-code:explain <ID>` | Show a principle's rationale, how it is checked, and examples |

Once configured, the following happens automatically:

| Layer | When | What |
|---|---|---|
| L0 | At session start (and after context compaction) | Provides the mandatory principles, the prioritized principles, how conflicts are resolved, and the workflow |
| L1 | When you send a request / when a file is first written | Provides steps for the kind of request (bug fix, refactor, new project, feature, tests) and the review points that cannot be checked mechanically for that file. Warns about requests that would likely violate a mandatory principle |
| L2 | Right after a file is written | Static checks. Reports only the violations **introduced by that edit**. Mandatory violations block progress until fixed (up to 3 times for the same violation) |
| L3 | When the work ends | Blocks if mandatory violations introduced in this work remain. If 120 or more lines changed, asks the reviewer agent (`torus-reviewer`) for one review |
| L4 | Any time | `torus audit`, `torus check --changed`, and a git pre-commit hook |

The plugin also includes MCP tools (`torus_principles`, `torus_check`, `torus_explain`, `torus_record_decision`, `torus_styles`) and a workflow skill (`torus-apply`).

If the configuration cannot be read, the session-start hook tells you that automatic checks are stopped and why, instead of failing silently.

## Using the CLI

```bash
bin/torus init --primary security-resilience --secondary maintainable
bin/torus check --changed
bin/torus audit
bin/torus explain SEC-INJ-002
```

Run `bin/torus help` for all commands. Inside Claude Code, the plugin's `bin/` is on `PATH`, so plain `torus` works.

| Group | Commands |
|---|---|
| Configuration | `init`, `styles`, `style` / `style set`, `status`, `principles`, `explain`, `update`, `lock` |
| Checks | `check` (exits with 1 on mandatory violations by default), `audit`, `review-context` |
| Integrations | `export agents-md` (AGENTS.md), `export cursor` (.cursor/rules), `export git-hook` (pre-commit) |

## Design styles (principle packs)

| Pack | Principles | Static rules | Mandatory |
|---|---|---|---|
| `security-resilience` (security and resilience first) | 15 | 42 | 9 |
| `simple-readable` (simplicity and readability first) | 15 | 30 | 0 |
| `maintainable` (maintainability and long-term operation first) | 15 | 32 | 0 |

- Mandatory principles cannot be turned off, whichever style you choose. They also apply when another pack is primary and `security-resilience` is a secondary style.
- Checks run on ast-grep and support TypeScript (`.ts`, `.tsx`) and Python. JavaScript is not supported yet.
- Every rule has tests with examples that must and must not be detected (`npm run test:rules`).

## Configuration files (`.torus/`)

| File | Contents | Commit it? |
|---|---|---|
| `profile.yaml` | Primary and secondary styles, phase, review mode, disabled principles, excluded paths | Yes |
| `lock.json` | Versions and hashes of the packs in use | Yes |
| `packs/` | Packs copied into the project (edit them if needed, then run `torus lock`) | Yes |
| `decisions.md` | Records of principle conflicts and design decisions | Yes |
| `cache/`, `ledger.jsonl`, `audit-history.jsonl` | Cache, work log, and audit history | No (ignored automatically) |

When an exception is truly needed, write it on that line or the line above, with a reason. Exceptions without a reason are ignored.

```ts
// torus-allow SEC-INJ-003: only a fixed string is passed; no external input reaches it
execSync(`git rev-parse ${FIXED_REF}`);
```

## Evaluation

The same requests are given to Claude Code without the plugin (baseline) and with it (torus), and the results are compared. There are six tasks (three TypeScript, three Python). Each has a two-step request, hidden tests for the requested behavior, hidden robustness tests that pass only when the principles are followed, and a reference solution.

```bash
node eval/run.ts --dry-run                      # validate the hidden tests against the reference solutions without calling claude
node eval/run.ts --tasks ts-user-search --reps 1 # actually run claude (in a logged-in terminal)
```

Results are written to `eval/results/<timestamp>/summary.md`. The success criteria are: the violation score is halved or better, the functional pass rate does not drop, and the cost increase stays within 20%.

## Development

```bash
npm run typecheck   # type check
npm test            # unit and integration tests (about 3 minutes)
npm run test:rules  # rule tests for the packs
sh scripts/smoke-plugin.sh  # check that the hooks run in real Claude Code (in a logged-in terminal)
```

## Limitations

- Static checks only find problems written directly in a single expression (they may miss problems that go through a variable). The reviewer agent and the L1 review points cover the rest.
- Thresholds (such as 60 lines per function) are written directly in the rules. To change them, edit the rules in `.torus/packs/` and run `torus lock`.
- The evidence behind the principles is currently limited to references to CWE and existing linter rules. Extraction from public repositories (Phase 3 in the design document) is not implemented yet.

## License

[MIT](LICENSE)
