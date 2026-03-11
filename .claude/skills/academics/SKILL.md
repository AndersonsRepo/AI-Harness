---
name: academics
description: Track assignments, due dates, grades, and study notes from Canvas LMS and GoodNotes exports.
user-invocable: true
argument-hint: "<due|grades|courses|notes|study> [args]"
context: fork
agent: researcher
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Academic Tracker — Canvas LMS + GoodNotes

Recent GoodNotes exports:
!command ls -lt ~/Documents/GoodNotes-Export/*.pdf 2>/dev/null | head -5 || echo "No PDFs found"

## Canvas Commands

Use the Canvas MCP tools (from `mcp-canvas-lms`) for all API calls. If MCP tools are unavailable, fall back to `curl` with `$CANVAS_API_TOKEN`.

### `courses` — List active courses
Query Canvas for current-term courses. Show course name, ID, and term.

### `due` — Upcoming assignments
Query Canvas for assignments due in the next 7 days across all courses. Sort by due date. Show:
- Course name
- Assignment name
- Due date/time
- Points possible
- Submission status (submitted/missing/not yet)

### `grades` — Current grades
Query Canvas for current grades across all courses. Show course name, current score, and letter grade.

### `assignments <course>` — List assignments for a course
Query Canvas for all assignments in the specified course. Accept course name or ID.

## GoodNotes Commands

GoodNotes export folder: `~/Documents/GoodNotes-Export/`

### `notes list` — List exported PDFs
```bash
ls -lt ~/Documents/GoodNotes-Export/*.pdf | head -20
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
3. Query Canvas for related course materials
4. Create a concise study summary with key concepts, definitions, and practice questions

## Notes

- Canvas API base URL: `https://canvas.cpp.edu`
- Canvas API token is set via `$CANVAS_API_TOKEN` environment variable
- The assignment-reminder heartbeat checks for due assignments every 12 hours
- The goodnotes-watch heartbeat detects new PDF exports every hour
