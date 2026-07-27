# Evaluation

Evaluation answers one question: **did that change make things better or worse?**

## The model

- A **suite** is a workflow plus a fixed set of cases and the metrics to score.
- A **case** is `{ input, expected?, tags? }`.
- A **run** executes every case against one version, producing a real `RunTrace`
  each — openable in the normal debugger, not a bespoke eval viewer.
- A **comparison** diffs two runs of the same suite.

## Creating a suite

```bash
curl -X POST localhost:3000/api/evals -H 'Content-Type: application/json' -d '{
  "action": "createSuite",
  "workflowId": "wf_abc",
  "name": "Refund policy accuracy",
  "metrics": ["taskCompletion", "tokenF1", "latencyMs", "costUsd"],
  "cases": [
    { "id": "refund-window", "input": { "question": "What is the refund window?" }, "expected": "30 days" },
    { "id": "shipping-intl",  "input": { "question": "Do you ship internationally?" }, "expected": "yes" }
  ]
}'
```

## Built-in metrics

| Id               | Direction | What it measures                                           |
| ---------------- | --------- | ---------------------------------------------------------- |
| `exactMatch`     | higher    | Output equals expected after case/whitespace normalisation |
| `contains`       | higher    | Output contains the expected string                        |
| `tokenF1`        | higher    | Token-level F1 — partial credit for extractive answers     |
| `taskCompletion` | higher    | Run succeeded and produced non-empty output                |
| `reasoningDepth` | higher    | Heuristic over executed steps, retries, and errors         |
| `latencyMs`      | lower     | Wall-clock duration                                        |
| `costUsd`        | lower     | Model spend                                                |
| `totalTokens`    | lower     | Prompt + completion tokens                                 |

### Choosing metrics

`exactMatch` is brittle for anything a model phrases freely. `contains` is
permissive enough to pass on an answer that also contains a contradiction.
`tokenF1` is usually the right default for extractive question answering — it
gives partial credit without pretending "mentions the right words somewhere" is
the same as "correct".

`reasoningDepth` is a **structural proxy**, not a judge. It rewards runs that
actually used their retrieval and tool steps rather than answering from the model
alone, and penalises retries and errors. Do not read it as a quality score.

## What makes a case pass

A case passes when **every quality metric that applied to it scores above 0.5**.

Cost and latency are reported but never gate a pass. This is deliberate: a slow
correct answer is still correct, and rolling latency into a pass/fail number is
how a real accuracy regression gets hidden behind a speed improvement. Look at
both columns; do not average them.

## Comparing versions

```bash
curl -X POST localhost:3000/api/evals -H 'Content-Type: application/json' \
  -d '{"action":"compare","baselineRunId":"ev_old","candidateRunId":"ev_new"}'
```

```json
{
  "comparison": {
    "metrics": [
      {
        "metric": "tokenF1",
        "baseline": 0.71,
        "candidate": 0.84,
        "delta": 0.13,
        "improved": true
      },
      {
        "metric": "costUsd",
        "baseline": 0.012,
        "candidate": 0.021,
        "delta": 0.009,
        "improved": false
      }
    ],
    "passRateDelta": 0.15,
    "regressions": ["shipping-intl"],
    "fixes": ["refund-window"]
  }
}
```

`improved` is direction-aware — a cost increase is never reported as an
improvement.

**Read `regressions` first.** An aggregate that improved can still hide cases that
broke, and a case that flipped from pass to fail is the thing worth blocking a
release on.

## Custom metrics

```ts
import { MetricRegistry, type Metric } from '@/core/eval/metrics';

const citesSource: Metric = {
  id: 'citesSource',
  label: 'Cites a source',
  description: 'The answer references at least one retrieved document.',
  direction: 'higher',
  evaluate({ output, trace }) {
    const retrieved = trace.nodes.retrieve?.outputs?.documents;
    if (!Array.isArray(retrieved) || retrieved.length === 0) return null; // N/A
    const text = JSON.stringify(output).toLowerCase();
    return retrieved.some((d) =>
      text.includes(
        String((d as { text: string }).text)
          .slice(0, 40)
          .toLowerCase(),
      ),
    )
      ? 1
      : 0;
  },
};

const metrics = new MetricRegistry().register(citesSource);
```

Return `null` when a metric does not apply to a case — it is then excluded from
that case's grade and from the average, rather than counted as zero.

A metric receives the entire `RunTrace`, so it can assert on which nodes ran, how
many retries happened, or what an intermediate node produced — not just the final
output.

### LLM-as-judge

A judge metric is just a metric that calls a model:

```ts
const judge: Metric = {
  id: 'judgedQuality',
  label: 'Judged quality',
  description: 'A model grades the answer against the reference.',
  direction: 'higher',
  async evaluate({ testCase, output }) {
    const response = await provider.complete({
      model: 'anthropic/claude-haiku-4.5',
      jsonMode: true,
      messages: [
        {
          role: 'user',
          content:
            `Reference: ${testCase.expected}\nAnswer: ${JSON.stringify(output)}\n` +
            `Reply with {"score": 0-1} for factual agreement.`,
        },
      ],
    });
    return Number(JSON.parse(response.text).score ?? 0);
  },
};
```

Two cautions. A judge costs money per case per run, so it is not free to run on
every commit. And a judge is itself a model with its own failure modes — pin the
judge model and keep it fixed across the versions you compare, or you are
measuring the judge's drift rather than your workflow's.

## Reproducibility

The default `flowforge/mock` model is deterministic: the same prompt always yields
the same reply. Evaluate against it to measure changes to _workflow structure_ —
routing, retrieval, prompt assembly — with model variance removed entirely.

Even with a live model, the mock stays registered under its own name, so a
workflow can pin it for a stable baseline.

## Suggested workflow

1. Build a suite from cases that have actually failed in production.
2. Run it against the current published version — that is your baseline.
3. Change one thing.
4. Run it against the draft.
5. Compare. Read `regressions` before the averages.
6. Publish only when nothing regressed and the deltas justify any cost increase.
