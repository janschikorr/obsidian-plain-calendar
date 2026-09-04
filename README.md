# Plain Calendar

A minimal, Outlook-style calendar for Obsidian. Day, week, month, and year views for your own event notes — no pomodoro timer, no time tracking, nothing you have to turn off.

## Why

Existing calendar plugins tend to come bundled with task management, pomodoro timers, or time tracking that can't be switched off. Plain Calendar does one thing: show and manage events that live as plain notes in your vault.

## Features

- **Day / week views** — a vertical 24-hour time grid (like Outlook), with overlapping events laid out side by side
- **Month view** — a classic grid with events listed per day
- **Year view** — 4 months per row, 3 rows, click a month or day to jump into it
- **Events are notes** — every event is a regular markdown file with frontmatter, so it's just as searchable, linkable, and versionable as the rest of your vault
- **Recurring events** — daily/weekly/monthly/yearly, with an optional interval, end date, or occurrence count
- Click an empty slot to create an event, click an event to edit it, right-click for a quick edit/delete menu
- Follows Obsidian's theme (light/dark, accent color) and language setting (German/English UI; more languages can be added easily)

## Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/plain-calendar/`
2. Enable **Plain Calendar** under Settings → Community plugins

## Usage

Open the calendar via the ribbon icon or the **Open calendar** command. Click any empty day/time slot to create a new event; click an existing event to edit it.

Each event is stored as a note with this frontmatter:

```yaml
---
titel: <title>
tags:
  - termin
datum: <YYYY-MM-DD>
zeit: <HH:mm>            # optional, empty = all day
ende: <HH:mm>            # optional, end time
ort: <location>          # optional
wiederholung: <FREQ=...> # optional, see Recurring events below
---
```

> **Note:** frontmatter field names are currently fixed in German (`titel`, `datum`, `zeit`, `ende`, `ort`, `wiederholung`) — this is a known limitation, see [Roadmap](#roadmap).

### Recurring events

In the create/edit dialog, **Repeat** is a dropdown (None/Daily/Weekly/Monthly/Yearly). Pick anything but None and two more controls appear: an **Interval** ("every N days/weeks/months/years") and an **Ends** dropdown (Never / on a date / after a number of occurrences), with the matching date or count field shown underneath.

Under the hood this is stored in `wiederholung` as an RRULE-lite string:

- `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` (required)
- `INTERVAL=<n>` — every n-th unit (default 1)
- `UNTIL=<YYYY-MM-DD>` — last occurrence (inclusive)
- `COUNT=<n>` — total number of occurrences

Examples: `FREQ=YEARLY` (birthdays/anniversaries), `FREQ=WEEKLY;INTERVAL=2` (every two weeks), `FREQ=MONTHLY;COUNT=6`. `datum` is the first occurrence. Editing or deleting a recurring event from the calendar always applies to the whole series — there's no support for editing a single occurrence.

## Settings

- **Folder for event notes** — where event notes are stored (default: `Kalender/Termine`)
- **Tag for events** — the frontmatter tag that marks a note as an event (default: `termin`)

## Roadmap

- Configurable / localized frontmatter field names
- Optionally show tasks from other task-management plugins alongside events

## License

[MIT](LICENSE)
