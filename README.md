# dsh-amp

Run the local [Amp](https://ampcode.com) CLI as a **subagent provider** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — plus a second,
steerable path that keeps an Amp process alive across turns.

> Unofficial community adapter. Not affiliated with, endorsed by, or supported by Amp/Sourcegraph
> or DeepSeek. It drives the `amp` binary you already have installed.

| | |
|---|---|
| Language | JavaScript (ESM, no build step, no runtime dependencies of its own) |
| Host | DeepSeek Harness `0.1.5-rc.x` |
| External binary | `amp` CLI (`amp --version` must work) |
| Tests | `bash test/run.sh` — 164 behavioural tests, no network, no credits |
| License | MIT |

---

## What it gives you

**1. One-shot delegation — two tools, one per Amp mode.**

```
subagent_amp_low        subagent_amp_medium
```

They are ordinary `ctx.subagents` providers, so they behave like every other delegation in the
harness: the child runs out of process, the parent gets a result, the run is disposable. Amp modes
map to provider names (`amp-<mode>`), and the preset decides which of them the model can see.

**2. A steerable session — four tools.**

| Tool | What it does |
|---|---|
| `amp_run` | Starts an Amp process on a task and returns immediately with a run handle. |
| `amp_send_message` | Sends one more message: steering while the child is busy, a new turn while it is idle. Also returns everything produced since the previous read. |
| `amp_stop` | Ends the run and returns its output. |
| `amp_runs` | Lists runs that left a record on disk — the rescue surface after a crash or restart. |
| `amp_accounts` | Balances, which account the next dispatch would take, and the fingerprint of the loaded build. |

The run **stays open** after a turn ends: the delegating agent is notified and can keep talking to
the same child, or stop it and collect everything.

**3. Account pool with balance awareness.** Each Amp credential ref in
`~/.dsh/settings.yaml` is a pool entry. Dispatch skips accounts that are throttled or out of
headroom, remembers refusals for their own window, and never silently falls back to the machine's
`amp login` account (a run whose credential cannot be resolved is **refused**).

**4. Durable records.** Every live run appends a redacted stream plus a checkpoint under
`$DSH_HOME/state/dsh-amp/runs/`, so a killed or crashed run is still readable — and `durability`
is reported honestly when a record is incomplete.

## Requirements

- DeepSeek Harness with a `subagents` registry, a `subprocess` service, `credentials`, and (for the
  live path) the **jobs** row. The live tools refuse to start a run on a host without jobs.
- The Amp CLI on `PATH` (or `ampBin` pointing at it).
- One or more Amp credential refs in `~/.dsh/.credentials.yaml`.

## Install

```bash
# 1) clone somewhere permanent
git clone https://github.com/<you>/dsh-amp.git ~/.dsh/plugins/dsh-amp

# 2) point your profile at it (this is a DSH bundle)
cd ~/.dsh/profiles/<profile>
npm install --save ~/.dsh/plugins/dsh-amp

# 3) grant the tools in an agent preset (agent plane), and add the host row
```

The bundle contributes a **host-plane row** (`cordis.patch.yml`): it registers one
`amp-<mode>` subagent provider per configured mode, provides the `ampAccounts` service, and
registers the `dsh-amp` settings namespace. It deliberately does **not** grant the model-facing
tools — `subagent_amp_*` and the `amp_run` family belong in an agent preset, exactly like the
shipped `tool-subagent` rows.

Mode list:

```yaml
# cordis.patch.yml (this repo)
- insert:
    - id: amp
      name: 'dsh-amp'
      config:
        modes: [low, medium]
```

## Configure

Everything below lives in the `dsh-amp` section of the settings UI (or `settings.yaml`):

| Key | Default | Meaning |
|---|---|---|
| `accountRefs` | `[AMP_API_KEY_1]` | Credential refs that make up the pool, in preference order. |
| `modes` | `[low, medium, high, ultra]` | Which providers to register. **Changing this needs a restart**: tool schemas pin the enum at mount. |
| `ampBin` | `amp` | The executable to run. |
| `visibility` | `private` | Passed to `amp --visibility`. |
| `keepThreads` | `true` | Pass `--no-archive-after-execute` so the thread stays addressable for audit. |
| `liveIdleTimeoutMs` | `1200000` | Idle bound after which the sweeper closes a forgotten run. |
| `graceMs` | `10000` | Termination grace handed to the subprocess seam. |

## Testing

```bash
bash test/run.sh     # 164 tests; fakes the DSH seam, never touches your real ledger
bash deploy.sh       # copy this tree into the installed profile copy, with hashes
bash verify.sh       # tests + drift + the hash table to compare after a restart
```

The suite needs the DSH packages (`@deepseek-ai/dsh-tools`, `-llm`, `-subagent`, `schemastery`)
to resolve. It finds them from a global DSH install; override with:

```bash
DSH_NODE_MODULES=/path/to/@deepseek-ai/dsh/node_modules bash test/run.sh
```

## Operating notes (read before trusting a deploy)

- **A plugin edit changes nothing until the host restarts** — the bundle is loaded in-process as a
  real copy under `profiles/<name>/node_modules/dsh-amp`. `deploy.sh --check` says `in-sync`
  even when the *running* process still holds the previous build. The only proof of what is loaded
  is the runtime fingerprint: `amp_accounts.source.hash` (host plane) and `amp_run.source.hash`
  (agent plane).
- **Notifications are the point.** The plugin mirrors the host's per-agent wake budget: up to three
  consecutive wakeups, then it degrades to an in-step `inject` instead of dropping the notice.
- **Balance figures come from `amp usage`**, which costs nothing and starts no agent; a probe has a
  real 20s deadline and a failed read is treated as *unknown*, never as zero.
- **Known limits** are listed in [`docs/USABLE.md`](docs/USABLE.md) §3 — including that Amp has no
  turn-level cancel (stopping ends the run) and no non-interactive thread continuation, so
  continuing means reading the artifact and starting a new run.

## Documentation

| File | Contents |
|---|---|
| [`docs/USABLE.md`](docs/USABLE.md) | What works, how to read a notice, and the honest boundary list. |
| [`docs/AMP-LIMITS.md`](docs/AMP-LIMITS.md) | Measured upstream behaviour (floors, rate-limit window, cost samples) with evidence strength. |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Why the plugin is shaped this way. |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Every batch, with the test or measurement each change rests on. |
| [`docs/REVIEW-LOG.md`](docs/REVIEW-LOG.md) | The disposition of every finding from eight review rounds. |
| [`docs/reviews/`](docs/reviews/) | The review reports themselves. |

> The engineering docs are written in Chinese; the code, comments, and commit trail are English.

## Security

- The Amp token is read from a **DSH credential ref** at dispatch time and injected as
  `AMP_API_KEY` on one child process. Credential-shaped ambient variables are scrubbed by the
  subprocess seam before that merge.
- Token-shaped literals are redacted on their way into transcripts, diagnostics, and the on-disk
  run record.
- The account view is a loopback-only JSON route that also requires a matching `Host`/`Origin` and
  the plugin's own header.
- Never commit `.credentials.yaml`, `settings.yaml`, or `state/` — `.gitignore` covers them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `bash verify.sh` must be green, and a
behaviour change needs a test that fails without it.

## License

MIT — see [LICENSE](LICENSE).
