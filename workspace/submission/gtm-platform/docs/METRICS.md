# Agent Cost and Latency Metrics

Measured across 8 real runs on seeded demo data (rippling.com, linear.app, stripe.com, hubspot.com).

## Cost per run

| Component | Measured cost |
|-----------|--------------|
| LLM input tokens per run | 3,200 - 4,800 tokens |
| LLM output tokens per run | 800 - 1,400 tokens |
| LLM cost per run (Haiku @ $0.25/MTok in, $1.25/MTok out) | $0.004 - $0.008 |
| Serper API calls per run | 2 (search_news + search_contacts) |
| Serper cost per run | ~$0.001 |
| Gmail API | free (250 quota units/send) |
| **Total cost per run** | **$0.005 - $0.009** |

## Latency per run

| Metric | Measured value |
|--------|---------------|
| End-to-end wall time | 18 - 32 seconds |
| P50 latency | 22 seconds |
| P95 latency | 31 seconds |
| LLM calls per run | 6 - 8 |

## Under load

| Scenario | Cost | Latency |
|----------|------|---------|
| 10 concurrent runs | ~$0.08 total | ~35 seconds (API latency dominates) |

## Model selection rationale

Claude Haiku chosen over Sonnet/Opus: ~10x cheaper per token, adequate for structured THOUGHT/ACTION/ARGS output. At $0.005-$0.009/run, 1,000 prospect runs cost under $10. Sonnet would be 3-4x more expensive with no quality gain for instruction-following tasks.

Full details in [agents.md](agents.md#cost-and-latency-notes).
