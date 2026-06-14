# Future Prospects - GTM Platform

## What exists today (v1)

- ReAct agent loop: search -> score ICP -> save contact -> draft email -> send
- Multi-tenant SQLite data model (accounts, contacts, signals, opportunities)
- 2 live integrations: Serper + Gmail OAuth
- 26 passing tests
- FastAPI + vanilla JS UI with real-time trace viewer

---

## Iteration 2 - Follow-up Sequences

The `opportunities.stage` field and `signals` table are already in the schema.

What to build:
- `sequences` table: contact_id, step (1/2/3), send_at, sent_at, status
- New agent tool: `check_reply` - polls Gmail for reply to a thread
- New agent tool: `schedule_followup` - writes a row to sequences
- Cron job: runs every 24h, picks up pending sequences, fires next email

No changes to the existing agent loop. Just new tools added to the system prompt.

## Iteration 3 - CRM Pipeline View

- Pipeline board UI (kanban): Prospect -> Contacted -> Replied -> Meeting -> Closed
- `opportunities.stage` drives the columns
- Drag to move stage, agent auto-advances on reply detection

## Iteration 4 - CRM Integrations

Adding HubSpot, Salesforce, or Pipedrive sync:
- 1 function in `backbone/integrations.py`
- 1 line in agent system prompt
- Agent pushes contact + opportunity to CRM after save

Pattern is already documented in `docs/integrations.md`.

## Iteration 5 - Hosted SaaS

- Swap SQLite -> Postgres (one import change in `backbone/models.py`)
- Add auth: Clerk or Supabase Auth (JWT, per-account_id scoping already in place)
- Deploy: Railway or Render (Dockerfile already in `infra/`)
- Billing: Stripe (ironic) - per seat or per prospect run

Pricing comp: Clay ($149-800/mo), Apollo ($49-99/mo), Instantly ($37+/mo)
Our differentiation: full agent trace visibility, bring-your-own-keys, open core

## Iteration 6 - Slack Notifications

- `send_slack` function in integrations.py
- Fires when: prospect run complete, reply detected, meeting booked
- Webhook-based, no OAuth needed

## Other ideas

- **Browser extension**: highlight a LinkedIn profile, auto-prospect that person
- **Chrome extension**: detect job postings (hiring signal) and auto-add to signals table
- **Webhook receiver**: Clearbit/Apollo webhook -> auto-trigger prospect loop on new account
- **Multi-model**: swap Haiku for Sonnet on high-value accounts (ICP score > 0.85)
- **Voice briefings**: daily digest of signals read aloud via ElevenLabs

---

## What NOT to build (stay focused)

- Chat interface - this is an autonomous agent, not a chatbot
- Custom LLM - Haiku at $0.01/run is fine for v1-v3
- Mobile app - sales reps work on desktop
