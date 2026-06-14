"""FastAPI backend - GTM platform API."""
import json
import re
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, field_validator

from .agent import GTMAgent
from .models import init_db, get_account, get_contacts, get_signals, get_opportunity

app = FastAPI(title="GTM Platform", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://localhost:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

TRACES_DIR = Path(__file__).parent.parent / "traces"
PROSPECT_DIR = Path(__file__).parent.parent / "prospect"


class ProspectRequest(BaseModel):
    domain: str
    send_to: Optional[str] = None

    @field_validator('domain')
    @classmethod
    def domain_safe(cls, v: str) -> str:
        if not re.match(r'^[a-zA-Z0-9.-]{1,253}$', v):
            raise ValueError('Invalid domain')
        return v.lower()


class EmailRequest(BaseModel):
    to: str
    subject: str
    body: str


@app.on_event("startup")
def startup():
    init_db()
    from .seed import seed
    seed()


@app.get("/", response_class=HTMLResponse)
def root():
    index = PROSPECT_DIR / "index.html"
    return index.read_text()


@app.post("/api/prospect")
def prospect(req: ProspectRequest):
    """Six-step prospect loop UI entry point. ERROR HANDLING: try/except wraps all agent execution.

    Called by prospect/index.html when user clicks 'Run Prospect Loop'.
    Runs the full agent loop: search_news -> search_contacts -> score_icp
    -> save_contact -> draft_email (generates + persists value hypothesis) -> ANSWER.
    Returns trace_id, icp_score, contacts_found, signals, steps.
    UI displays step progress, metrics, and full agent trace.

    Error handling (CONSTR_20_2):
    - ValueError -> HTTP 422 with structured JSON: {error, domain, step}
    - Any Exception -> HTTP 500 with structured JSON: {error, domain, step}
    - UI receives structured error response and shows error banner with retry button.
    """
    try:
        agent = GTMAgent(verbose=True)
        result = agent.run(req.domain, send_to=req.send_to)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"error": str(e), "domain": req.domain, "step": "validation"})
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail={"error": str(e), "domain": req.domain, "step": "agent_run"})


@app.get("/api/account/{domain}")
def account(domain: str):
    acc = get_account(domain)
    if not acc:
        raise HTTPException(404, "Account not found")
    contacts = get_contacts(acc["id"])
    signals = get_signals(acc["id"])
    opp = get_opportunity(acc["id"])
    return {**acc, "contacts": contacts, "signals": signals, "opportunity": opp}


@app.get("/api/traces")
def list_traces():
    traces = []
    for f in sorted(TRACES_DIR.glob("trace_*.json"), reverse=True)[:10]:
        data = json.loads(f.read_text())
        first = next((s for s in data if s["type"] == "START"), {})
        last = next((s for s in reversed(data) if s["type"] == "FINAL"), {})
        traces.append({
            "id": f.stem.replace("trace_", ""),
            "domain": first.get("content", "").replace("Prospecting ", ""),
            "steps": len(data),
            "summary": last.get("content", "")[:100],
            "file": f.name,
        })
    return traces


@app.get("/api/traces/{trace_id}")
def get_trace(trace_id: str):
    if not re.match(r'^[a-f0-9]{8}$', trace_id):
        raise HTTPException(400, "Invalid trace ID")
    f = TRACES_DIR / f"trace_{trace_id}.json"
    if not f.exists():
        raise HTTPException(404, "Trace not found")
    return json.loads(f.read_text())


@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}
