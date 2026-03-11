---
name: academics
description: Track assignments, due dates, grades, and study notes from Canvas LMS (iCal feed) and GoodNotes exports.
user-invocable: true
argument-hint: "<due|events|courses|notes|study> [args]"
context: fork
agent: researcher
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Academic Tracker — Canvas iCal + GoodNotes

Canvas iCal feed (assignments, quizzes, events across all courses):
!command curl -s "$CANVAS_ICAL_URL" 2>/dev/null | grep -c "BEGIN:VEVENT" | xargs -I{} echo "{} upcoming events in Canvas feed"

Recent GoodNotes exports:
!command ls -lt ~/Documents/GoodNotes-Export/*.pdf 2>/dev/null | head -5 || echo "No PDFs found"

## Canvas Commands

Canvas data comes from the iCal feed at `$CANVAS_ICAL_URL`. Parse the `.ics` format to extract events.

### `due` — Upcoming assignments and events
Fetch the iCal feed and show events due in the next 7 days:
```bash
curl -s "$CANVAS_ICAL_URL" | python3 -c "
import sys, re
from datetime import datetime, timedelta, timezone

data = sys.stdin.read()
now = datetime.now(timezone.utc)
window = now + timedelta(days=7)
events = data.split('BEGIN:VEVENT')
for ev in events[1:]:
    summary = re.search(r'SUMMARY:(.*)', ev)
    dtstart = re.search(r'DTSTART[^:]*:(.*)', ev)
    desc = re.search(r'DESCRIPTION:(.*)', ev)
    if summary and dtstart:
        name = summary.group(1).strip()
        try:
            dt = datetime.strptime(dtstart.group(1).strip()[:15], '%Y%m%dT%H%M%S').replace(tzinfo=timezone.utc)
            if now <= dt <= window:
                print(f'  {dt.strftime(\"%a %b %d %I:%M %p\")} — {name}')
        except ValueError:
            pass
"
```
Sort by date. If nothing is due, say so. Note: not all teachers post assignments to Canvas, so this may not capture everything.

### `events` — All upcoming events
Same as `due` but with a 30-day window. Includes lectures, office hours, and any calendar items professors have added.

### `courses` — List courses in the feed
Parse the iCal feed for unique course names:
```bash
curl -s "$CANVAS_ICAL_URL" | grep -oP '(?<=\[)[^\]]+' | sort -u
```
Course names appear in brackets in event summaries (e.g., `[CS 4310] Homework 3`).

## GoodNotes Commands

GoodNotes folders:
- **Auto-backup**: `~/Library/CloudStorage/GoogleDrive-REDACTED@example.com/My Drive/GoodNotes/`
- **Manual exports**: `~/Documents/GoodNotes-Export/`

### `notes list` — List exported PDFs
```bash
ls -ltR ~/Library/CloudStorage/GoogleDrive-REDACTED@example.com/My\ Drive/GoodNotes\ 6/*.pdf ~/Documents/GoodNotes-Export/*.pdf 2>/dev/null | head -20
```

### `notes read <filename>` — Read a PDF
Use the Read tool to read the PDF file. Claude can read PDFs natively.
```
Read ~/Documents/GoodNotes-Export/<filename>
```

### `notes search <query>` — Search across notes
Search PDF filenames for the query term:
```bash
ls ~/Documents/GoodNotes-Export/ | grep -i "<query>"
```

### `study <topic>` — Generate study summary
1. Search GoodNotes exports for PDFs related to the topic
2. Read the most relevant PDFs (up to 3)
3. Check Canvas feed for related upcoming events/deadlines
4. Create a concise study summary with key concepts, definitions, and practice questions

## Notes

- Canvas data comes from the iCal feed — no API token needed, no expiration
- Not all assignments may appear (depends on whether teachers add them to Canvas)
- Other events (lectures, office hours, campus events) will show up too
- The assignment-reminder heartbeat checks for events due in the next 3 days every 12h
- The goodnotes-watch heartbeat detects new PDF exports every hour
