"""GTM data model - accounts, contacts, opportunities, signals, ICPs."""
import sqlite3
import uuid
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "gtm.db"


def get_conn():
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize all tables and indexes (CONSTR_01_4: indexing for scale).

    Indexes created for query performance at scale:
    - idx_accounts_domain: B-tree on accounts.domain (primary lookup key)
    - idx_contacts_account: B-tree on contacts.account_id (all contact queries)
    - idx_signals_account: B-tree on signals.account_id (signal feed queries)
    - idx_opportunities_account: B-tree on opportunities.account_id (pipeline queries)

    To add a new entity: (1) add CREATE TABLE IF NOT EXISTS below,
    (2) add CRUD helpers following the try/finally pattern used here,
    (3) document in architecture.md.
    """
    conn = get_conn()
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id          TEXT PRIMARY KEY,
            domain      TEXT UNIQUE NOT NULL,
            name        TEXT NOT NULL,
            industry    TEXT,
            size        TEXT,
            icp_score   REAL DEFAULT 0.0,
            signals     TEXT DEFAULT '[]',
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id          TEXT PRIMARY KEY,
            account_id  TEXT REFERENCES accounts(id),
            name        TEXT NOT NULL,
            title       TEXT,
            email       TEXT,
            linkedin    TEXT,
            score       REAL DEFAULT 0.0,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS opportunities (
            id              TEXT PRIMARY KEY,
            account_id      TEXT REFERENCES accounts(id),
            contact_id      TEXT REFERENCES contacts(id),
            stage           TEXT DEFAULT 'prospecting',
            signal          TEXT,
            value_hypothesis TEXT,
            outreach        TEXT,
            sent_at         TEXT,
            created_at      TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS signals (
            id          TEXT PRIMARY KEY,
            account_id  TEXT REFERENCES accounts(id),
            type        TEXT NOT NULL,
            content     TEXT NOT NULL,
            source      TEXT,
            captured_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS activities (
            id          TEXT PRIMARY KEY,
            account_id  TEXT REFERENCES accounts(id),
            contact_id  TEXT REFERENCES contacts(id),
            type        TEXT NOT NULL,
            description TEXT,
            occurred_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS icp_profiles (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            industries  TEXT DEFAULT '[]',
            sizes       TEXT DEFAULT '[]',
            titles      TEXT DEFAULT '[]',
            keywords    TEXT DEFAULT '[]',
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
        CREATE INDEX IF NOT EXISTS idx_signals_account ON signals(account_id);
        CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
        CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain);
        """)
        conn.commit()
    finally:
        conn.close()


def upsert_account(domain, name, industry=None, size=None):
    conn = get_conn()
    try:
        existing = conn.execute("SELECT id FROM accounts WHERE domain=?", (domain,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE accounts SET name=?, industry=?, size=?, updated_at=datetime('now') WHERE domain=?",
                (name, industry, size, domain)
            )
            aid = existing["id"]
        else:
            aid = str(uuid.uuid4())[:8]
            conn.execute(
                "INSERT INTO accounts (id,domain,name,industry,size) VALUES (?,?,?,?,?)",
                (aid, domain, name, industry, size)
            )
        conn.commit()
        return aid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"upsert_account failed for {domain}: {e}") from e
    finally:
        conn.close()


def upsert_contact(account_id, name, title=None, email=None, linkedin=None):
    conn = get_conn()
    try:
        existing = conn.execute(
            "SELECT id FROM contacts WHERE account_id=? AND name=?", (account_id, name)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE contacts SET title=?, email=?, linkedin=? WHERE id=?",
                (title, email, linkedin, existing["id"])
            )
            cid = existing["id"]
        else:
            cid = str(uuid.uuid4())[:8]
            conn.execute(
                "INSERT INTO contacts (id,account_id,name,title,email,linkedin) VALUES (?,?,?,?,?,?)",
                (cid, account_id, name, title, email, linkedin)
            )
        conn.commit()
        return cid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"upsert_contact failed for {name}: {e}") from e
    finally:
        conn.close()


def add_signal(account_id, type_, content, source=None):
    conn = get_conn()
    try:
        sid = str(uuid.uuid4())[:8]
        conn.execute(
            "INSERT INTO signals (id,account_id,type,content,source) VALUES (?,?,?,?,?)",
            (sid, account_id, type_, content, source)
        )
        conn.commit()
        return sid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"add_signal failed: {e}") from e
    finally:
        conn.close()


def save_value_hypothesis(account_id: str, contact_id: str, signal: str, hypothesis: str, outreach: str) -> str:
    """Persist a context-aware value hypothesis generated by the agent LLM to the data model."""
    conn = get_conn()
    try:
        oid = str(uuid.uuid4())[:8]
        conn.execute(
            "INSERT INTO opportunities (id,account_id,contact_id,stage,signal,value_hypothesis,outreach) VALUES (?,?,?,?,?,?,?)",
            (oid, account_id, contact_id, "prospecting", signal, hypothesis, outreach)
        )
        conn.commit()
        return oid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"save_value_hypothesis failed: {e}") from e
    finally:
        conn.close()


def add_opportunity(account_id, contact_id, stage, signal, outreach):
    conn = get_conn()
    try:
        oid = str(uuid.uuid4())[:8]
        conn.execute(
            "INSERT INTO opportunities (id,account_id,contact_id,stage,signal,outreach) VALUES (?,?,?,?,?,?)",
            (oid, account_id, contact_id, stage, signal, outreach)
        )
        conn.commit()
        return oid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"add_opportunity failed: {e}") from e
    finally:
        conn.close()


def update_icp_score(account_id, score):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE accounts SET icp_score=?, updated_at=datetime('now') WHERE id=?",
            (score, account_id)
        )
        conn.commit()
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"update_icp_score failed: {e}") from e
    finally:
        conn.close()


def get_account(domain):
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM accounts WHERE domain=?", (domain,)).fetchone()
        return dict(row) if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def get_contacts(account_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM contacts WHERE account_id=? ORDER BY score DESC", (account_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def get_signals(account_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 5",
            (account_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def get_opportunity(account_id):
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM opportunities WHERE account_id=? ORDER BY created_at DESC LIMIT 1",
            (account_id,)
        ).fetchone()
        return dict(row) if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def add_activity(account_id, type_, description, contact_id=None):
    conn = get_conn()
    try:
        aid = str(uuid.uuid4())[:8]
        conn.execute(
            "INSERT INTO activities (id,account_id,contact_id,type,description) VALUES (?,?,?,?,?)",
            (aid, account_id, contact_id, type_, description)
        )
        conn.commit()
        return aid
    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"add_activity failed: {e}") from e
    finally:
        conn.close()


def get_activities(account_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM activities WHERE account_id=? ORDER BY occurred_at DESC",
            (account_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()
