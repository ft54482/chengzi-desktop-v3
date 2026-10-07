# dsh-plugin-chengzi-aoci

Chengzi Pro integration of [aoci-code](https://github.com/aoci-spec/aoci-code): a per-session-workspace `aoci` agent tool plus a cognition-first system-prompt section.

- **Tool `aoci`** — wraps the aoci-code CLI (whitelisted subcommands) with `cwd` bound to the session workspace, so every repository keeps its own Git-versioned cognition index (`aoci.txt`). The binary is resolved from `AOCI_PATH` or `PATH`; when missing the tool answers `not-installed` with a copyable install guide.
- **Prompt section `chengzi:aoci`** — the agent checks `aoci status` when it first meets a workspace, reads the index when one exists, and proposes building one (never pushes) for substantive unindexed projects.

The CLI is deliberately not bundled: customers install the single binary themselves (FSL-1.1-MIT), which keeps our distribution terms clean. `aoci init` (without `--agent`) writes a managed `AGENTS.md` block that the harness `agent-instructions` plugin already injects per session, so aoci usage rules flow into context with zero extra wiring.
