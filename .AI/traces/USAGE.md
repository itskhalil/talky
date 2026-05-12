# Traces

Local sqlite at `.AI/traces.db` caching every LLM call by
`hash(system + messages + model + params)`. Edit the prompt → hash
changes → auto-invalidates.

```js
callLLM(msg, model, cfg)            // single, cache-first
sampleN(msg, model, cfg, n)         // n fresh calls, always (variance)
```

```sh
node .AI/traces/query.mjs samples <case>   # every run for a case; (DUP) flags identical outputs
node .AI/traces/query.mjs stats            # totals
node .AI/traces/query.mjs show <id>        # full output of one run
EVAL_REUSE=0                                # force fresh on every callLLM (default reuses)
```

## The one gotcha

`repeat: 4` in promptfoo + default cache returns 4 identical hits — you
"measured" zero variance. Either run with `EVAL_REUSE=0`, or drive
variance from a script via `sampleN` (which always runs fresh, even
under `EVAL_REUSE=1`).

If you forgot, you'll see `(DUP)` next to every row in `samples`.
