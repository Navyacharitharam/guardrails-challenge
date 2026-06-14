# Video Script - GTM Platform (8-12 min)

## Setup BEFORE recording
```bash
cd /Users/abhissrivasta/github-repos-bitsabhi/gtm-platform
python -m uvicorn backbone.api:app --reload
```
Open these tabs in order (you'll visit each once, left to right):
1. github.com/0x-auth/gtm-platform (README)
2. docs/architecture.md (on GitHub)
3. docs/agents.md (on GitHub)
4. docs/integrations.md (on GitHub)
5. http://localhost:8000 (the app)
6. traces/ folder (on GitHub)
7. README "built vs stubbed" section (scroll down on tab 1 — or just open it again at bottom)

---

## TAB 1 — GitHub README (0:00 - 1:00)

Say: "This is the GTM Platform - an AI-native go-to-market system. One command to bring it up, two API keys needed. Here's the repo structure - backbone, prospect, infra, docs, traces, tests."

Scroll slowly top to bottom. Done. Move on.

---

## TAB 2 — docs/architecture.md (1:00 - 2:30)

Say: "Four layers in the system." Point at the ASCII diagram box by box:
- Prospect UI + REST API on top
- GTMAgent ReAct loop in the middle
- Integrations + SQLite data model at the bottom

Then scroll to the Data Model section. Say: "Five tables - accounts, contacts, signals, opportunities, icp_profiles. Every row scoped by account_id - that's the multi-tenancy."

Scroll to "What the next iteration adds". Say: "Engage is iteration 2 - sequences, reply tracking. The data model already has opportunities.stage for this. No schema rework needed."

Done. Move on.

---

## TAB 3 — docs/agents.md (2:30 - 3:30)

Say: "One agent - GTMAgent. Here are the 6 tools it can call." Show the tools table.

Scroll to System Prompt. Say: "This is the actual prompt. Strict THOUGHT/ACTION/ARGS format, 6 required steps in order - so the agent can't skip finding a contact before drafting an email."

Scroll to Cost and latency. Say: "Each run costs about half a cent, takes 15-30 seconds. Haiku is 10x cheaper than Sonnet with no quality loss for structured output."

Done. Move on.

---

## TAB 4 — docs/integrations.md (3:30 - 4:30)

Say: "Two real integrations - Serper for web search, Gmail OAuth2 for sending."

Scroll to "How to add the next integration". Say: "To add a third integration - add one function, one elif, one line in the prompt. No other files change. That's the framework."

Done. Move on.

---

## TAB 5 — http://localhost:8000 (4:30 - 7:30)

**This is the longest segment - let it breathe.**

Say: "Now the live demo. I'll run the Prospect loop on rippling.com."

1. Type `rippling.com`, click Run Prospect Loop
2. While it runs (30-60 sec), narrate each step as it appears:
   - "search_news - pulling recent signals from the web"
   - "search_contacts - finding decision makers on LinkedIn"
   - "score_icp - scoring ICP fit"
   - "save_contact - persisting to the database"
   - "draft_email - writing personalized outreach using the signal it found"
3. When done - show the metric cards (ICP score, contacts, signals, steps)
4. Scroll through the trace in the UI slowly. Say: "Every THOUGHT and every tool call is logged here in real time."
5. Run it again on `linear.app` - just show it starting, then skip to done

Done. Move on.

---

## TAB 6 — traces/ folder on GitHub (7:30 - 9:00)

Say: "Every run is also saved as a JSON file in /traces."

Click on `trace_f0dd9437.json`. Scroll through it slowly. Point out:
- START entry
- A TOOL_CALL entry - "here's the exact args the agent passed"
- An OBSERVATION entry - "here's what came back from Serper"
- The FINAL entry - "the full summary including the drafted email"

Say: "A reviewer can verify exactly what the agent did without running the system."

Done. Move on.

---

## TAB 7 — README "What's built vs stubbed" (9:00 - 10:00)

Go back to the GitHub README, scroll to the bottom.

Say: "Being honest about what's in iteration 1."

Read the stubbed list quickly:
- "Follow-up sequences - not built yet"
- "Reply tracking - not implemented"  
- "CRM pipeline view - not built"
- "Slack - pattern documented, not wired"

Say: "That's it. The backbone and the full Prospect loop are real. Everything else is the next challenge."

---

## DONE - stop recording
