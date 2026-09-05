# 📅 Plain Calendar

![CI](https://github.com/janschikorr/obsidian-plain-calendar/actions/workflows/ci.yml/badge.svg)
![Latest release](https://img.shields.io/github/v/release/janschikorr/obsidian-plain-calendar?sort=semver&label=release)
![License](https://img.shields.io/github/license/janschikorr/obsidian-plain-calendar)

A minimal, Outlook-style calendar for Obsidian. Day, week, month, and year views for your own event notes — no pomodoro timer, no time tracking, nothing you have to turn off.

## 🤔 Why

Existing calendar plugins tend to come bundled with task management, pomodoro timers, or time tracking that can't be switched off. Plain Calendar does one thing: show and manage events that live as plain notes in your vault.

## ✨ Features

- 🗓️ **Day / week views** — a vertical 24-hour time grid (like Outlook), with overlapping events laid out side by side
- 🔲 **Month view** — a classic grid with events listed per day
- 🔭 **Year view** — 4 months per row, 3 rows, click a month or day to jump into it
- 📄 **Events are notes** — every event is a regular markdown file with frontmatter, so it's just as searchable, linkable, and versionable as the rest of your vault
- 🔁 **Recurring events** — daily/weekly/monthly/yearly, with an optional interval, end date, or occurrence count, plus Outlook-style handling of single-occurrence exceptions
- 🎛️ Native date/time pickers and Obsidian's own dialog styling throughout — nothing feels bolted on
- 🌗 Follows Obsidian's theme (light/dark, accent color) and language setting (German/English UI; more languages can be added easily)

## 📦 Installation

Plain Calendar is intentionally small and not in Obsidian's community plugin store, so it's installed either through BRAT or by hand.

> **Requirements:** Obsidian 1.12.0 or newer.

### 🚀 Via BRAT (recommended)

BRAT auto-updates the plugin whenever a new release comes out, so you don't have to repeat the manual steps below.

1. Open **Settings → Community plugins → Browse**, search for **BRAT** (*Obsidian42 - BRAT*), install it, and enable it.
2. Open the command palette (`Ctrl/Cmd + P`) and run **BRAT: Add a beta plugin for testing**.
3. Paste the repository `janschikorr/obsidian-plain-calendar` (or the full URL `https://github.com/janschikorr/obsidian-plain-calendar`) and confirm.
4. Go to **Settings → Community plugins** and enable **Plain Calendar**.

### 🛠️ Manual

Use this if you don't want BRAT installed, or want to pin a specific version.

1. Open the [releases page](https://github.com/janschikorr/obsidian-plain-calendar/releases) and download `main.js`, `manifest.json`, and `styles.css` from the release you want (usually [the latest](https://github.com/janschikorr/obsidian-plain-calendar/releases/latest)).
2. In your vault, create the folder `.obsidian/plugins/plain-calendar/` if it doesn't exist yet, and copy the three files into it.
3. Reload Obsidian (or **Settings → Community plugins → reload**) so it picks up the new plugin folder.
4. Go to **Settings → Community plugins** and enable **Plain Calendar**.

Updating later means repeating all four steps with the new release's files.

## 🖱️ Usage

Open the calendar via the ribbon icon or the **Open calendar** command.

**Month & year view**

- 🖱️ Click an empty day (or one with a single event) → create a new event there
- 📆 Click a day that already has several events → jump straight to the day view instead of piling on more
- 🖱️➡️ Right-click a day → open the day view, or edit/delete one of its events
- ✏️ Click an event chip → edit it; right-click it → edit/delete

**Day & week view**

- 🖱️ Click an empty slot in the time grid → create an event at that time
- ✏️ Click an event → edit it; right-click it → edit/delete

## 📝 Event notes

Each event is stored as a note with this frontmatter:

```yaml
---
title: <title>
tags:
  - event
date: <YYYY-MM-DD>
time: <HH:mm>            # optional, empty = all day
end: <HH:mm>             # optional, end time
location: <location>     # optional
recurrence: <FREQ=...>   # optional, see Recurring events below
---
```

### 🔁 Recurring events

In the create/edit dialog, **Repeat** is a dropdown (None/Daily/Weekly/Monthly/Yearly). Pick anything but None and two more controls appear: an **Interval** ("every N days/weeks/months/years") and an **Ends** dropdown (Never / on a date / after a number of occurrences), with the matching date or count field shown underneath.

Under the hood this is stored in `recurrence` as an RRULE-lite string:

- `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` (required)
- `INTERVAL=<n>` — every n-th unit (default 1)
- `UNTIL=<YYYY-MM-DD>` — last occurrence (inclusive)
- `COUNT=<n>` — total number of occurrences

Examples: `FREQ=YEARLY` 🎂 (birthdays/anniversaries), `FREQ=WEEKLY;INTERVAL=2` (every two weeks), `FREQ=MONTHLY;COUNT=6`. `date` is the first occurrence — the note with a `recurrence` field is the series' master note.

Editing or deleting an occurrence from the calendar asks what the change applies to, Outlook's classic three-way choice:

- 1️⃣ **This event only** — creates (or edits) a separate note for just that one date, without touching the rest of the series. Deleting this way adds the date to the master's `excluded` list instead of leaving a stray file.
- ➡️ **This and all following** — splits the series at that date: the existing master note ends right before it, a new master note continues the same pattern from there on.
- 🔗 **The entire series** — edits or deletes the master note itself (deleting also removes every single-occurrence note that overrides it).

## ⚙️ Settings

- 📁 **Folder for event notes** — where event notes are stored (default: `Calendar`)
- 🏷️ **Tag for events** — the frontmatter tag that marks a note as an event (default: `event`)

## 🗺️ Roadmap

- Optionally show tasks from other task-management plugins alongside events

## 📄 License

[MIT](LICENSE)
