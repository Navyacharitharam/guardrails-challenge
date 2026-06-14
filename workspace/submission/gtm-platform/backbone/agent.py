"""GTM Prospect Agent - ReAct loop with full trace logging."""
import os
import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Generator

import anthropic

# load .env if present
_env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        if "=" in _line and not _line.startswith("#"):
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

from .integrations import search_news, search_contacts, send_email
from .models import (
    init_db, upsert_account, upsert_contact, add_signal,
    add_opportunity, save_value_hypothesis, update_icp_score,
    get_account, get_contacts, get_signals
)

TRACES_DIR = Path(__file__).parent.parent / "traces"
TRACES_DIR.mkdir(exist_ok=True)

SYSTEM_PROMPT = """You are a GTM Prospect Agent. Research companies and generate personalized outreach.

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
"""

ICP_PROFILE = {
    "target_industries": ["SaaS", "Fintech", "Enterprise Software", "AI", "Developer Tools"],
    "target_sizes": ["50-500", "500-5000"],
    "target_titles": ["CEO", "CTO", "VP Engineering", "VP Sales", "Head of Growth", "Founder"],
    "keywords": ["scaling", "growth", "AI", "automation", "efficiency"],
}


def source_accounts_by_icp(icp_profile: dict) -> list[dict]:
    """Account sourcing: return seeded accounts ranked by ICP fit against the given profile.
    Used by the Prospect loop to identify which accounts match the ICP definition.
    The agent layer calls this to source matching accounts before enrichment."""
    from .models import get_conn
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, domain, name, industry, icp_score FROM accounts "
            "WHERE domain != 'tenant.internal' AND domain != 'personas.internal' "
            "ORDER BY icp_score DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


class GTMAgent:
    def __init__(self, verbose: bool = True):
        self.client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        self.verbose = verbose
        self.trace = []
        self.trace_id = str(uuid.uuid4())[:8]

    def _log(self, step: dict):
        step["timestamp"] = datetime.now().isoformat()
        self.trace.append(step)
        if self.verbose:
            print(f"\n[{step['type']}] {step.get('content', '')[:200]}")

    def _save_trace(self):
        path = TRACES_DIR / f"trace_{self.trace_id}.json"
        path.write_text(json.dumps(self.trace, indent=2))
        return str(path)

    def _call_tool(self, tool: str, args: dict, account_id: str = None) -> str:
        self._log({"type": "TOOL_CALL", "tool": tool, "args": args})

        if tool == "search_news":
            results = search_news(args["company"])
            return json.dumps(results)

        elif tool == "search_contacts":
            results = search_contacts(args["domain"])
            return json.dumps(results)

        elif tool == "score_icp":
            score = self._compute_icp_score(args.get("reasoning", ""))
            if account_id:
                update_icp_score(account_id, score)
            return json.dumps({"score": score, "reasoning": args.get("reasoning", "")})

        elif tool == "save_contact":
            if account_id:
                cid = upsert_contact(
                    account_id,
                    args.get("name", ""),
                    args.get("title", ""),
                    args.get("email", ""),
                )
                return json.dumps({"success": True, "contact_id": cid})
            return json.dumps({"success": False, "error": "no account_id"})

        elif tool == "draft_email":
            email = self._draft_email(args)
            # Persist value hypothesis + outreach to data model (REQ_10)
            if account_id:
                contacts = get_contacts(account_id)
                cid = contacts[0]["id"] if contacts else None
                signal = args.get("signal", "")
                hypothesis = f"Value hypothesis for {args.get('company','')}: {args.get('sender_context','')}"
                save_value_hypothesis(account_id, cid, signal, hypothesis, email.get("body", ""))
            return json.dumps(email)

        elif tool == "send_email":
            result = send_email(args["to"], args["subject"], args["body"])
            return json.dumps(result)

        return json.dumps({"error": f"unknown tool: {tool}"})

    def _compute_icp_score(self, reasoning: str) -> float:
        score = 0.5
        text = reasoning.lower()
        for kw in ICP_PROFILE["keywords"]:
            if kw.lower() in text:
                score += 0.05
        for title in ICP_PROFILE["target_titles"]:
            if title.lower() in text:
                score += 0.05
        for ind in ICP_PROFILE["target_industries"]:
            if ind.lower() in text:
                score += 0.05
        return min(round(score, 2), 1.0)

    def _draft_email(self, args: dict) -> dict:
        name = args.get("contact_name", "there")
        title = args.get("title", "")
        company = args.get("company", "your company")
        signal = args.get("signal", "your recent growth")
        sender_context = args.get("sender_context", "I work on AI-native GTM tools")

        subject = f"Quick thought on {company}'s {signal[:40]}"
        body = f"""Hi {name.split()[0]},

Saw that {company} {signal}. Congrats - that kind of momentum is exactly when GTM infrastructure becomes the bottleneck.

{sender_context}

I built something that might be relevant - an AI-native layer that sits on top of your data and helps your reps spend time on the right accounts at the right moment, with context they'd otherwise miss.

Worth a 20-min call to see if there's a fit?

Best,
Abhishek
"""
        return {"subject": subject, "body": body}

    def _parse_response(self, text: str) -> tuple[str, str, dict]:
        thought = ""
        action = ""
        args = {}
        answer = ""

        m = re.search(r'THOUGHT:\s*(.+?)(?=ACTION:|ANSWER:|$)', text, re.DOTALL | re.IGNORECASE)
        if m:
            thought = m.group(1).strip()

        m = re.search(r'ACTION:\s*(\w+)', text, re.IGNORECASE)
        if m:
            action = m.group(1).strip()

        m = re.search(r'ARGS:\s*(\{.*?\})', text, re.DOTALL | re.IGNORECASE)
        if m:
            try:
                args = json.loads(m.group(1))
            except json.JSONDecodeError:
                args = {}

        m = re.search(r'ANSWER:\s*(.+?)$', text, re.DOTALL | re.IGNORECASE)
        if m:
            answer = m.group(1).strip()

        return thought, action, args, answer

    def run(self, domain: str, send_to: str = None) -> dict:
        """Run full prospect loop for a domain. Returns summary dict."""
        self.trace = []
        self.trace_id = str(uuid.uuid4())[:8]

        init_db()
        company = domain.split(".")[0].title()
        account_id = upsert_account(domain, company)
        add_signal(account_id, "prospect_start", f"Prospect loop started for {domain}", "gtm-agent")

        self._log({"type": "START", "content": f"Prospecting {domain}", "account_id": account_id})

        messages = [
            {"role": "user", "content": f"Research {domain} (company: {company}). Find recent signals, identify best contact, score ICP fit, draft and send personalized outreach. Send to: {send_to or 'draft only - do not send'}"}
        ]

        max_iter = 12
        for i in range(max_iter):
            try:
                response = self.client.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=1024,
                    system=SYSTEM_PROMPT,
                    messages=messages,
                    metadata={"user_id": domain},
                )
            except anthropic.RateLimitError as e:
                self._log({"type": "ERROR", "content": f"Rate limit hit: {e}. Aborting run."})
                break
            except anthropic.APIError as e:
                self._log({"type": "ERROR", "content": f"Anthropic API error: {e}"})
                break
            text = response.content[0].text
            self._log({"type": "LLM", "content": text, "iteration": i + 1})

            thought, action, args, answer = self._parse_response(text)

            if answer and not action:
                self._log({"type": "FINAL", "content": answer})
                break

            if action:
                result = self._call_tool(action, args, account_id)
                self._log({"type": "OBSERVATION", "tool": action, "content": result})
                messages.append({"role": "assistant", "content": text})
                messages.append({"role": "user", "content": f"OBSERVATION:\n{result}"})
            else:
                messages.append({"role": "assistant", "content": text})
                messages.append({"role": "user", "content": "Use THOUGHT/ACTION/ARGS or THOUGHT/ANSWER format."})

        trace_path = self._save_trace()
        account = get_account(domain)
        contacts = get_contacts(account_id)
        signals = get_signals(account_id)

        return {
            "trace_id": self.trace_id,
            "trace_path": trace_path,
            "domain": domain,
            "account_id": account_id,
            "icp_score": account["icp_score"] if account else 0,
            "contacts_found": len(contacts),
            "signals": len(signals),
            "steps": len(self.trace),
        }
