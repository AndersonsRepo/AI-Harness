"""
codex-runner.py unit tests.

Isolated tests for helpers that do not require spawning the codex CLI.

Run: cd bridges/discord && python3 -m unittest tests.test_codex_runner -v
"""

import importlib.util
import json
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_RUNNER = os.path.normpath(os.path.join(_HERE, "..", "codex-runner.py"))


def _load_helpers():
    """
    Load codex-runner.py's top-level definitions without executing main().

    The file name contains a hyphen so it cannot be imported as a normal
    module. We compile the source up to the 'def main():' sentinel and
    exec it into an isolated namespace.
    """
    with open(_RUNNER, "r", encoding="utf-8") as f:
        src = f.read()
    head = src.split("def main():")[0]
    ns: dict = {"__name__": "codex_runner_helpers", "__file__": _RUNNER}
    exec(compile(head, _RUNNER, "exec"), ns)
    return ns


class StripExecOnlyFlagsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ns = _load_helpers()
        # staticmethod prevents Python from binding `self` as the first arg
        # when the function is accessed via the instance.
        cls.strip = staticmethod(ns["_strip_exec_only_flags"])
        cls.value_flags = ns["_EXEC_ONLY_VALUE_FLAGS"]
        cls.bool_flags = ns["_EXEC_ONLY_BOOL_FLAGS"]

    def test_strips_short_sandbox_flag(self):
        # The original stuck-#general bug: codex-config pushes `-s <sandbox>`
        # and codex exec resume rejects it.
        args = [
            "--json",
            "-s", "workspace-write",
            "-C", "/tmp/work",
            "--skip-git-repo-check",
            "-c", 'approval_policy="never"',
        ]
        self.assertEqual(
            self.strip(args),
            ["--json", "--skip-git-repo-check", "-c", 'approval_policy="never"'],
        )

    def test_strips_long_sandbox_flag(self):
        self.assertEqual(
            self.strip(["--sandbox", "read-only", "--json"]),
            ["--json"],
        )

    def test_strips_equals_form_sandbox(self):
        self.assertEqual(
            self.strip(["--sandbox=read-only", "--json"]),
            ["--json"],
        )

    def test_strips_equals_form_cd(self):
        self.assertEqual(
            self.strip(["--cd=/tmp/work", "--json"]),
            ["--json"],
        )

    def test_strips_bool_oss(self):
        self.assertEqual(
            self.strip(["--oss", "--json"]),
            ["--json"],
        )

    def test_preserves_resume_compatible_flags(self):
        # Every flag here must survive: all are accepted by `codex exec resume`.
        args = [
            "--json",
            "-m", "opus",
            "-c", 'model="o4-mini"',
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-rules",
            "--dangerously-bypass-approvals-and-sandbox",
        ]
        self.assertEqual(self.strip(args), args)

    def test_preserves_config_override_with_equals(self):
        # `-c` takes a key=value value; the value itself contains '=' and
        # must not be confused with an equals-form flag name.
        args = ["-c", 'sandbox_mode="read-only"']
        self.assertEqual(self.strip(args), args)

    def test_empty_args(self):
        self.assertEqual(self.strip([]), [])

    def test_strips_profile_and_add_dir(self):
        args = [
            "-p", "myprofile",
            "--add-dir", "/other/path",
            "--json",
        ]
        self.assertEqual(self.strip(args), ["--json"])

    def test_value_flags_set_is_authoritative_subset(self):
        # Guardrail: if someone adds a new entry to _EXEC_ONLY_VALUE_FLAGS
        # with a value form, the empty-args strip should still succeed.
        self.assertIn("-s", self.value_flags)
        self.assertIn("--sandbox", self.value_flags)
        self.assertIn("-C", self.value_flags)
        self.assertIn("--cd", self.value_flags)
        self.assertIn("--oss", self.bool_flags)


class AgentToolPolicyTests(unittest.TestCase):
    """Codex enforces per-agent tool restrictions via CODEX_TOOL_POLICY,
    parity with Claude's --allowedTools / --disallowedTools flags."""

    @classmethod
    def setUpClass(cls):
        ns = _load_helpers()
        cls.scan = staticmethod(ns["scan_for_policy_violation"])
        cls.classify = staticmethod(ns["_classify_event"])

    def _bash_event(self, command):
        return json.dumps({
            "type": "item.completed",
            "item": {"type": "command_execution", "command": command},
        })

    def _mcp_event(self, server, tool, args=None):
        return json.dumps({
            "type": "item.completed",
            "item": {
                "type": "mcp_tool_call",
                "server": server,
                "tool": tool,
                "arguments": args or {},
            },
        })

    def _whitelist_policy(self, bash_patterns=None, mcp_patterns=None):
        return {
            "mode": "whitelist",
            "bashPatterns": [
                (p["id"], __import__("re").compile(p["regex"], __import__("re").IGNORECASE if p.get("caseInsensitive") else 0))
                for p in (bash_patterns or [])
            ],
            "mcpPatterns": set(mcp_patterns or []),
        }

    def _blacklist_policy(self, bash_patterns=None, mcp_patterns=None):
        return {
            "mode": "blacklist",
            "bashPatterns": [
                (p["id"], __import__("re").compile(p["regex"], __import__("re").IGNORECASE if p.get("caseInsensitive") else 0))
                for p in (bash_patterns or [])
            ],
            "mcpPatterns": set(mcp_patterns or []),
        }

    def test_returns_none_when_policy_unset(self):
        self.assertIsNone(self.scan(self._bash_event("npm install"), None))

    def test_blacklist_kills_matching_bash(self):
        policy = self._blacklist_policy(
            bash_patterns=[{"id": "bash-npm", "regex": r"\bnpm\b"}],
        )
        hit = self.scan(self._bash_event("npm install lodash"), policy)
        self.assertIsNotNone(hit)
        self.assertIn("policy-blacklist-bash", hit[0])

    def test_blacklist_lets_through_non_matching_bash(self):
        policy = self._blacklist_policy(
            bash_patterns=[{"id": "bash-npm", "regex": r"\bnpm\b"}],
        )
        self.assertIsNone(self.scan(self._bash_event("ls /tmp"), policy))

    def test_blacklist_kills_disallowed_mcp(self):
        policy = self._blacklist_policy(mcp_patterns=["mcp__codex__codex"])
        hit = self.scan(self._mcp_event("codex", "codex"), policy)
        self.assertIsNotNone(hit)
        self.assertIn("policy-blacklist-mcp", hit[0])

    def test_blacklist_allows_other_mcp(self):
        policy = self._blacklist_policy(mcp_patterns=["mcp__codex__codex"])
        self.assertIsNone(self.scan(self._mcp_event("vault", "vault_read"), policy))

    def test_whitelist_kills_unlisted_bash(self):
        policy = self._whitelist_policy(
            bash_patterns=[{"id": "bash-cat", "regex": r"\bcat\b"}],
        )
        hit = self.scan(self._bash_event("git status"), policy)
        self.assertIsNotNone(hit)
        self.assertIn("policy-whitelist-bash", hit[0])

    def test_whitelist_admits_allowed_bash(self):
        policy = self._whitelist_policy(
            bash_patterns=[{"id": "bash-cat", "regex": r"\bcat\b"}],
        )
        self.assertIsNone(self.scan(self._bash_event("cat /etc/hosts"), policy))

    def test_whitelist_kills_unlisted_mcp(self):
        policy = self._whitelist_policy(mcp_patterns=["mcp__vault__vault_read"])
        hit = self.scan(self._mcp_event("vault", "vault_write"), policy)
        self.assertIsNotNone(hit)
        self.assertIn("policy-whitelist-mcp", hit[0])

    def test_whitelist_admits_allowed_mcp(self):
        policy = self._whitelist_policy(mcp_patterns=["mcp__vault__vault_read"])
        self.assertIsNone(self.scan(self._mcp_event("vault", "vault_read"), policy))

    def test_non_tool_events_pass_through(self):
        policy = self._blacklist_policy(
            bash_patterns=[{"id": "bash-npm", "regex": r"\bnpm\b"}],
        )
        agent_msg = json.dumps({
            "type": "item.completed",
            "item": {"type": "agent_message", "text": "running npm install"},
        })
        # agent_message contains "npm" in text but is not a command — must
        # not trip the blacklist.
        self.assertIsNone(self.scan(agent_msg, policy))

    def test_malformed_json_no_throw(self):
        policy = self._blacklist_policy(bash_patterns=[{"id": "x", "regex": r".*"}])
        self.assertIsNone(self.scan("not json", policy))

    def test_classify_event_command_execution(self):
        ev = json.loads(self._bash_event("ls"))
        self.assertEqual(self.classify(ev), ("bash", "ls"))

    def test_classify_event_mcp_tool_call(self):
        ev = json.loads(self._mcp_event("vault", "vault_read"))
        self.assertEqual(self.classify(ev), ("mcp", "mcp__vault__vault_read"))

    def test_classify_event_ignores_other_types(self):
        ev = json.loads(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1}}))
        self.assertIsNone(self.classify(ev))


class LoadAgentToolPolicyTests(unittest.TestCase):
    """End-to-end policy loading from CODEX_TOOL_POLICY env var."""

    @classmethod
    def setUpClass(cls):
        ns = _load_helpers()
        cls.load = staticmethod(ns["_load_agent_tool_policy"])

    def setUp(self):
        os.environ.pop("CODEX_TOOL_POLICY", None)

    def tearDown(self):
        os.environ.pop("CODEX_TOOL_POLICY", None)

    def test_returns_none_when_unset(self):
        self.assertIsNone(self.load())

    def test_returns_none_for_invalid_json(self):
        os.environ["CODEX_TOOL_POLICY"] = "{not json"
        self.assertIsNone(self.load())

    def test_compiles_bash_patterns(self):
        os.environ["CODEX_TOOL_POLICY"] = json.dumps({
            "mode": "blacklist",
            "bashPatterns": [{"id": "bash-npm", "regex": r"\bnpm\b"}],
            "mcpPatterns": ["mcp__codex__codex"],
        })
        policy = self.load()
        self.assertIsNotNone(policy)
        self.assertEqual(policy["mode"], "blacklist")
        self.assertEqual(len(policy["bashPatterns"]), 1)
        self.assertEqual(policy["bashPatterns"][0][0], "bash-npm")
        self.assertIn("mcp__codex__codex", policy["mcpPatterns"])

    def test_skips_invalid_regex(self):
        os.environ["CODEX_TOOL_POLICY"] = json.dumps({
            "mode": "blacklist",
            "bashPatterns": [
                {"id": "bad", "regex": "[unclosed"},
                {"id": "good", "regex": r"\bok\b"},
            ],
            "mcpPatterns": [],
        })
        policy = self.load()
        self.assertIsNotNone(policy)
        # Bad pattern dropped; good one survives.
        self.assertEqual(len(policy["bashPatterns"]), 1)
        self.assertEqual(policy["bashPatterns"][0][0], "good")


if __name__ == "__main__":
    sys.exit(unittest.main(verbosity=2) or 0)
