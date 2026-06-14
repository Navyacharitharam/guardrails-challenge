# GTM Platform - AI-Native Go-to-Market

**GitHub:** https://github.com/0x-auth/gtm-platform
**Walkthrough video:** https://www.youtube.com/watch?v=qNmU3ZQKHNg

An AI-native platform that automates the full prospect loop: research a company, find decision makers, score ICP fit, draft personalized outreach, and send via Gmail - all driven by an autonomous agent.

## What this is

Sales reps spend 70% of their time on non-selling work: researching accounts, finding contacts, writing emails, updating the CRM. This platform builds the operating layer underneath - a unified data model (accounts, contacts, opportunities, signals) with an agent orchestration layer that does the research and outreach automatically.

## External API keys needed

| Key | Purpose | Get it at |
|-----|---------|-----------|
| `ANTHROPIC_API_KEY` | Claude Haiku for agent reasoning | console.anthropic.com |
| `SERPER_API_KEY` | Google Search via Serper for news + contact discovery | serper.dev |

Gmail OAuth credentials are optional (for real email sending). Without them, the agent drafts emails but does not send.

## One-command bring-up

```bash
# Clone and set keys
git clone <repo>
cd gtm-platform
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY and SERPER_API_KEY

# Docker (recommended)
docker compose -f infra/docker-compose.yml up

# OR local Python 3.11+
pip install -r requirements.txt
python -m uvicorn backbone.api:app --reload
```

Open http://localhost:8000

## How to run the Prospect loop

1. Open http://localhost:8000
2. Type a company domain (e.g. `stripe.com`)
3. Optionally add an email address to send outreach to
4. Click "Run Prospect Loop"
5. Watch the agent reasoning trace in real time

The agent runs 6 steps in order:
1. `search_news` - pulls recent signals from the web via Serper
2. `search_contacts` - finds decision makers on LinkedIn via Serper
3. `score_icp` - scores the account against the ICP profile (0.0-1.0)
4. `save_contact` - persists the best contact to the database
5. `draft_email` - writes a personalized cold email using the signal found
6. ANSWER - summarizes the full prospect run

## Seeded demo environment

On first run the platform auto-seeds the full demo environment:

**10 companies** (Rippling, Linear, Notion, Vercel, Retool, Loom, Figma, Airtable, Intercom, Segment) with ICP scores ranging from 0.74 to 0.92, 16 contacts, 21 signals, 2 ICP profiles (Enterprise SaaS, Growth Stage Tech), and 3 personas (VP Sales, CRO, Head of RevOps).

Reviewers can immediately run the Prospect loop on any of these domains or any new domain.

## Repository map

```
/backbone   - platform backbone (data model, agent, integrations framework)
/prospect   - vertical slice UI (dark theme, trace viewer)
/infra      - Docker + compose
/docs       - architecture, agent design, integration docs
/traces     - saved agent execution traces
/tests      - automated integration tests
/data       - seeded demo data (SQLite)
README.md
```

## Running tests

```bash
pip install pytest pytest-asyncio httpx
pytest tests/ -v
```

## What's built vs what's stubbed

### Built (fully functional)
- Prospect loop: search -> score ICP -> save contact -> draft email -> send (6 steps, real APIs)
- ReAct agent loop with THOUGHT/ACTION/OBSERVATION trace logged per step
- Multi-tenant SQLite data model (accounts, contacts, signals, opportunities, icp_profiles)
- Serper integration: real Google search results for news and contact discovery
- Gmail OAuth2 integration: real email sending via Gmail API
- FastAPI REST endpoints with Pydantic validation
- Vanilla JS UI with real-time agent trace viewer
- 26 integration tests covering data model, agent, API, multi-tenancy
- Seeded demo data: 10 companies, 10+ contacts, 10+ signals, 2 ICP profiles, 3 personas

### Stubbed / not in iteration 1
- Follow-up sequences (opportunities.stage field exists, sequences table not built yet)
- Reply tracking (Gmail thread polling not implemented)
- CRM pipeline view (kanban board not built)
- Slack notifications (integration pattern documented, not wired)
- Multi-step outreach cadences

### Deliberate decisions
- SQLite over PostgreSQL: runs on reviewer machine with one command, PostgreSQL-compatible (one import change in models.py)
- Claude Haiku over GPT-4: 10x cheaper, full prospect run under $0.01
- Vanilla JS over React: no build step, loads instantly
- No mock data: every Serper call hits real API, every agent step uses real Claude Haiku

## Links

- Architecture: [docs/architecture.md](docs/architecture.md)
- Agent design: [docs/agents.md](docs/agents.md)
- Integrations: [docs/integrations.md](docs/integrations.md)
- Walkthrough video: https://www.youtube.com/watch?v=qNmU3ZQKHNg
