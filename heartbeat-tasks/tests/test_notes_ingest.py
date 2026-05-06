"""
notes-ingest.py unit tests.

Exercises the new helpers introduced to fix the alphabetical-FIFO queue
starvation and the Google Drive placeholder-stub silent-fail bug.

Run: python3 -m unittest heartbeat-tasks.tests.test_notes_ingest -v
"""

import importlib.util
import os
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_HERE, "..", "scripts", "notes-ingest.py"))


def _load_module():
    """Import notes-ingest.py without invoking main()."""
    # Avoid running notes-ingest's main() by importing it as a regular
    # module — it's __main__-guarded.
    spec = importlib.util.spec_from_file_location("notes_ingest", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SelectRoundRobinTests(unittest.TestCase):
    """select_round_robin must spread max_count picks across courses
    so a backlog in one course can't starve the others every run."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_module()

    def _candidate(self, rel_path, channel):
        """Build a (full_path, rel_path, course_info) triple in the shape
        select_round_robin expects."""
        return ("/abs/" + rel_path, rel_path, {"channel": channel, "vault_dir": channel})

    def test_distributes_across_courses_in_order(self):
        # 5 Comp Society + 1 Philosophy + 1 Numerical Methods, max_count=3.
        # Round-robin must pick one from each before going back to Comp Society.
        cands = [
            self._candidate("comp/a.pdf", "comp-society"),
            self._candidate("comp/b.pdf", "comp-society"),
            self._candidate("comp/c.pdf", "comp-society"),
            self._candidate("comp/d.pdf", "comp-society"),
            self._candidate("comp/e.pdf", "comp-society"),
            self._candidate("phil/a.pdf", "philosophy"),
            self._candidate("num/a.pdf", "numerical"),
        ]
        picked = self.m.select_round_robin(cands, max_count=3)
        rels = [p[1] for p in picked]
        self.assertEqual(rels, ["comp/a.pdf", "phil/a.pdf", "num/a.pdf"])

    def test_max_count_zero_returns_empty(self):
        cands = [self._candidate("a", "x")]
        self.assertEqual(self.m.select_round_robin(cands, 0), [])

    def test_single_course_takes_up_to_max_count(self):
        cands = [self._candidate(f"comp/{i}.pdf", "comp-society") for i in range(10)]
        picked = self.m.select_round_robin(cands, max_count=4)
        self.assertEqual(len(picked), 4)
        self.assertEqual([p[1] for p in picked], [f"comp/{i}.pdf" for i in range(4)])

    def test_continues_round_after_smaller_buckets_drained(self):
        cands = [
            self._candidate("a/1.pdf", "a"),
            self._candidate("a/2.pdf", "a"),
            self._candidate("a/3.pdf", "a"),
            self._candidate("b/1.pdf", "b"),
        ]
        # max_count=4 with 3 a's + 1 b => round-robin yields a/1, b/1, a/2, a/3.
        picked = self.m.select_round_robin(cands, max_count=4)
        self.assertEqual([p[1] for p in picked], ["a/1.pdf", "b/1.pdf", "a/2.pdf", "a/3.pdf"])

    def test_preserves_first_seen_course_order(self):
        # Course-iteration order matches the order of first appearance in
        # the input — important so the alphabetical pre-sort still puts
        # earlier courses first within each round.
        cands = [
            self._candidate("z/1.pdf", "z-course"),
            self._candidate("a/1.pdf", "a-course"),
        ]
        picked = self.m.select_round_robin(cands, max_count=2)
        self.assertEqual([p[1] for p in picked], ["z/1.pdf", "a/1.pdf"])

    def test_empty_input(self):
        self.assertEqual(self.m.select_round_robin([], 5), [])


class IsDriveStubTests(unittest.TestCase):
    """is_drive_stub returns True when the file can't be read."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_module()

    def test_real_file_is_not_stub(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"hello world this is a real file with content")
            path = f.name
        try:
            self.assertFalse(self.m.is_drive_stub(path))
        finally:
            os.unlink(path)

    def test_missing_file_is_treated_as_stub(self):
        # Path that doesn't exist -> open() raises FileNotFoundError ->
        # is_drive_stub returns True. That's the right behavior: caller
        # will skip + warn instead of attempting an LLM call.
        self.assertTrue(self.m.is_drive_stub("/no/such/path/here.pdf"))

    def test_empty_file_is_not_stub(self):
        # Empty files read cleanly (just zero bytes) — that's an edge
        # case the LLM call will handle separately. is_drive_stub is
        # specifically about open()/read() raising EDEADLK or similar.
        with tempfile.NamedTemporaryFile(delete=False) as f:
            path = f.name
        try:
            self.assertFalse(self.m.is_drive_stub(path))
        finally:
            os.unlink(path)


class LogErrorTests(unittest.TestCase):
    """log_error appends to the errors log without raising even if the
    log directory doesn't exist yet."""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_module()

    def test_appends_line(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = os.path.join(tmpdir, "logs", "errors.log")
            # Patch ERROR_LOG via attribute assignment for this test
            original = self.m.ERROR_LOG
            self.m.ERROR_LOG = log_path
            try:
                self.m.log_error("some/file.pdf", "boom")
                self.m.log_error("other.pdf", "ENOENT")
                with open(log_path) as f:
                    content = f.read()
                self.assertIn("some/file.pdf: boom", content)
                self.assertIn("other.pdf: ENOENT", content)
                self.assertEqual(content.count("\n"), 2)
            finally:
                self.m.ERROR_LOG = original


if __name__ == "__main__":
    import sys
    sys.exit(unittest.main(verbosity=2) or 0)
