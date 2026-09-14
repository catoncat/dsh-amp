# Contributing

Thanks for looking. This is a small plugin with an unusually heavy verification habit; the rules
below exist because every one of them has already caught a real bug in this repository's history
(`docs/REVIEW-LOG.md` is the log).

## Ground rules

1. **`bash verify.sh` must be green** before you call anything done. It runs the behaviour suite,
   checks the installed copy against this tree, and prints the hash table a maintainer compares
   after restarting the host.
2. **A behaviour change needs a test that fails without it.** Not "covered by the suite" — a named
   test that goes red when you revert your change. If you cannot write one, say so in the PR and
   explain why.
3. **No new runtime dependencies.** The plugin resolves `@deepseek-ai/dsh-*` from the host install
   and ships nothing of its own (see `test/run.sh`). `node:` built-ins are always fine.
4. **Do not weaken a claim to make a test pass.** If a doc or a tool description promises something,
   either the code does it or the text changes. Both are welcome; a silent mismatch is not.
5. **Never commit credentials, `settings.yaml`, or `state/`.** `.gitignore` covers them; keep it
   that way.

## Getting set up

```bash
git clone https://github.com/catoncat/dsh-amp.git
cd dsh-amp
npm install -g @deepseek-ai/dsh     # or point at an existing install
bash test/run.sh                    # 164 tests, no network, no Amp credits
```

If your harness lives somewhere unusual:

```bash
DSH_NODE_MODULES=/path/to/node_modules bash test/run.sh
```

## What a good PR looks like

- One concern per PR. The commit message says **what was wrong**, not "improve error handling".
- The PR body names the evidence: the test name, the measurement, or the upstream contract
  (`packages/.../src/*.ts:line` in [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).
- If the change affects what a model sees (tool descriptions, diagnostics) or what an operator
  reads (docs), update those in the same PR.
- For anything that touches settlement, cancellation, or account claims, state the interleavings
  you considered. Those three areas have produced every high-severity bug found so far.

## Reviewing

Independent review is welcome and has been productive: eight rounds of it are archived under
`docs/reviews/`, including two rounds where a reviewer **refuted** a fix the maintainer had already
declared complete.
