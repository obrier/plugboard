# Batch

One connection, many calls, JSONL in and JSONL out:

```bash
plugboard batch --as reader --concurrency 4 < calls.jsonl > results.jsonl
```

Each line is one call:

```json
{"id":"mentions","connector":"slack","tool":"search-public","args":{"keywords":["deploy"]}}
{"id":"today","connector":"cal","tool":"list-events","args":{"calendarId":"primary","startTime":"today","endTime":"tomorrow"},"items":"events","select":"summary"}
```

Each output line is `{"id","ok":true,"ms","result"}` or `{"id","ok":false,"error":{"code","message","retryable","help"?}}`, `help` holding the failure's hints when it has any.

## How it runs

- **Streaming:** lines are read as they arrive and each result is printed when it's done (in input order with `--ordered`), so a producer can feed it while results come back.
- **Failures stay local:** a bad line fails on its own, without stopping the batch. Only a broken session (`UNREACHABLE`) or a model reached (`COST_GUARD`) stops it early: the lines running and those already read fail with it, and it reads no more.
- **Rate limits:** a 429 backs off and drops that connector to one call at a time.
- **Auth failures:** one auth failure fails the rest of that connector's lines at once.
- **Reads only:** batch never runs write tools.
- **A time budget:** `--budget` (5 minutes by default, as `30s`, `500ms` or `2m`) bounds the whole batch; lines not started by then fail with `TIMEOUT`.

A batch where some lines failed exits 7.

## For agents: `--axi`

With `--axi`, batch writes every result in full to its own file and prints a manifest instead of JSON lines:

```
run: ~/.local/state/plugboard/results/b-7f3a2c
results[3]{id,ok,ms,items,tokens,file}:
  today,true,551,4,~420,today.toon
  mentions,true,1376,null,~12K,mentions.md
  labels,false,812,null,null,null
errors[1]{id,code,message}:
  labels,AUTH_REQUIRED,…
inline:
  today: …
help[2]: "1 result(s) not inlined (~12K tokens): read the files you need",…
```

- **Nothing is cut:** text results (Slack, Sentry, Datadog) are written as text, anything else as TOON.
- **Bounded output:** small results go inline up to about 15,000 characters, below the 30,000 at which Claude Code saves Bash output to a file. `--inline none|all|id,id` overrides it. Token counts are estimates.
- **Only the flag:** `PLUGBOARD_AXI=1` and Claude Code sessions keep JSON lines, so `batch | jq` still works.
- **Private:** the folder is `0700`, files `0600`, and runs older than a day are removed by the next run.

A single `--axi` call cuts strings at 1,500 characters; when it does, it writes the full result the same way and its hint names the file.

## From code

The library's `batch()` takes the same calls from any iterable or async iterable. See [From code](library.md#batch).
