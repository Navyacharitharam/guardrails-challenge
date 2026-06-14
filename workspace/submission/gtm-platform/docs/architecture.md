# Architecture Document

## System Overview

GTM Platform is an AI-native go-to-market system built as a unified backbone - a data layer that knows everything about every account, contact, signal, and conversation, with an agent orchestration layer that acts on that data autonomously.

The key thesis: the average sales rep spends 70% of their time on non-selling work. This platform eliminates that overhead by running a full research-to-outreach loop automatically, with every decision traceable and every action logged.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GTM Platform                                 │
├──────────────────────────┬──────────────────────────────────────────┤
│   Prospect UI            │   REST API (FastAPI)                     │
│   - Domain input         │   POST /api/prospect                     │
│   - Real-time trace view │   GET  /api/account/{domain}             │
│   - Past runs list       │   GET  /api/traces                       │
│   - Metric cards         │   GET  /api/traces/{id}                  │
├──────────────────────────┴──────────────────────────────────────────┤
│                    Agent Orchestration Layer                         │
│   GTMAgent - ReAct loop (THOUGHT / ACTION / ARGS / OBSERVATION)    │
│   - Claude Haiku as reasoning engine                                │
│   - 6-step protocol: news → contacts → score → save → email → done │
│   - Full trace logging to /traces/ as JSON                         │
│   - 12-iteration max with graceful fallback                         │
├────────────────────────────────┬────────────────────────────────────┤
│   Integrations Framework       │   Data Model (SQLite)              │
│   - Serper API (web search)    │   - accounts                       │
│   - Gmail OAuth2 (email send)  │   - contacts                       │
│   - Extensible: add any API    │   - opportunities                  │
│     without touching agent     │   - signals                        │
│                                │   - icp_profiles                   │
└────────────────────────────────┴────────────────────────────────────┘
```

## Data Model

The data model is designed as a multi-tenant foundation. Every table is scoped by `account_id`. The schema can accommodate custom fields and new entity types without rework.

### accounts

The central entity. Represents a target company.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix (8 chars) |
| domain | TEXT UNIQUE | Company domain (e.g. stripe.com) |
| name | TEXT | Company name |
| industry | TEXT | Industry classification |
| size | TEXT | Employee range |
| icp_score | REAL | ICP fit score 0.0-1.0, updated by agent |
| signals | TEXT | JSON array of signal IDs |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

### contacts

Decision makers found at an account.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix |
| account_id | TEXT FK | Parent account |
| name | TEXT | Full name |
| title | TEXT | Job title |
| email | TEXT | Contact email |
| linkedin | TEXT | LinkedIn URL |
| score | REAL | Contact relevance score |
| created_at | TEXT | ISO timestamp |

### signals

Buying intent and activity events captured for an account.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix |
| account_id | TEXT FK | Parent account |
| type | TEXT | Signal type (funding, launch, hire, prospect_start) |
| content | TEXT | Signal description |
| source | TEXT | Source (serper, gtm-agent, manual) |
| captured_at | TEXT | ISO timestamp |

### opportunities

The bridge between a contact and an outreach action.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix |
| account_id | TEXT FK | Parent account |
| contact_id | TEXT FK | Contact targeted |
| stage | TEXT | Stage (prospecting, outreach_sent, replied) |
| signal | TEXT | Triggering signal text |
| outreach | TEXT | Full email body |
| sent_at | TEXT | When email was sent |
| created_at | TEXT | ISO timestamp |

### activities

Timestamped events linked to an account and optionally a contact. Used to track calls, meetings, email opens, and other engagement events.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix |
| account_id | TEXT FK | Parent account |
| contact_id | TEXT FK | Contact involved (optional) |
| type | TEXT | Activity type (call, meeting, email_open, note) |
| description | TEXT | Activity details |
| occurred_at | TEXT | ISO timestamp |

### icp_profiles

Ideal Customer Profile definitions. Multiple profiles supported.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID prefix |
| name | TEXT | Profile name |
| industries | TEXT | JSON array of target industries |
| sizes | TEXT | JSON array of target size ranges |
| titles | TEXT | JSON array of target titles |
| keywords | TEXT | JSON array of ICP keywords |
| created_at | TEXT | ISO timestamp |

### Multi-tenancy approach

Tenant isolation is enforced at three layers:

**Data layer**: Every table row is scoped by `account_id`. All queries in `models.py` include `WHERE account_id = ?`. No query returns data across tenant boundaries. A tenant can only ever see its own accounts, contacts, signals, and opportunities.

**Service layer**: `GTMAgent` receives an `account_id` at initialization and passes it through every `_call_tool()` invocation. The agent cannot address another tenant's data because it only knows its own `account_id`. Tool functions in `agent.py` pass `account_id` explicitly - it is never inferred from context.

**Request layer**: The `POST /api/prospect` endpoint generates a fresh `account_id` (UUID prefix) per domain on first run, or retrieves the existing one via `upsert_account(domain=...)`. Requests are stateless - no session or cookie carries tenant identity. In a production deployment, the request layer would validate a JWT and extract the tenant ID before creating the agent, replacing the current domain-as-tenant-key approach with proper auth-gated isolation.

Adding a second tenant means inserting a new account row - no schema changes needed. Indexing on `account_id` and `domain` ensures queries stay O(log n) as data grows.

### Scaling considerations

SQLite is used for the Prospect slice because it eliminates infrastructure dependencies. The schema is compatible with a straight migration to PostgreSQL: all types map directly, and the `connect()` abstraction in `models.py` means swapping the connection string is the only required change. Full-text search on signals can be layered in via SQLite FTS5 or replaced with Elasticsearch without touching the agent layer.

## Agent Orchestration

See [agents.md](agents.md) for the full agent design. At the architecture level, the orchestration approach is:

**ReAct loop** - the agent alternates between reasoning (THOUGHT) and acting (ACTION + ARGS), with observations fed back as user turns. This gives full traceability: every step is logged with its timestamp, reasoning, tool called, and result.

**Strict protocol** - the SYSTEM_PROMPT enforces a 6-step sequence. This is deliberate: it prevents the agent from taking shortcuts (e.g. drafting an email without finding a contact first) and makes the trace human-readable.

**Tool dispatch** - tools are implemented as Python functions in `_call_tool()`. Adding a new tool means adding one `elif` branch and one line in the SYSTEM_PROMPT tool list. The integrations layer is fully decoupled from the agent - the agent never imports integration code directly.

## Module Boundaries

```
backbone/
  models.py      - ALL database access. No business logic, no imports from other modules.
  integrations.py - ALL external API calls. No database access, no agent logic.
  agent.py       - Agent loop ONLY. Imports models + integrations, no direct API calls.
  api.py         - HTTP layer ONLY. Creates GTMAgent, calls run(), returns result.
  seed.py        - Demo data loader. Runs once on startup.
```

The dependency graph is a strict DAG: `api -> agent -> models + integrations`. No circular imports. No agent code in the API layer. No database calls in integrations.

## Integrations Framework

See [integrations.md](integrations.md) for full details. The framework design:

1. Each integration is a pure function in `integrations.py`
2. Functions return plain Python dicts - no integration-specific types leak into the agent
3. The agent calls tools by name via `_call_tool()` - it never imports integration modules
4. Adding a new integration requires: (a) a function in `integrations.py`, (b) a tool entry in SYSTEM_PROMPT, (c) an `elif` in `_call_tool()`

This means a competent engineer can add a Salesforce integration, a Slack notification integration, or a LinkedIn API integration without reading or modifying the agent code.

## Trade-offs and deliberate decisions

**SQLite over PostgreSQL**: removes infrastructure dependency for the Prospect slice. Migration path is documented above. The right call for a v1 that needs to run on a reviewer's machine with `docker compose up`.

**Claude Haiku over GPT-4**: ~10x cheaper per token, adequate for structured THOUGHT/ACTION/ARGS output. The agent loop uses a strict format prompt that works better with Haiku's tendency to follow instructions literally. Opus or Sonnet can be swapped in via the `model` parameter.

**ReAct over tool-use API**: Anthropic's native tool use is cleaner for production, but ReAct gives us human-readable traces in plain text that judges and engineers can read without tooling. The trace format (THOUGHT/ACTION/ARGS) is self-documenting.

**Serper over direct Google Search API**: Serper provides structured JSON (title, link, snippet) from Google Search results. The Google Custom Search API returns the same data but requires a Programmable Search Engine setup. Serper is one API key and one HTTP call.

**Gmail over SendGrid**: Gmail OAuth lets reviewers test with their own inbox without setting up a transactional email account. The integration pattern (OAuth2 credentials file + token file) is the standard pattern for all Google APIs, so it generalizes to Calendar, Sheets, Drive without new auth code.

## What the next iteration adds

This is iteration 1. The backbone is designed to support:

**Iteration 2 - Engage**: Multi-step sequences, reply tracking, sentiment analysis on replies, automatic follow-up scheduling.

**Iteration 3 - Manage**: Full CRM layer, pipeline views, forecast scoring, Slack/Teams notifications, webhook integrations.

The data model already has the `opportunities.stage` field and `signals` table to support these. No schema rework needed for iteration 2. Iteration 3 would add a `sequences` table and a `replies` table.

## Security considerations

- No API keys are checked into the repository (`.gitignore` covers `.env`)
- The `.env.example` file shows which keys are needed without values
- SQL queries use parameterized statements throughout - no string interpolation in queries
- The Gmail token file is in `.gitignore` - it is never committed
- SERPER_API_KEY is an outbound-only key with no write access to any system
- The agent receives only the domain and optional send_to email - no other user input reaches the LLM

## Extension points

**Adding a CRM integration (e.g. HubSpot)**:
1. Add `push_to_crm(account_id, contact_id)` in `integrations.py`
2. Add `- push_crm: args: {"account_id": "...", "contact_id": "..."}` to SYSTEM_PROMPT
3. Add `elif tool == "push_crm"` in `_call_tool()`
4. Document in `docs/integrations.md`

No other files change. The agent will use the new tool when it decides it's appropriate.

**Adding a new entity type (e.g. deals)**:
1. Add `CREATE TABLE IF NOT EXISTS deals` in `init_db()`
2. Add CRUD functions in `models.py`
3. The agent and API layer pick it up via the existing patterns

**Indexing strategy (CONSTR_01_4 - query performance at scale)**:

Current indexes in `init_db()` (models.py):
- `idx_accounts_domain` - B-tree on `accounts.domain` - O(log n) domain lookup
- `idx_contacts_account` - B-tree on `contacts.account_id` - O(log n) contact queries per account
- `idx_signals_account` - B-tree on `signals.account_id` - O(log n) signal feed queries
- `idx_opportunities_account` - B-tree on `opportunities.account_id` - O(log n) pipeline queries

All read queries in `models.py` use `WHERE account_id = ?` or `WHERE domain = ?`, hitting these indexes directly. At 10M accounts this keeps queries at O(log n) without full table scans.

**Scaling to 10M accounts**:
1. Swap `sqlite3` for `psycopg2` in `models.py` (one import change)
2. Add composite index on `(account_id, captured_at)` for time-sorted signal feeds
3. Move trace storage to S3/GCS (one path change in `agent.py`)
4. Add Redis for ICP score caching

None of these require touching the agent or integrations code.
