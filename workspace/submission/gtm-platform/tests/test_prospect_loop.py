"""Integration tests for the full Prospect loop, agent orchestration, and multi-tenancy."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Make sure we can import backbone from the repo root
sys.path.insert(0, str(Path(__file__).parent.parent))

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-placeholder")
os.environ.setdefault("SERPER_API_KEY", "test-key-placeholder")


class TestDataModel(unittest.TestCase):
    """Tests for the data layer - accounts, contacts, opportunities, signals."""

    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.db_path = self.db_file.name
        self.db_file.close()

        import backbone.models as models
        self._orig_db_path = models.DB_PATH
        models.DB_PATH = Path(self.db_path)
        models.init_db()

    def tearDown(self):
        import backbone.models as models
        models.DB_PATH = self._orig_db_path
        Path(self.db_path).unlink(missing_ok=True)

    def test_upsert_account_creates_and_returns_id(self):
        from backbone.models import upsert_account, get_account
        aid = upsert_account("test.com", "Test Corp", industry="SaaS")
        self.assertIsNotNone(aid)
        self.assertEqual(len(aid), 8)

        acc = get_account("test.com")
        self.assertEqual(acc["domain"], "test.com")
        self.assertEqual(acc["name"], "Test Corp")
        self.assertEqual(acc["industry"], "SaaS")

    def test_upsert_account_idempotent(self):
        from backbone.models import upsert_account
        id1 = upsert_account("idempotent.com", "Idempotent Corp")
        id2 = upsert_account("idempotent.com", "Idempotent Corp Updated")
        self.assertEqual(id1, id2)

    def test_upsert_contact_saves_and_retrieves(self):
        from backbone.models import upsert_account, upsert_contact, get_contacts
        aid = upsert_account("contacts.com", "Contacts Corp")
        cid = upsert_contact(aid, "Jane Doe", title="CTO", email="jane@contacts.com")
        self.assertIsNotNone(cid)

        contacts = get_contacts(aid)
        self.assertEqual(len(contacts), 1)
        self.assertEqual(contacts[0]["name"], "Jane Doe")
        self.assertEqual(contacts[0]["title"], "CTO")
        self.assertEqual(contacts[0]["email"], "jane@contacts.com")

    def test_add_signal_and_retrieve(self):
        from backbone.models import upsert_account, add_signal, get_signals
        aid = upsert_account("signals.com", "Signals Corp")
        add_signal(aid, "funding", "Raised $50M Series B", "serper")

        signals = get_signals(aid)
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]["type"], "funding")
        self.assertIn("$50M", signals[0]["content"])

    def test_update_icp_score(self):
        from backbone.models import upsert_account, update_icp_score, get_account
        aid = upsert_account("icp.com", "ICP Corp")
        update_icp_score(aid, 0.87)

        acc = get_account("icp.com")
        self.assertAlmostEqual(acc["icp_score"], 0.87, places=2)

    def test_multi_tenancy_isolation(self):
        """Contacts for account A must not appear in account B queries."""
        from backbone.models import upsert_account, upsert_contact, get_contacts
        aid_a = upsert_account("tenant-a.com", "Tenant A")
        aid_b = upsert_account("tenant-b.com", "Tenant B")

        upsert_contact(aid_a, "Alice A", title="CEO", email="alice@tenant-a.com")
        upsert_contact(aid_a, "Bob A", title="CTO", email="bob@tenant-a.com")
        upsert_contact(aid_b, "Carol B", title="VP Sales", email="carol@tenant-b.com")

        contacts_a = get_contacts(aid_a)
        contacts_b = get_contacts(aid_b)

        self.assertEqual(len(contacts_a), 2)
        self.assertEqual(len(contacts_b), 1)

        names_a = {c["name"] for c in contacts_a}
        names_b = {c["name"] for c in contacts_b}
        self.assertIn("Alice A", names_a)
        self.assertIn("Bob A", names_a)
        self.assertNotIn("Carol B", names_a)
        self.assertIn("Carol B", names_b)
        self.assertNotIn("Alice A", names_b)

    def test_signals_isolation_across_accounts(self):
        """Signals for account A must not appear in account B queries."""
        from backbone.models import upsert_account, add_signal, get_signals
        aid_a = upsert_account("sig-a.com", "Signal A")
        aid_b = upsert_account("sig-b.com", "Signal B")

        add_signal(aid_a, "funding", "A raised $10M", "serper")
        add_signal(aid_b, "launch", "B launched product", "serper")

        sigs_a = get_signals(aid_a)
        sigs_b = get_signals(aid_b)

        self.assertEqual(len(sigs_a), 1)
        self.assertEqual(len(sigs_b), 1)
        self.assertIn("$10M", sigs_a[0]["content"])
        self.assertIn("product", sigs_b[0]["content"])


class TestAgentOrchestration(unittest.TestCase):
    """Tests for agent parsing, ICP scoring, and tool dispatch."""

    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.db_path = self.db_file.name
        self.db_file.close()

        import backbone.models as models
        self._orig_db_path = models.DB_PATH
        models.DB_PATH = Path(self.db_path)
        models.init_db()

    def tearDown(self):
        import backbone.models as models
        models.DB_PATH = self._orig_db_path
        Path(self.db_path).unlink(missing_ok=True)

    def _make_agent(self):
        from backbone.agent import GTMAgent
        agent = GTMAgent(verbose=False)
        return agent

    def test_parse_response_action_format(self):
        agent = self._make_agent()
        text = """THOUGHT: I need to search for news about Stripe.
ACTION: search_news
ARGS: {"company": "Stripe"}"""
        thought, action, args, answer = agent._parse_response(text)
        self.assertEqual(action, "search_news")
        self.assertEqual(args, {"company": "Stripe"})
        self.assertEqual(answer, "")
        self.assertIn("Stripe", thought)

    def test_parse_response_answer_format(self):
        agent = self._make_agent()
        text = """THOUGHT: All steps complete, summarizing.
ANSWER: Prospected Stripe - found VP Engineering, ICP score 0.85, email drafted."""
        thought, action, args, answer = agent._parse_response(text)
        self.assertEqual(action, "")
        self.assertIn("Stripe", answer)

    def test_parse_response_malformed_args(self):
        agent = self._make_agent()
        text = """THOUGHT: Searching.
ACTION: search_news
ARGS: {invalid json here"""
        _, action, args, _ = agent._parse_response(text)
        self.assertEqual(action, "search_news")
        self.assertEqual(args, {})

    def test_icp_score_baseline(self):
        agent = self._make_agent()
        score = agent._compute_icp_score("generic company")
        self.assertAlmostEqual(score, 0.5, places=2)

    def test_icp_score_increases_with_keywords(self):
        agent = self._make_agent()
        score = agent._compute_icp_score(
            "SaaS company with AI automation and scaling growth, founded by CEO in Fintech"
        )
        self.assertGreater(score, 0.5)
        self.assertLessEqual(score, 1.0)

    def test_icp_score_caps_at_1(self):
        agent = self._make_agent()
        reasoning = " ".join([
            "SaaS Fintech AI Developer Tools Enterprise Software",
            "scaling growth automation efficiency AI",
            "CEO CTO VP Engineering VP Sales Head of Growth Founder",
        ])
        score = agent._compute_icp_score(reasoning)
        self.assertLessEqual(score, 1.0)

    def test_draft_email_uses_signal(self):
        agent = self._make_agent()
        email = agent._draft_email({
            "contact_name": "Jane Doe",
            "title": "CTO",
            "company": "Acme",
            "signal": "raised $50M Series B to expand AI platform",
            "sender_context": "I built an AI-native GTM tool"
        })
        self.assertIn("$50M", email["subject"] + email["body"])
        self.assertIn("Jane", email["body"])
        self.assertIn("Acme", email["body"])

    def test_tool_dispatch_score_icp(self):
        from backbone.models import upsert_account
        agent = self._make_agent()
        aid = upsert_account("dispatch.com", "Dispatch Corp")
        result = json.loads(agent._call_tool(
            "score_icp",
            {"account_id": aid, "reasoning": "SaaS company scaling with AI CEO"},
            account_id=aid
        ))
        self.assertIn("score", result)
        self.assertGreater(result["score"], 0.5)

    def test_tool_dispatch_save_contact(self):
        from backbone.models import upsert_account, get_contacts
        agent = self._make_agent()
        aid = upsert_account("savetest.com", "Save Test Corp")
        result = json.loads(agent._call_tool(
            "save_contact",
            {"account_id": aid, "name": "John Smith", "title": "VP Sales", "email": "john@savetest.com"},
            account_id=aid
        ))
        self.assertTrue(result["success"])

        contacts = get_contacts(aid)
        self.assertEqual(len(contacts), 1)
        self.assertEqual(contacts[0]["name"], "John Smith")

    def test_tool_dispatch_unknown_tool(self):
        agent = self._make_agent()
        result = json.loads(agent._call_tool("nonexistent_tool", {}))
        self.assertIn("error", result)
        self.assertIn("nonexistent_tool", result["error"])


class TestFullProspectLoop(unittest.TestCase):
    """Integration test - full Prospect loop with mocked LLM and real Serper."""

    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.db_path = self.db_file.name
        self.db_file.close()
        self.traces_dir = tempfile.mkdtemp()

        import backbone.models as models
        self._orig_db_path = models.DB_PATH
        models.DB_PATH = Path(self.db_path)
        models.init_db()

    def tearDown(self):
        import backbone.models as models
        models.DB_PATH = self._orig_db_path
        Path(self.db_path).unlink(missing_ok=True)

    def _make_scripted_responses(self):
        """Return a sequence of LLM responses that run all 6 required steps."""
        return [
            # Step 1: search_news
            """THOUGHT: I need to search for recent news about Linear.
ACTION: search_news
ARGS: {"company": "Linear"}""",
            # Step 2: search_contacts
            """THOUGHT: Found funding news. Now searching for contacts at linear.app.
ACTION: search_contacts
ARGS: {"domain": "linear.app"}""",
            # Step 3: score_icp
            """THOUGHT: Found VP Engineering. Linear is a SaaS developer tool company scaling with AI. Good ICP fit.
ACTION: score_icp
ARGS: {"account_id": "__ACCOUNT_ID__", "reasoning": "Linear is a SaaS Developer Tools company scaling with AI automation for engineering teams. CEO and VP Engineering present."}""",
            # Step 4: save_contact
            """THOUGHT: ICP score saved. Now saving the best contact.
ACTION: save_contact
ARGS: {"account_id": "__ACCOUNT_ID__", "name": "Karri Saarinen", "title": "CEO", "email": "karri@linear.app"}""",
            # Step 5: draft_email
            """THOUGHT: Contact saved. Drafting personalized email using the funding signal.
ACTION: draft_email
ARGS: {"contact_name": "Karri Saarinen", "title": "CEO", "company": "Linear", "signal": "raised $35M Series B to expand developer tooling", "sender_context": "I built an AI-native GTM layer that helps teams find the right accounts at the right moment"}""",
            # Step 6: ANSWER
            """THOUGHT: Email drafted. All 6 steps complete.
ANSWER: Prospected linear.app - found CEO Karri Saarinen, ICP score above 0.7 (SaaS Developer Tools, scaling), email drafted referencing Series B raise. Draft only - no email sent.""",
        ]

    @patch("backbone.agent.GTMAgent._call_tool")
    def test_full_loop_calls_all_steps(self, mock_call_tool):
        """Verify the agent calls all 6 required tools in order when LLM follows the protocol."""
        mock_call_tool.return_value = json.dumps({"results": ["signal1"], "success": True, "score": 0.8})

        from backbone.agent import GTMAgent
        import backbone.agent as agent_mod

        responses = self._make_scripted_responses()
        response_iter = iter(responses)

        def fake_llm_call(**kwargs):
            text = next(response_iter, "THOUGHT: Done.\nANSWER: Complete.")
            mock_msg = MagicMock()
            mock_msg.content = [MagicMock(text=text)]
            return mock_msg

        agent = GTMAgent(verbose=False)
        agent.client = MagicMock()
        agent.client.messages.create.side_effect = fake_llm_call

        with patch.object(agent_mod, "TRACES_DIR", Path(self.traces_dir)):
            result = agent.run("linear.app")

        self.assertIn("trace_id", result)
        self.assertIn("domain", result)
        self.assertEqual(result["domain"], "linear.app")

        called_tools = [
            call.args[0] if call.args else call.kwargs.get("tool")
            for call in mock_call_tool.call_args_list
        ]
        expected_tools = ["search_news", "search_contacts", "score_icp", "save_contact", "draft_email"]
        for tool in expected_tools:
            self.assertIn(tool, called_tools, f"Expected tool '{tool}' to be called")

    @patch("backbone.agent.GTMAgent._call_tool")
    def test_trace_file_saved(self, mock_call_tool):
        """Verify trace JSON is written to /traces/ after a run."""
        mock_call_tool.return_value = json.dumps({"success": True})

        from backbone.agent import GTMAgent
        import backbone.agent as agent_mod

        agent = GTMAgent(verbose=False)
        agent.client = MagicMock()
        agent.client.messages.create.return_value = MagicMock(
            content=[MagicMock(text="THOUGHT: Done.\nANSWER: Prospect complete.")]
        )

        with patch.object(agent_mod, "TRACES_DIR", Path(self.traces_dir)):
            result = agent.run("tracetest.com")

        trace_files = list(Path(self.traces_dir).glob("trace_*.json"))
        self.assertEqual(len(trace_files), 1)

        trace = json.loads(trace_files[0].read_text())
        self.assertIsInstance(trace, list)
        self.assertGreater(len(trace), 0)

        types = {step["type"] for step in trace}
        self.assertIn("START", types)

    def test_multi_tenancy_separate_runs(self):
        """Two separate prospect runs must not share contacts or signals."""
        from backbone.models import upsert_account, upsert_contact, add_signal, get_contacts, get_signals

        aid_a = upsert_account("alpha.com", "Alpha Corp")
        aid_b = upsert_account("beta.com", "Beta Corp")

        upsert_contact(aid_a, "Alice Alpha", title="CEO", email="alice@alpha.com")
        upsert_contact(aid_b, "Bob Beta", title="CTO", email="bob@beta.com")
        add_signal(aid_a, "funding", "Alpha raised $20M", "test")
        add_signal(aid_b, "launch", "Beta launched v2", "test")

        contacts_a = get_contacts(aid_a)
        contacts_b = get_contacts(aid_b)
        signals_a = get_signals(aid_a)
        signals_b = get_signals(aid_b)

        self.assertEqual(len(contacts_a), 1)
        self.assertEqual(len(contacts_b), 1)
        self.assertEqual(contacts_a[0]["name"], "Alice Alpha")
        self.assertEqual(contacts_b[0]["name"], "Bob Beta")
        self.assertNotEqual(contacts_a[0]["account_id"], contacts_b[0]["account_id"])

        self.assertEqual(signals_a[0]["type"], "funding")
        self.assertEqual(signals_b[0]["type"], "launch")


class TestAPIEndpoints(unittest.TestCase):
    """Tests for the FastAPI endpoints."""

    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.db_path = self.db_file.name
        self.db_file.close()

        import backbone.models as models
        self._orig_db_path = models.DB_PATH
        models.DB_PATH = Path(self.db_path)
        models.init_db()

    def tearDown(self):
        import backbone.models as models
        models.DB_PATH = self._orig_db_path
        Path(self.db_path).unlink(missing_ok=True)

    def _get_client(self):
        try:
            from fastapi.testclient import TestClient
            from backbone.api import app
            return TestClient(app, raise_server_exceptions=False)
        except ImportError:
            self.skipTest("httpx not installed - run: pip install httpx")

    def test_health_endpoint(self):
        client = self._get_client()
        response = client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")

    def test_traces_endpoint_returns_list(self):
        client = self._get_client()
        response = client.get("/api/traces")
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), list)

    def test_account_endpoint_404_for_unknown(self):
        client = self._get_client()
        response = client.get("/api/account/definitely-does-not-exist-xyz.com")
        self.assertEqual(response.status_code, 404)

    def test_account_endpoint_returns_data_for_known(self):
        from backbone.models import upsert_account, upsert_contact
        aid = upsert_account("known.com", "Known Corp")
        upsert_contact(aid, "Test User", title="CEO", email="test@known.com")

        client = self._get_client()
        response = client.get("/api/account/known.com")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["domain"], "known.com")
        self.assertEqual(len(data["contacts"]), 1)

    def test_prospect_endpoint_validates_domain_required(self):
        client = self._get_client()
        response = client.post("/api/prospect", json={"send_to": None})
        self.assertEqual(response.status_code, 422)

    def test_prospect_endpoint_accepts_null_send_to(self):
        """send_to: null must not cause a 422 validation error."""
        client = self._get_client()
        with patch("backbone.api.GTMAgent") as MockAgent:
            mock_instance = MockAgent.return_value
            mock_instance.run.return_value = {
                "trace_id": "abc12345",
                "domain": "null-test.com",
                "account_id": "test1234",
                "icp_score": 0.75,
                "contacts_found": 1,
                "signals": 2,
                "steps": 6,
                "trace_path": "/tmp/trace_abc12345.json",
            }
            response = client.post("/api/prospect", json={"domain": "null-test.com", "send_to": None})
        self.assertNotEqual(response.status_code, 422)
        self.assertEqual(response.status_code, 200)


class TestCrossTenantIsolation(unittest.TestCase):
    """REQ_02: Verify data from one tenant cannot be accessed by another."""

    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.db_path = self.db_file.name
        self.db_file.close()

        import backbone.models as models
        self._orig_db_path = models.DB_PATH
        models.DB_PATH = Path(self.db_path)
        models.init_db()

    def tearDown(self):
        import backbone.models as models
        models.DB_PATH = self._orig_db_path
        Path(self.db_path).unlink(missing_ok=True)

    def test_contacts_isolated_by_account(self):
        """Contacts fetched for account A must not include contacts of account B."""
        from backbone.models import upsert_account, upsert_contact, get_contacts

        aid_a = upsert_account("tenant-a.com", "Tenant A")
        aid_b = upsert_account("tenant-b.com", "Tenant B")

        upsert_contact(aid_a, "Alice A", title="CEO", email="alice@tenant-a.com")
        upsert_contact(aid_b, "Bob B", title="CTO", email="bob@tenant-b.com")

        contacts_a = get_contacts(aid_a)
        contacts_b = get_contacts(aid_b)

        names_a = {c["name"] for c in contacts_a}
        names_b = {c["name"] for c in contacts_b}

        self.assertIn("Alice A", names_a)
        self.assertNotIn("Bob B", names_a)
        self.assertIn("Bob B", names_b)
        self.assertNotIn("Alice A", names_b)

    def test_signals_isolated_by_account(self):
        """Signals fetched for account A must not include signals of account B."""
        from backbone.models import upsert_account, add_signal, get_signals

        aid_a = upsert_account("signal-a.com", "Signal A")
        aid_b = upsert_account("signal-b.com", "Signal B")

        add_signal(aid_a, "funding", "Raised $10M Series A", source="news")
        add_signal(aid_b, "hiring", "Hiring 50 engineers", source="linkedin")

        signals_a = get_signals(aid_a)
        signals_b = get_signals(aid_b)

        contents_a = {s["content"] for s in signals_a}
        contents_b = {s["content"] for s in signals_b}

        self.assertIn("Raised $10M Series A", contents_a)
        self.assertNotIn("Hiring 50 engineers", contents_a)
        self.assertIn("Hiring 50 engineers", contents_b)
        self.assertNotIn("Raised $10M Series A", contents_b)

    def test_opportunity_isolated_by_account(self):
        """Opportunity fetched for account A must not return account B's opportunity."""
        from backbone.models import upsert_account, upsert_contact, add_opportunity, get_opportunity

        aid_a = upsert_account("opp-a.com", "Opp A")
        aid_b = upsert_account("opp-b.com", "Opp B")
        cid_a = upsert_contact(aid_a, "Carol A", title="VP Sales")
        cid_b = upsert_contact(aid_b, "Dave B", title="CFO")

        add_opportunity(aid_a, cid_a, "prospecting", "funding signal A", "email body A")
        add_opportunity(aid_b, cid_b, "prospecting", "funding signal B", "email body B")

        opp_a = get_opportunity(aid_a)
        opp_b = get_opportunity(aid_b)

        self.assertIsNotNone(opp_a)
        self.assertIsNotNone(opp_b)
        self.assertEqual(opp_a["account_id"], aid_a)
        self.assertEqual(opp_b["account_id"], aid_b)
        self.assertNotEqual(opp_a["id"], opp_b["id"])
        self.assertIn("signal A", opp_a["signal"])
        self.assertNotIn("signal B", opp_a["signal"])

    def test_api_account_endpoint_cross_tenant(self):
        """GET /api/account/<domain> must only return data for that specific domain."""
        from backbone.models import upsert_account, upsert_contact

        aid_a = upsert_account("api-a.com", "API Tenant A")
        aid_b = upsert_account("api-b.com", "API Tenant B")
        upsert_contact(aid_a, "Eve A", title="CEO", email="eve@api-a.com")
        upsert_contact(aid_b, "Frank B", title="CTO", email="frank@api-b.com")

        try:
            from fastapi.testclient import TestClient
            from backbone.api import app
            client = TestClient(app, raise_server_exceptions=False)
        except ImportError:
            self.skipTest("httpx not installed")

        resp_a = client.get("/api/account/api-a.com")
        self.assertEqual(resp_a.status_code, 200)
        data_a = resp_a.json()
        contact_names = {c["name"] for c in data_a.get("contacts", [])}
        self.assertIn("Eve A", contact_names)
        self.assertNotIn("Frank B", contact_names)


if __name__ == "__main__":
    unittest.main()
