#!/bin/bash
# End-to-end test for claude-runner.py
# Tests the full pipeline: Python → Claude CLI → JSON response → parsed output

echo "=== Test 1: Basic response ==="
OUTPUT=$(python3 claude-runner.py -p --output-format json "say hi in exactly one word" 2>&1)
echo "Raw output: $OUTPUT"
echo ""

# Check it's valid JSON
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS: Got result:', repr(d.get('result','')[:50]))" 2>/dev/null; then
    echo ""
else
    echo "FAIL: Output is not valid JSON"
fi
echo ""

echo "=== Test 2: Verify no CLAUDECODE in env ==="
OUTPUT2=$(python3 claude-runner.py -p --output-format json "respond with just the word 'working'" 2>&1)
if echo "$OUTPUT2" | grep -q '"is_error":false'; then
    echo "PASS: No nested session error"
else
    echo "FAIL: Got error - $OUTPUT2"
fi
echo ""

echo "=== Test 3: JSON structure ==="
echo "$OUTPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
checks = [
    ('has type', 'type' in d),
    ('has result', 'result' in d),
    ('has session_id', 'session_id' in d),
    ('is_error is false', d.get('is_error') == False),
    ('result is string', isinstance(d.get('result'), str)),
]
for name, ok in checks:
    print(f\"  {'PASS' if ok else 'FAIL'}: {name}\")
" 2>/dev/null || echo "FAIL: Could not parse JSON structure"

echo ""
echo "=== All tests complete ==="
