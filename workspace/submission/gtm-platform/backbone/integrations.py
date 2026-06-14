"""Real integrations: Serper (search) + Gmail (send)."""
import os
import json
import time
import base64
from pathlib import Path
from email.mime.text import MIMEText

import requests

# Rate limit tracking - max 10 Serper calls/min (free tier: 2500/month)
_SERPER_CALL_TIMES: list = []
_SERPER_RATE_LIMIT = int(os.environ.get("SERPER_RATE_LIMIT", "10"))

SERPER_KEY = os.environ.get("SERPER_API_KEY", "")
SERPER_URL = "https://google.serper.dev/search"
GMAIL_TOKEN_PATH = Path(__file__).parent.parent / "data" / "gmail_token.json"
GMAIL_CRED_PATH = Path(
    os.environ.get(
        "GMAIL_CRED_PATH",
        str(Path(__file__).parent.parent / "data" / "gmail_credentials.json")
    )
)


# ── Serper ───────────────────────────────────────────────────────────────────

def _check_rate_limit():
    """Sliding window rate limit - raises if >_SERPER_RATE_LIMIT calls in last 60s."""
    now = time.monotonic()
    _SERPER_CALL_TIMES[:] = [t for t in _SERPER_CALL_TIMES if now - t < 60]
    if len(_SERPER_CALL_TIMES) >= _SERPER_RATE_LIMIT:
        raise RuntimeError(f"Serper rate limit reached ({_SERPER_RATE_LIMIT}/min). Retry after 60s.")
    _SERPER_CALL_TIMES.append(now)


def search(query: str, num: int = 5) -> list[dict]:
    """Search the web via Serper. Returns list of {title, link, snippet}."""
    if not SERPER_KEY:
        return [{"title": "Serper key missing", "link": "", "snippet": "Set SERPER_API_KEY"}]
    try:
        _check_rate_limit()
    except RuntimeError as e:
        return [{"title": "Rate limit", "link": "", "snippet": str(e)}]
    try:
        resp = requests.post(
            SERPER_URL,
            json={"q": query, "num": num},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.HTTPError as e:
        return [{"title": f"Serper HTTP {e.response.status_code}", "link": "", "snippet": str(e)}]
    except requests.RequestException as e:
        return [{"title": "Serper connection error", "link": "", "snippet": str(e)}]
    results = []
    for item in data.get("organic", [])[:num]:
        results.append({
            "title": item.get("title", ""),
            "link": item.get("link", ""),
            "snippet": item.get("snippet", ""),
        })
    return results


def search_news(company: str) -> list[dict]:
    return search(f"{company} news funding product launch 2025 2026", num=5)


def search_contacts(domain: str) -> list[dict]:
    return search(f"site:linkedin.com/in {domain} CEO CTO VP Head Director", num=8)


# ── Gmail ────────────────────────────────────────────────────────────────────

def _get_gmail_service():
    """Get authenticated Gmail service using stored token."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        import google.auth

        SCOPES = ["https://www.googleapis.com/auth/gmail.send"]
        creds = None

        if GMAIL_TOKEN_PATH.exists():
            creds = Credentials.from_authorized_user_file(str(GMAIL_TOKEN_PATH), SCOPES)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                from google_auth_oauthlib.flow import InstalledAppFlow
                flow = InstalledAppFlow.from_client_secrets_file(str(GMAIL_CRED_PATH), SCOPES)
                creds = flow.run_local_server(port=0)
            GMAIL_TOKEN_PATH.parent.mkdir(exist_ok=True)
            GMAIL_TOKEN_PATH.write_text(creds.to_json())

        return build("gmail", "v1", credentials=creds)
    except ImportError as e:
        raise RuntimeError(f"Gmail deps missing: {e}. Run: pip install google-api-python-client google-auth-oauthlib")


def send_email(to: str, subject: str, body: str) -> dict:
    """Send an email via Gmail API. Returns {success, message_id}."""
    try:
        service = _get_gmail_service()
        msg = MIMEText(body)
        msg["to"] = to
        msg["subject"] = subject
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()
        return {"success": True, "message_id": sent["id"], "to": to}
    except Exception as e:
        return {"success": False, "error": str(e)}
