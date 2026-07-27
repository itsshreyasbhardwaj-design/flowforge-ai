# Observability

Every metric on the dashboard is derived from stored `RunTrace` records. There is
no separate metrics pipeline, no counters to drift, and no sampling — the numbers
you see are computed from the same traces you can open and inspect.

## What is measured

| Metric                | Derived from                                         |
| --------------------- | ---------------------------------------------------- |
| Success rate          | `trace.status`                                       |
| p50 / p95 latency     | `trace.durationMs`                                   |
| Token and cost totals | `trace.usage`, summed across nodes                   |
| Hourly volume         | Bucketed `createdAt`                                 |
| Node hotspots         | Per-node `durationMs`, as a share of total node time |
| Provider usage        | Per-node `usage.model` and `usage.provider`          |
| Grouped errors        | Node errors, normalised to collapse ids and numbers  |

## Reading it

**Time share, not average latency, identifies the bottleneck.** A node averaging
200 ms that runs on every path costs more total time than one averaging 2 s that
runs on one branch in twenty. The hotspot list is sorted by share of total
execution time for exactly this reason.

**Error grouping collapses noise.** `normalizeErrorMessage` replaces UUIDs,
prefixed ids, and any 3+ digit number with placeholders, so `timeout after 5000ms`
and `timeout after 9000ms` count as one problem rather than two.

**Watch cost per run, not total cost.** Total spend rising because volume rose is
expected. Cost _per run_ rising means a prompt grew, retrieval started returning
more context, or an agent started iterating more.

## Full-scan aggregation

`aggregateRuns` re-derives everything from raw records on each request rather than
maintaining incremental counters. At the scale a single instance holds (bounded by
the store's retention ceiling of 500 runs) that is microseconds, and it eliminates
an entire class of counter-drift bugs.

A Postgres deployment should push this into SQL. The function is pure and takes
`RunRecord[]`, so the seam is already there.

## Retention

The file store keeps the most recent 500 runs and drops the oldest. Traces are
also size-capped per value at 32 KB. Raise `maxRuns` on the store, or export to an
external sink, if you need longer history.

## Streaming a run elsewhere

`executor.run()` is an async generator of `TraceEvent`s. To forward runs to
Datadog, OpenTelemetry, or a log pipeline, consume it alongside the existing
consumer:

```ts
for await (const event of executor.run(graph, { input })) {
  trace = reduceTrace(trace, event);
  if (event.kind === 'node.finished') {
    telemetry.record({
      node: event.nodeId,
      durationMs: event.durationMs,
      status: event.status,
      tokens: event.usage?.totalTokens,
    });
  }
}
```

Values in trace events are already redacted and size-capped, so they are safe to
forward to a third-party sink.
