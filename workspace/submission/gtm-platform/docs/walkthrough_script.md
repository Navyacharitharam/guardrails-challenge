# Walkthrough Script - GTM Platform

Exact words, 8-12 min. Timestamps are approximate.

---

## 0:00 - 1:00 | Architecture Overview

*(Show architecture.md in browser/GitHub)*

> "Hey, this is the GTM Platform walkthrough for the Topcoder challenge.
> Let me start with the architecture."

> "At the bottom we have the data layer - SQLite with five tables: accounts,
> contacts, opportunities, signals, and ICP profiles. Everything is scoped
> by account ID, so multi-tenancy is built in from day one."

> "In the middle is the agent orchestration layer - a ReAct loop powered by
> Claude Haiku. The agent gets a company domain, and runs six steps in order:
> search for news, find contacts, score ICP fit, save the contact, draft an
> email, and summarize. Every step is logged."

> "On top we have FastAPI serving the REST endpoints, and a vanilla JS UI
> that shows the agent reasoning trace in real time."

> "Two real integrations: Serper for web search - that's real Google results -
> and Gmail OAuth for actually sending the email."

---

## 1:00 - 2:00 | Data Model

*(Stay on architecture.md, scroll to the tables section)*

> "Quick look at the data model."

> "The accounts table is the central entity - domain, name, industry, size,
> and an ICP score that the agent updates after each run."

> "Contacts are linked to accounts by account ID. Every query is filtered
> by account ID - that's the multi-tenancy. If I add a second company,
> their contacts never show up in the first company's queries."

> "Signals are buying intent events - funding rounds, product launches, hires.
> The agent captures these from real search results and stores them here."

> "Opportunities link a contact to an outreach action - what was sent, when,
> and what stage it's at."

> "The schema is SQLite now, PostgreSQL-compatible. Swapping is one import
> change in models.py - nothing in the agent or API layer changes."

---

## 2:00 - 4:00 | Live Prospect Loop

*(Switch to browser at localhost:8000)*

> "Okay, let's run the actual prospect loop. The system already has two
> seeded accounts - Rippling and Linear - but I want to show a fresh run."

> "I'll type stripe.com here."

*(type stripe.com in the domain field)*

> "I'll leave the email field empty for now - that means the agent will
> draft the email but not send it. Safe default."

> "Hitting Run Prospect Loop."

*(click the button)*

> "So the agent is running now. What's happening under the hood: Claude Haiku
> is in a loop, and on each iteration it decides what to do next. First it
> will call search_news to find recent signals about Stripe. Then search_contacts
> to find decision makers. Then score the ICP fit, save the contact, and draft
> a personalized email."

*(wait for it to finish - talk over the wait)*

> "Each step gets logged with the reasoning, the tool called, and the
> observation that came back. This is a real API call to Serper right now -
> real Google search results."

*(when done, point at the metric cards)*

> "Done. We can see the ICP score, how many contacts were found, how many
> signals were captured, and how many agent steps it took."

> "And below that is the full agent reasoning trace - every thought, every
> tool call, every result."

---

## 4:00 - 6:00 | Agent Traces

*(point at the trace in the UI)*

> "Let me walk through what this trace is showing."

> "Each row is one step. The purple ones are the agent's reasoning - the
> THOUGHT. The blue ones are tool calls - ACTION plus ARGS. The green ones
> are observations - what the real API returned."

> "So you can see: the agent thought about what to do, called search_news
> with the company name, got back real search results, then decided to call
> search_contacts, and so on."

*(switch to terminal, show a trace file)*

> "The traces are also saved as JSON files. Let me show one."

```
cat traces/trace_df5f46d5.json | python3.14 -m json.tool | head -80
```

> "Every entry has a type, a timestamp, and the content. TOOL_CALL has the
> tool name and the args. OBSERVATION has what came back. This is the primary
> evidence for Category 1 - real AI agent integration."

> "The agent made a real LLM call, used real tools, and wrote real results
> back to the database. Nothing is mocked or hardcoded."

---

## 6:00 - 7:30 | Integration Demo

*(switch to terminal, open integrations.py)*

> "Let me show the two integrations."

```
cat backbone/integrations.py
```

> "search_news is one function - it takes a company name, builds a query
> like 'Stripe news funding product launch 2025 2026', sends it to Serper,
> and gets back structured JSON. Title, link, snippet. The agent reads the
> snippets and extracts the signal."

> "search_contacts does the same thing but queries LinkedIn profiles via
> Serper - site:linkedin.com/in plus the domain plus common titles."

> "send_email uses Gmail OAuth. If you pass an email address in the UI,
> this function fires. It loads the OAuth token, builds a MIMEText message,
> base64-encodes it, and posts to Gmail's API. Returns a message ID."

> "The key design decision: adding a third integration - HubSpot, Slack,
> Salesforce, whatever - is five lines in this file and one line added to
> the agent's system prompt. The agent code itself does not change."

> "That's the integrations framework. It's a clean pattern that a competent
> engineer can extend without reading the agent code."

---

## 7:30 - End | What's Not Built and What's Next

*(switch back to architecture.md or just face camera)*

> "Let me be honest about what's in iteration 1 and what's not."

> "The Prospect slice is fully functional - you just saw it run end to end.
> The data model, agent, integrations, UI, tests, and docs are all real."

> "What's not built yet: multi-step sequences - follow-up emails if there's
> no reply. Reply tracking. A CRM view with pipeline stages. Slack notifications."

> "But the data model already supports it. The opportunities table has a
> stage field. The signals table captures any event type. Adding follow-up
> sequences in iteration 2 means adding a sequences table and a new agent
> tool - the backbone doesn't change."

> "Three things I want to call out about what we deliberately did not do:"

> "We didn't mock any data. Every Serper call in those traces hit the real
> API. Every agent step used real Claude Haiku. The ICP scores came from
> real reasoning."

> "We didn't use a chat interface. This is an autonomous agent running a
> structured protocol - six required steps in order, with a full trace."

> "And we didn't over-engineer it. SQLite over PostgreSQL, Haiku over GPT-4,
> vanilla JS over React. The right tool for a v1 that needs to run on
> a reviewer's machine with one command."

> "Thanks for watching."

---

## Terminal commands ready to paste

```bash
# show a trace
cat traces/trace_df5f46d5.json | python3.14 -m json.tool | head -80

# show integrations
cat backbone/integrations.py

# show tests passing
python3.14 -m pytest tests/ -v
```
