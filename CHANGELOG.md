# Changelog

## 1.3.0

- Added: optional read-only virtual entries from sister plugins - birthdays from Plain Contacts (`birthdate`, recurring yearly on day/month) and tasks with a `due` date from Plain Tasks, shown as dashed chips in every view (day/week/month/year). Each is opt-in via a "Show ... in calendar" setting in the *other* plugin's settings tab, off by default. Clicking a virtual entry opens its source note directly - no edit dialog, no drag/resize/delete, and it's a separate display layer from this plugin's own recurring-event series/exception model, never colliding with it

## Unreleased

- Recurring events (`wiederholung`: daily/weekly/monthly/yearly, with optional interval, end date, or occurrence count)

## 1.0.0

Initial release.

- Day, week, month, and year views
- Events stored as plain notes with frontmatter
- Create, edit, and delete events from the calendar (click, right-click)
- Overlapping events laid out side by side in day/week view
- Follows Obsidian's theme and language setting (German/English UI)
