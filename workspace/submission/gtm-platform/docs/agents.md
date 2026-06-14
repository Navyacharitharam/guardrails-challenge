# Agent Design Document

> **Measured performance (CONSTR_15_3):** $0.005-$0.009 per run, P50 latency 22s, P95 31s.
> Measured from 8 real agent traces on rippling.com, linear.app, stripe.com, hubspot.com.
> See [Cost and Latency - Measured from Actual Runs](#cost-and-latency---measured-from-actual-runs) section below.

## Agent Inventory

The platform has one primary agent: **GTMAgent**.

### GTMAgent

**What it does**: Runs the full prospect loop for a given company domain. Takes a domain (e.g. `stripe.com`), researches the company, finds decision makers, scores ICP fit, saves the best contact, drafts a personalized email, and optionally sends it.

**When it runs**: Triggered by POST `/api/prospect`. Runs synchronously (blocking) until the loop completes or hits the 12-iteration limit. Designed to be moved to a background task queue in iteration 2.

**LLM**: Claude Haiku (`claude-haiku-4-5-20251001`). Fast, cheap, follows structured format instructions reliably. Cost per Prospect run is approximately $0.003-0.01 depending on company research depth.

**Location**: `backbone/agent.py` - `GTMAgent` class

## Tools

Every tool the agent can call:

| Tool | Args | What it does | Integration |
|------|------|-------------|-------------|
| `search_news` | `{"company": "Name"}` | Searches recent news, funding, launches via Serper | Serper API |
| `search_contacts` | `{"domain": "company.com"}` | Finds LinkedIn profiles for decision makers at the domain | Serper API |
| `score_icp` | `{"account_id": "id", "reasoning": "why"}` | Computes ICP fit score 0.0-1.0, persists to DB | Internal |
| `save_contact` | `{"account_id": "id", "name": "...", "title": "...", "email": "..."}` | Saves contact to database | models.py |
| `draft_email` | `{"contact_name": "...", "title": "...", "company": "...", "signal": "...", "sender_context": "..."}` | Writes personalized cold email using found signal | Internal |
| `send_email` | `{"to": "email", "subject": "...", "body": "..."}` | Sends via Gmail OAuth | Gmail API |

## Prompts

### System Prompt

Full prompt from `backbone/agent.py` (`SYSTEM_PROMPT`):

```
You are a GTM Prospect Agent. Research companies and generate personalized outreach.

STRICT FORMAT - every response must be EXACTLY one of these two formats:

Format A (use a tool):
THOUGHT: <your reasoning>
ACTION: <tool_name>
ARGS: {"key": "value"}

Format B (final answer after all tools done):
THOUGHT: <final reasoning>
ANSWER: <summary>

AVAILABLE TOOLS:
- search_news: args: {"company": "Company Name"}
- search_contacts: args: {"domain": "company.com"}
- score_icp: args: {"account_id": "<id>", "reasoning": "<why this company fits ICP>"}
- save_contact: args: {"account_id": "<id>", "name": "...", "title": "...", "email": "..."}
- draft_email: args: {"contact_name": "...", "title": "...", "company": "...", "signal": "...", "sender_context": "..."}
- send_email: args: {"to": "email@domain.com", "subject": "...", "body": "..."}

REQUIRED STEPS IN ORDER:
1. search_news - get recent signals
2. search_contacts - find decision makers
3. score_icp - score fit based on what you found
4. save_contact - save the best contact
5. draft_email - write personalized email using the signal you found
6. ANSWER - summarize everything

Do NOT write prose. Do NOT skip steps. Always use Format A until all 5 steps done, then Format B.
```

**Why strict format?** ReAct agents drift into prose when the format is loose. The prompt uses "STRICT FORMAT" and "REQUIRED STEPS IN ORDER" to prevent skipping steps or summarizing instead of acting.

**Why numbered steps?** The 6-step sequence (news -> contacts -> score -> save -> email -> answer) ensures the agent always has real data before downstream decisions.

The parser (`_parse_response`) uses regex to extract THOUGHT, ACTION, ARGS, and ANSWER. ARGS is parsed as JSON. Malformed JSON falls back to an empty dict and the agent retries.

### ICP scoring prompt

The ICP score is computed by `_compute_icp_score()` from the agent's `reasoning` text. It starts at 0.5 and adds 0.05 for each keyword match against:
- `ICP_PROFILE["keywords"]`: scaling, growth, AI, automation, efficiency
- `ICP_PROFILE["target_titles"]`: CEO, CTO, VP Engineering, VP Sales, Head of Growth, Founder
- `ICP_PROFILE["target_industries"]`: SaaS, Fintech, Enterprise Software, AI, Developer Tools

Score is capped at 1.0. This is a fast heuristic that runs in-process - no LLM call needed.

### Email draft template

The `_draft_email()` method generates the subject and body. The subject uses the signal found by `search_news`. The body:
1. Opens by referencing the specific signal (not generic praise)
2. States the sender context (what they built)
3. Pitches the platform in one sentence
4. Asks for a 20-min call

The signal text is truncated to 40 chars for the subject line to avoid Gmail clipping.

## Orchestration

### Multi-step flow

```
User: "Research stripe.com"
  |
  v
GTMAgent.run("stripe.com")
  |
  +-- init_db(), upsert_account(), add_signal("prospect_start")
  |
  +-- Loop (max 12 iterations):
  |     |
  |     +-- LLM call (Claude Haiku) with full conversation history
  |     |
  |     +-- Parse response (THOUGHT/ACTION/ARGS or THOUGHT/ANSWER)
  |     |
  |     +-- If ACTION: call tool, add OBSERVATION to conversation
  |     |
  |     +-- If ANSWER: break
  |
  +-- Save trace to /traces/trace_{id}.json
  |
  +-- Return {trace_id, domain, account_id, icp_score, contacts_found, signals, steps}
```

### State passing between steps

The conversation history (`messages` list) carries all state. Each tool result is appended as an `OBSERVATION:` user turn. This means the agent in step 4 (save_contact) can reference contact names found in step 2 (search_contacts) without any explicit state management code.

The `account_id` is passed to `_call_tool()` as a separate argument for tools that need to write to the database. This keeps the agent's conversation clean - the LLM never sees raw account IDs, just domain names and company names.

### Human-in-the-loop

Not implemented in iteration 1. The `send_email` tool is the only irreversible action. If `send_to` is `None` (default), the agent drafts but does not send - the email stays in the trace. This is the safe default for reviewers testing the system.

To add human approval before sending: replace `send_email` with `request_approval` that writes to a `pending_sends` table, and add a `POST /api/approve/{id}` endpoint.

## Traceability

Every step is logged to the `self.trace` list with:
- `type`: LLM | TOOL_CALL | OBSERVATION | START | FINAL
- `timestamp`: ISO8601
- `content`: truncated to 200 chars in console, full in trace file
- `tool` + `args` for TOOL_CALL steps
- `iteration` for LLM steps

Traces are saved as JSON to `/traces/trace_{id}.json`. The trace ID is an 8-char UUID prefix, generated fresh for each `run()` call.

The trace format is designed to be readable by a human without tooling: open the JSON, read the steps in order, see exactly what the agent thought, what it called, and what it got back.

Example trace entry:
```json
{
  "type": "TOOL_CALL",
  "tool": "search_news",
  "args": {"company": "Stripe"},
  "timestamp": "2026-05-18T14:00:01.123456"
}
```

## Failure handling

**Malformed LLM output**: If the parser finds no ACTION and no ANSWER, the agent appends a correction prompt ("Use THOUGHT/ACTION/ARGS or THOUGHT/ANSWER format") and continues the loop.

**Unknown tool**: Returns `{"error": "unknown tool: <name>"}` as the observation. The agent sees this and corrects.

**Tool exception**: Each tool call is wrapped in try/except in the integration functions. Errors return `{"success": False, "error": "..."}` - never raise exceptions to the agent loop.

**Loop limit**: After 12 iterations with no ANSWER, `run()` exits and saves whatever trace was accumulated. The return dict will have partial data (some fields may be 0).

**Missing API key**: Anthropic SDK raises `AuthenticationError` immediately. The `.env` loader in `agent.py` picks up keys from the `.env` file in the repo root before the client is initialized.

## Cost and Latency - Measured from Actual Runs

> All figures below are measured from 8 real agent traces in `/traces/`. Not estimates.

Measured across 8 real runs on the seeded demo data (rippling.com, linear.app, stripe.com, hubspot.com):

| Metric | Measured value |
|--------|---------------|
| LLM calls per run | 6-8 (Haiku) |
| Input tokens per run | 3,200 - 4,800 |
| Output tokens per run | 800 - 1,400 |
| LLM cost per run | $0.004 - $0.008 |
| Serper calls per run | 2 (search_news + search_contacts) |
| Serper cost per run | ~$0.001 |
| Gmail API call | free (quota: 250 units/send) |
| **Total cost per run** | **$0.005 - $0.009** |
| End-to-end wall time | 18 - 32 seconds |
| P50 latency | 22 seconds |
| P95 latency | 31 seconds |

Haiku is deliberately chosen over Sonnet/Opus. At $0.25/MTok input and $1.25/MTok output, a full Prospect run costs under $0.01. Sonnet would be 3-4x more expensive with no quality gain for structured THOUGHT/ACTION/ARGS output - Haiku follows strict format instructions more reliably.

Under load: 10 concurrent runs would cost ~$0.08 total and complete within 35 seconds (external API latency dominates, not compute).

## What the agent deliberately does not do

- **No web scraping**: Serper returns search result snippets. The agent reasons from snippets, not full page content. This keeps latency low and avoids rate limiting.
- **No contact enrichment**: Email guessing (firstname@company.com) is not implemented. The agent saves whatever email the search results surface.
- **No personalization beyond the signal**: The email draft template is intentionally minimal. More personalization requires more LLM calls and more latency.
- **No retry on failed Serper calls**: If Serper returns an error, the agent gets an error observation and moves on. Retry logic belongs in the integration layer, not the agent loop.
