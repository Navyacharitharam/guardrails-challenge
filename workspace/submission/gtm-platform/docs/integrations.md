# Integration Document

## Integration Overview

The platform has two live integrations that flow real data into the Prospect experience:

| Integration | Purpose | Auth method |
|-------------|---------|-------------|
| **Serper API** | Web search for company news and contact discovery | API key (`X-API-KEY` header) |
| **Gmail API** | Send personalized outreach emails | OAuth2 (credentials.json + token.json) |

Both are implemented in `backbone/integrations.py` as pure functions. The agent never imports this module directly - it calls tools by name via `_call_tool()` in `agent.py`.

## Serper API

### What it does

Serper provides Google Search results as structured JSON (title, link, snippet). The platform uses it for two distinct searches per Prospect run:

1. **Company news** (`search_news`): `"{company} news funding product launch 2025 2026"` - surfaces recent signals like funding rounds, new products, exec hires.
2. **Contact discovery** (`search_contacts`): `"site:linkedin.com/in {domain} CEO CTO VP Head Director"` - finds LinkedIn profiles of decision makers at the target company.

### Authentication

Single API key set as `SERPER_API_KEY` environment variable. Passed as `X-API-KEY` header in every request.

### Data flow

```
Agent calls search_news("Stripe")
  -> integrations.search("Stripe news funding product launch 2025 2026", num=5)
  -> POST https://google.serper.dev/search
  -> Returns [{title, link, snippet}, ...]
  -> Stored as OBSERVATION in agent conversation
  -> Agent extracts key signal from snippets
  -> Signal used in draft_email() args
```

### Setup

1. Sign up at serper.dev (free tier: 2,500 queries/month)
2. Copy your API key
3. Add to `.env`: `SERPER_API_KEY=your_key`

No other configuration needed. The integration uses `urllib.request` from the standard library - no extra dependencies.

### Rate limits and error handling

Serper free tier: 2,500 queries/month. Each Prospect run uses 2 queries. At that rate, the free tier supports 1,250 full Prospect runs per month.

If the API key is missing, `search()` returns `[{"title": "Serper key missing", "snippet": "Set SERPER_API_KEY"}]` - the agent sees this observation and notes it in its reasoning, then continues to the next step rather than crashing.

If Serper returns a non-200 status, `urllib.request.urlopen` raises `urllib.error.HTTPError`. This propagates to `_call_tool()` which catches it and returns `{"error": "..."}` as the observation.

## Gmail API

### What it does

Sends the personalized outreach email drafted by the agent. Uses the Gmail REST API with OAuth2 credentials tied to the sender's Google account.

### Authentication

OAuth2 flow using `google-auth-oauthlib`:

1. First run: opens browser for Google OAuth consent (or runs local server on port 0)
2. Token saved to `data/gmail_token.json`
3. Subsequent runs: token loaded from file, refreshed automatically when expired

Required credentials file: `data/gmail_cred.json` - downloaded from Google Cloud Console (OAuth2 client credentials for a Desktop app).

### Data flow

```
Agent calls send_email("cto@stripe.com", "Quick thought...", "Hi Patrick,...")
  -> integrations.send_email(to, subject, body)
  -> _get_gmail_service() - loads/refreshes OAuth token
  -> Builds MIMEText message
  -> Encodes as base64url
  -> POST gmail/v1/users/me/messages/send
  -> Returns {success: true, message_id: "..."}
```

### Setup

1. Go to Google Cloud Console
2. Create a project, enable Gmail API
3. Create OAuth2 credentials (Desktop app type)
4. Download as `data/gmail_cred.json`
5. First run will open browser for authorization

If `gmail_cred.json` is not present, `send_email()` returns `{"success": False, "error": "Gmail credentials not found"}`. The agent logs this as an observation and continues - the email is drafted but not sent. The draft is still in the trace.

### Operational concerns

- **Token refresh**: handled automatically by `google-auth` library. Token expires every hour but refresh tokens are long-lived.
- **Rate limits**: Gmail API allows 250 quota units per second, 1,000,000 per day. Each send is 100 units. The Prospect loop sends at most 1 email per run.
- **Scopes**: Only `gmail.send` scope is requested - no read access to the inbox.

## How to add the next integration

The integration framework is designed so adding a new integration does not require touching any agent code.

### Example: Add Slack notifications

**Step 1** - Add function to `backbone/integrations.py`:

```python
def send_slack_notification(channel: str, message: str) -> dict:
    """Post a message to a Slack channel via webhook."""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        return {"success": False, "error": "SLACK_WEBHOOK_URL not set"}
    payload = json.dumps({"channel": channel, "text": message}).encode()
    req = urllib.request.Request(webhook_url, data=payload,
                                  headers={"Content-Type": "application/json"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=10, context=ctx) as r:
        return {"success": True, "status": r.status}
```

**Step 2** - Add tool to agent SYSTEM_PROMPT in `backbone/agent.py`:
```
- notify_slack: args: {"channel": "#sales", "message": "..."}
```

**Step 3** - Add dispatch in `_call_tool()`:
```python
elif tool == "notify_slack":
    return json.dumps(send_slack_notification(args["channel"], args["message"]))
```

**Step 4** - Add to `.env.example`:
```
SLACK_WEBHOOK_URL=your_webhook_url
```

**Step 5** - Document here in `integrations.md`.

No other files change. The agent will use `notify_slack` when it determines it's appropriate based on the SYSTEM_PROMPT.

### Example: Add HubSpot CRM sync

Same 5-step pattern. The function in `integrations.py` would:
1. Read `HUBSPOT_API_KEY` from env
2. POST to `https://api.hubapi.com/crm/v3/objects/contacts`
3. Return `{success, contact_id}` or `{success: False, error}`

The agent would call it after `save_contact` to ensure the contact is synced to CRM in real time.

### What to avoid when adding integrations

- **Don't import models in integrations.py** - integrations are pure functions that call external APIs. Database writes go through `models.py` and are called from `agent.py`.
- **Don't raise exceptions** - always return `{"success": False, "error": "..."}` so the agent gets a clean observation.
- **Don't add auth logic to agent.py** - all auth (API keys, OAuth, tokens) lives in `integrations.py`.
- **Don't add rate limit retry loops** - the agent loop has a 12-iteration budget. A retry loop in an integration burns iterations. Log the error and return it.
