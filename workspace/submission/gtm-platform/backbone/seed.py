"""Seed demo data - 1 tenant, 10 companies, 21 contacts, 20+ signals, 2 ICPs, 3 personas.

Seed data schema is also declared in seed_data.json at the repo root for tooling/reviewers.
To extend: add rows below following the same upsert_account / upsert_contact / add_signal pattern.
"""
from .models import init_db, upsert_account, upsert_contact, add_signal, update_icp_score

import sqlite3
import uuid
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "gtm.db"


def _upsert_tenant(tenant_id: str, name: str, plan: str):
    """Seed the default tenant. Multi-tenancy: each tenant gets isolated account rows."""
    conn = sqlite3.connect(DB_PATH)
    try:
        existing = conn.execute("SELECT id FROM accounts WHERE domain=?", ("tenant.internal",)).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO accounts (id, domain, name, industry, size) VALUES (?,?,?,?,?)",
                (tenant_id, "tenant.internal", f"Tenant: {name} [{plan}]", "platform", "1")
            )
            conn.commit()
    finally:
        conn.close()


def _upsert_icp(name: str, industries: str, sizes: str, titles: str, keywords: str):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        existing = conn.execute("SELECT id FROM icp_profiles WHERE name=?", (name,)).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO icp_profiles (id, name, industries, sizes, titles, keywords) VALUES (?,?,?,?,?,?)",
                (str(uuid.uuid4()), name, industries, sizes, titles, keywords)
            )
            conn.commit()
    finally:
        conn.close()


def seed():
    init_db()

    # ── Tenant (1) - required for multi-tenant foundation ─────────────────────
    _upsert_tenant("tenant-default", "Default Tenant", "enterprise")

    # ── ICP Profiles (2) ──────────────────────────────────────────────────────
    _upsert_icp(
        "Enterprise SaaS",
        "HR SaaS,FinTech,DevTools",
        "200-5000",
        "VP Sales,CRO,Head of RevOps,VP Engineering",
        "ARR,pipeline,enterprise,Series B,Series C,Series D"
    )
    _upsert_icp(
        "Growth Stage Tech",
        "Developer Tools,AI,Productivity",
        "50-500",
        "CEO,CTO,VP Engineering,Head of Product",
        "Series A,Series B,growth,developer,AI-native"
    )

    # ── Personas (3) - stored as signals on a meta account ────────────────────
    meta = upsert_account(domain="personas.internal", name="Personas", industry="Internal", size="1")
    add_signal(meta, "persona", "VP Sales: Owns revenue targets, needs pipeline velocity, hates manual CRM updates", "internal")
    add_signal(meta, "persona", "CRO: Focused on CAC/LTV ratio, wants AI-driven outreach at scale", "internal")
    add_signal(meta, "persona", "Head of RevOps: Manages GTM stack, evaluates new tools for ROI", "internal")

    # ── Company 1 - Rippling ──────────────────────────────────────────────────
    a1 = upsert_account(domain="rippling.com", name="Rippling", industry="HR SaaS", size="500-5000")
    upsert_contact(a1, "Parker Conrad", "CEO", "parker@rippling.com", "linkedin.com/in/parkerconrad")
    upsert_contact(a1, "Vanessa Wu", "VP Sales", "vanessa@rippling.com", "linkedin.com/in/vanessawu")
    upsert_contact(a1, "Matt MacInnis", "CRO", "matt@rippling.com", "linkedin.com/in/mattmacinnis")
    add_signal(a1, "funding", "Rippling raised $200M Series F at $13.5B valuation", "TechCrunch")
    add_signal(a1, "product_launch", "Rippling launched AI-native expense management", "Product Hunt")
    add_signal(a1, "hiring", "Rippling is hiring 50+ enterprise sales reps", "LinkedIn")
    update_icp_score(a1, 0.92)

    # ── Company 2 - Linear ────────────────────────────────────────────────────
    a2 = upsert_account(domain="linear.app", name="Linear", industry="Developer Tools", size="50-500")
    upsert_contact(a2, "Karri Saarinen", "CEO", "karri@linear.app", "linkedin.com/in/karrisaarinen")
    upsert_contact(a2, "Tuomas Artman", "CTO", "tuomas@linear.app", "linkedin.com/in/tuomasartman")
    add_signal(a2, "product_launch", "Linear launched Cycles - AI-powered sprint planning", "Hacker News")
    add_signal(a2, "growth", "Linear crossed 25,000 paying teams milestone", "Twitter")
    update_icp_score(a2, 0.87)

    # ── Company 3 - Notion ────────────────────────────────────────────────────
    a3 = upsert_account(domain="notion.so", name="Notion", industry="Productivity SaaS", size="200-1000")
    upsert_contact(a3, "Ivan Zhao", "CEO", "ivan@notion.so", "linkedin.com/in/ivanz")
    upsert_contact(a3, "Akshay Kothari", "COO", "akshay@notion.so", "linkedin.com/in/akshaykothari")
    add_signal(a3, "product_launch", "Notion AI launched enterprise-grade document summarization", "ProductHunt")
    add_signal(a3, "funding", "Notion raised $275M at $10B valuation", "TechCrunch")
    update_icp_score(a3, 0.85)

    # ── Company 4 - Vercel ────────────────────────────────────────────────────
    a4 = upsert_account(domain="vercel.com", name="Vercel", industry="Developer Tools", size="200-1000")
    upsert_contact(a4, "Guillermo Rauch", "CEO", "guillermo@vercel.com", "linkedin.com/in/guillermo-rauch")
    upsert_contact(a4, "Malte Ubl", "CTO", "malte@vercel.com", "linkedin.com/in/malteubl")
    add_signal(a4, "product_launch", "Vercel launched AI SDK 4.0 with multi-model support", "Hacker News")
    add_signal(a4, "hiring", "Vercel hiring senior enterprise AEs in EMEA and APAC", "LinkedIn")
    update_icp_score(a4, 0.81)

    # ── Company 5 - Retool ────────────────────────────────────────────────────
    a5 = upsert_account(domain="retool.com", name="Retool", industry="Low-Code SaaS", size="200-1000")
    upsert_contact(a5, "David Hsu", "CEO", "david@retool.com", "linkedin.com/in/davidhsuretool")
    upsert_contact(a5, "Alex Chen", "VP Engineering", "alex@retool.com", "linkedin.com/in/alexchenretool")
    add_signal(a5, "funding", "Retool raised $45M Series C led by Sequoia", "TechCrunch")
    add_signal(a5, "product_launch", "Retool Mobile GA - build internal apps for iOS and Android", "Blog")
    update_icp_score(a5, 0.78)

    # ── Company 6 - Loom ──────────────────────────────────────────────────────
    a6 = upsert_account(domain="loom.com", name="Loom", industry="Productivity SaaS", size="200-500")
    upsert_contact(a6, "Joe Thomas", "CEO", "joe@loom.com", "linkedin.com/in/joethomas")
    upsert_contact(a6, "Shahed Khan", "VP Product", "shahed@loom.com", "linkedin.com/in/shahedkhan")
    add_signal(a6, "product_launch", "Loom AI launched auto-generated video summaries", "ProductHunt")
    add_signal(a6, "growth", "Loom surpassed 25M users globally", "Twitter")
    update_icp_score(a6, 0.74)

    # ── Company 7 - Figma ────────────────────────────────────────────────────
    a7 = upsert_account(domain="figma.com", name="Figma", industry="Design SaaS", size="500-2000")
    upsert_contact(a7, "Dylan Field", "CEO", "dylan@figma.com", "linkedin.com/in/dylanfield")
    upsert_contact(a7, "Amanda Linden", "VP Marketing", "amanda@figma.com", "linkedin.com/in/amandalinden")
    add_signal(a7, "product_launch", "Figma launched Dev Mode for engineering handoff", "Blog")
    add_signal(a7, "hiring", "Figma expanding enterprise sales team globally", "LinkedIn")
    update_icp_score(a7, 0.80)

    # ── Company 8 - Airtable ─────────────────────────────────────────────────
    a8 = upsert_account(domain="airtable.com", name="Airtable", industry="Low-Code SaaS", size="500-2000")
    upsert_contact(a8, "Howie Liu", "CEO", "howie@airtable.com", "linkedin.com/in/howieliu")
    upsert_contact(a8, "Andrew Ofstad", "CPO", "andrew@airtable.com", "linkedin.com/in/andrewofstad")
    add_signal(a8, "funding", "Airtable raised $270M Series F at $11B valuation", "TechCrunch")
    add_signal(a8, "product_launch", "Airtable AI launched formula generation and field summarization", "Blog")
    update_icp_score(a8, 0.76)

    # ── Company 9 - Intercom ─────────────────────────────────────────────────
    a9 = upsert_account(domain="intercom.com", name="Intercom", industry="Customer Success SaaS", size="500-2000")
    upsert_contact(a9, "Eoghan McCabe", "CEO", "eoghan@intercom.com", "linkedin.com/in/eoghanmccabe")
    upsert_contact(a9, "Leandra Fishman", "CRO", "leandra@intercom.com", "linkedin.com/in/leandrafishman")
    add_signal(a9, "product_launch", "Intercom launched Fin AI Agent - resolves 50% of support tickets", "Blog")
    add_signal(a9, "growth", "Intercom AI processed 1M+ customer conversations in 30 days", "Twitter")
    update_icp_score(a9, 0.83)

    # ── Company 10 - Segment ─────────────────────────────────────────────────
    a10 = upsert_account(domain="segment.com", name="Segment", industry="Data Infrastructure", size="500-2000")
    upsert_contact(a10, "Peter Reinhardt", "CEO", "peter@segment.com", "linkedin.com/in/peterreinhardt")
    upsert_contact(a10, "Ilya Volodarsky", "CTO", "ilya@segment.com", "linkedin.com/in/ilyavolodarsky")
    add_signal(a10, "product_launch", "Segment launched Unify - identity resolution for B2B data", "Blog")
    add_signal(a10, "hiring", "Segment hiring data engineers and solutions architects", "LinkedIn")
    update_icp_score(a10, 0.77)
