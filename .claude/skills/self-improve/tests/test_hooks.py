import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPTS_DIR = REPO_ROOT / ".claude" / "skills" / "self-improve" / "scripts"


def load_script(name: str):
    path = SCRIPTS_DIR / name
    sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SelfImproveHookTests(unittest.TestCase):
    def test_session_flush_defaults_to_this_checkout_from_script_path(self):
        old_harness_root = os.environ.pop("HARNESS_ROOT", None)
        try:
            module = load_script("session_flush.py")
        finally:
            if old_harness_root is not None:
                os.environ["HARNESS_ROOT"] = old_harness_root

        self.assertEqual(REPO_ROOT, module.HARNESS_ROOT)

    def test_error_detector_defaults_to_this_checkout_from_script_path(self):
        old_harness_root = os.environ.pop("HARNESS_ROOT", None)
        try:
            module = load_script("error_detector.py")
        finally:
            if old_harness_root is not None:
                os.environ["HARNESS_ROOT"] = old_harness_root

        self.assertEqual(REPO_ROOT, module.HARNESS_ROOT)

    def test_feature_request_capture_uses_valid_learning_frontmatter_type(self):
        activator = load_script("activator.py")
        with tempfile.TemporaryDirectory() as tmp:
            activator.VAULT_DIR = Path(tmp)
            entry_id = activator.write_entry(
                "FEAT",
                "feature_request",
                "[auto-captured, feature-request]",
                "we need a way to stabilize hook payload parsing",
            )
            content = (Path(tmp) / f"{entry_id}.md").read_text()

        self.assertTrue(entry_id.startswith("LRN-"))
        self.assertIn("type: learning", content)
        self.assertNotIn("type: feature", content)
        self.assertIn("category: feature_request", content)
        self.assertIn("priority: medium", content)
        self.assertIn("status: new", content)
        self.assertNotIn("status: requested", content)
        self.assertNotIn("complexity:", content)

    def test_legacy_shell_activator_uses_valid_feature_request_taxonomy(self):
        script = (SCRIPTS_DIR / "activator.sh").read_text()

        self.assertIn('ID_PREFIX="LRN"', script)
        self.assertIn("type: learning", script)
        self.assertIn("category: feature_request", script)
        self.assertIn("priority: medium", script)
        self.assertIn("status: new", script)
        self.assertNotIn("type: feature", script)
        self.assertNotIn("status: requested", script)
        self.assertNotIn("complexity:", script)

    def test_agent_teams_task_created_reads_nested_identity_payload(self):
        payload = {
            "task": {
                "description": "Implement self-improve hook stabilization",
                "assignee": {"name": "builder-1"},
            }
        }

        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "task_created.py")],
                input=json.dumps(payload),
                text=True,
                check=True,
                env={**os.environ, "HARNESS_ROOT": tmp},
                capture_output=True,
            )
            notifications = (Path(tmp) / "pending-notifications.jsonl").read_text()

        self.assertIn("builder-1", notifications)
        self.assertIn("Implement self-improve hook stabilization", notifications)
        self.assertNotIn("unassigned", notifications)

    def test_agent_teams_task_completed_reads_nested_identity_payload(self):
        payload = {
            "teammate": {"name": "builder-2"},
            "task": {"description": "Patch hook parser"},
            "result": "Implemented focused tests and production hook fixes.",
        }

        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "task_completed.py")],
                input=json.dumps(payload),
                text=True,
                check=True,
                env={**os.environ, "HARNESS_ROOT": tmp},
                capture_output=True,
            )
            notifications = (Path(tmp) / "pending-notifications.jsonl").read_text()

        self.assertIn("builder-2", notifications)
        self.assertIn("Patch hook parser", notifications)
        self.assertNotIn("unknown", notifications)
        self.assertIn("REVIEW GATE", result.stdout)

    def test_self_improve_hook_commands_are_root_anchored(self):
        settings = json.loads((REPO_ROOT / ".claude" / "settings.json").read_text())
        commands = [
            hook["command"]
            for groups in settings["hooks"].values()
            for group in groups
            for hook in group["hooks"]
            if "self-improve/scripts" in hook.get("command", "")
        ]

        self.assertTrue(commands)
        for command in commands:
            self.assertIn("CLAUDE_PROJECT_DIR", command)
            self.assertIn("HARNESS_ROOT", command)
            self.assertNotIn("python3 .claude/skills/self-improve", command)

    def test_skill_doc_matches_valid_vault_taxonomy(self):
        skill_dir = REPO_ROOT / ".claude" / "skills" / "self-improve"
        skill_doc = (skill_dir / "SKILL.md").read_text()
        feature_template = (skill_dir / "templates" / "feature.md").read_text()

        self.assertIn("category: feature_request", skill_doc)
        self.assertIn("type: learning", skill_doc)
        self.assertNotIn("type: feature", skill_doc)
        self.assertNotIn("FEAT-YYYYMMDD", skill_doc)
        self.assertIn("category: feature_request", feature_template)
        self.assertIn("type: learning", feature_template)
        self.assertNotIn("type: feature", feature_template)
        self.assertNotIn("FEAT-YYYYMMDD", feature_template)
        self.assertIn("priority: medium", feature_template)
        self.assertIn("status: new", feature_template)
        self.assertNotIn("status: requested", feature_template)
        self.assertNotIn("complexity:", feature_template)

    def test_daily_digest_uses_feature_request_category_taxonomy(self):
        digest = json.loads((REPO_ROOT / "heartbeat-tasks" / "daily-digest.json").read_text())
        prompt = digest["prompt"]

        self.assertIn("type: learning", prompt)
        self.assertIn("category: feature_request", prompt)
        self.assertNotIn("type: feature_request", prompt)


if __name__ == "__main__":
    unittest.main()
