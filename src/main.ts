import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	moment,
	normalizePath,
} from "obsidian";

const VIEW_TYPE_CALENDAR = "plain-calendar-view";

type ViewMode = "day" | "week" | "month" | "year";

interface CalendarSettings {
	eventsFolder: string;
	eventTag: string;
	// Which of day/week/month/year the calendar view was last showing.
	// Persisted so the view reopens in the same mode instead of always
	// resetting to "week" - the anchor date itself is deliberately NOT
	// persisted here, CalendarView.anchor always starts at "today" on open.
	viewMode: ViewMode;
}

const DEFAULT_SETTINGS: CalendarSettings = {
	eventsFolder: "Calendar",
	eventTag: "event",
	viewMode: "week",
};

interface CalendarEvent {
	file: TFile;
	title: string;
	date: string; // YYYY-MM-DD, the first/defining occurrence for recurring events
	time?: string; // HH:mm
	end?: string; // HH:mm
	location?: string;
	recurrence?: string; // RRULE-lite, e.g. "FREQ=WEEKLY;INTERVAL=2"
	excludedDates?: string[]; // master only: deleted occurrences (like ICS EXDATE)
	seriesPath?: string; // exception only: vault path of the master note this replaces a slot in
	replacesDate?: string; // exception only: the pattern date (YYYY-MM-DD) this note stands in for
}

// Frontmatter of an event note as it comes out of the metadata cache. Field
// names mirror the actual YAML keys - this is the vault's data schema, see
// regeln/vorlagen/termin.md. Do not rename these without a migration: they
// are read/written verbatim against notes that already exist.
interface EventFrontmatter {
	title?: string;
	tags?: string | string[];
	date?: string;
	time?: string;
	end?: string;
	location?: string;
	recurrence?: string;
	excluded?: string[] | string;
	series?: string;
	replaces?: string;
}

function parseCalendarEvent(file: TFile, fm: EventFrontmatter, requiredTag: string): CalendarEvent | null {
	if (!fm.date) return null;
	const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
	if (requiredTag && !tags.includes(requiredTag)) return null;

	const excludedDates = Array.isArray(fm.excluded)
		? fm.excluded.map(String)
		: fm.excluded
		? [String(fm.excluded)]
		: undefined;

	return {
		file,
		title: fm.title || file.basename,
		date: String(fm.date).slice(0, 10),
		time: fm.time ? String(fm.time) : undefined,
		end: fm.end ? String(fm.end) : undefined,
		location: fm.location ? String(fm.location) : undefined,
		recurrence: fm.recurrence ? String(fm.recurrence) : undefined,
		excludedDates,
		seriesPath: fm.series ? String(fm.series) : undefined,
		replacesDate: fm.replaces ? String(fm.replaces).slice(0, 10) : undefined,
	};
}

// Minimal RRULE-lite subset for recurring events: FREQ (required),
// INTERVAL/UNTIL/COUNT (optional). Matches the "FREQ=YEARLY"-style syntax
// already used for TaskNotes' `recurrence` field elsewhere in this vault, so
// no BYDAY/BYMONTHDAY/BYSETPOS or other full-RRULE features - those aren't
// needed for the common cases (birthdays, weekly meetings, monthly bills).
type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface RecurrenceRule {
	freq: RecurrenceFreq;
	interval: number;
	until?: string; // YYYY-MM-DD, inclusive
	count?: number;
}

function parseRecurrenceRule(raw: string): RecurrenceRule | null {
	const fields: Record<string, string> = {};
	for (const part of raw.split(";")) {
		const [key, value] = part.split("=");
		if (key && value) fields[key.trim().toUpperCase()] = value.trim();
	}

	const freq = fields.FREQ as RecurrenceFreq;
	if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;

	const interval = fields.INTERVAL ? parseInt(fields.INTERVAL, 10) : 1;
	const rule: RecurrenceRule = { freq, interval: interval > 0 ? interval : 1 };

	if (fields.UNTIL) {
		const digits = fields.UNTIL.replace(/T.*$/, "").replace(/-/g, "");
		if (/^\d{8}$/.test(digits)) {
			rule.until = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
		}
	}

	if (fields.COUNT) {
		const count = parseInt(fields.COUNT, 10);
		if (count > 0) rule.count = count;
	}

	return rule;
}

function buildRecurrenceRuleString(rule: RecurrenceRule): string {
	const parts = [`FREQ=${rule.freq}`];
	if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.until) parts.push(`UNTIL=${rule.until}`);
	if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
	return parts.join(";");
}

function parseDateKey(key: string): Date {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(y, (m || 1) - 1, d || 1);
}

// Day number relative to the UTC epoch, so differences are exact regardless
// of DST transitions in the local time zone (unlike dividing a raw ms
// difference between two local-midnight Date objects by 86400000).
function dayNumber(d: Date): number {
	return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

// Which occurrence of the pattern (0-based) date `d` would be, ignoring
// until/count bounds - null if `d` doesn't land on the pattern at all.
// Shared by occursOn (bounds-checked) and the series-split logic (which
// needs the exact index to cap/resume a rule without doing its own date
// arithmetic).
function occurrenceIndex(rule: RecurrenceRule, start: Date, d: Date): number | null {
	switch (rule.freq) {
		case "DAILY": {
			const diff = dayNumber(d) - dayNumber(start);
			if (diff % rule.interval !== 0) return null;
			return diff / rule.interval;
		}
		case "WEEKLY": {
			const diff = dayNumber(d) - dayNumber(start);
			const weekSpan = rule.interval * 7;
			if (diff % weekSpan !== 0) return null;
			return diff / weekSpan;
		}
		case "MONTHLY": {
			if (d.getDate() !== start.getDate()) return null;
			const monthDiff = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
			if (monthDiff % rule.interval !== 0) return null;
			return monthDiff / rule.interval;
		}
		case "YEARLY": {
			if (d.getDate() !== start.getDate() || d.getMonth() !== start.getMonth()) return null;
			const yearDiff = d.getFullYear() - start.getFullYear();
			if (yearDiff % rule.interval !== 0) return null;
			return yearDiff / rule.interval;
		}
	}
}

// Whether a master event's pattern lands on date `d` (ignoring exceptions -
// see occurrencesOn/SeriesIndex for the exception-aware version used for
// rendering).
function occursOn(ev: CalendarEvent, d: Date): boolean {
	const key = toDateKey(d);
	if (!ev.recurrence) return ev.date === key;

	const start = parseDateKey(ev.date);
	if (dayNumber(d) < dayNumber(start)) return false;

	const rule = parseRecurrenceRule(ev.recurrence);
	if (!rule) return ev.date === key;
	if (rule.until && key > rule.until) return false;

	const index = occurrenceIndex(rule, start, d);
	if (index === null) return false;

	return rule.count === undefined || index < rule.count;
}

// One concrete occurrence on the calendar: either a standalone event, a
// materialized exception note, or a date generated by a master's pattern.
// `master` is the series' master event for "exception"/"master" kinds, so
// edit/delete handlers can act on the series regardless of which occurrence
// was clicked.
interface Occurrence {
	display: CalendarEvent;
	date: string;
	kind: "single" | "master" | "exception";
	master?: CalendarEvent;
}

interface SeriesIndex {
	exceptionsBySeriesDate: Map<string, Map<string, CalendarEvent>>; // master path -> replacesDate -> exception
	exceptionsBySeries: Map<string, CalendarEvent[]>; // master path -> all its exceptions
	mastersByPath: Map<string, CalendarEvent>;
}

function buildSeriesIndex(events: CalendarEvent[]): SeriesIndex {
	const exceptionsBySeriesDate = new Map<string, Map<string, CalendarEvent>>();
	const exceptionsBySeries = new Map<string, CalendarEvent[]>();
	const mastersByPath = new Map<string, CalendarEvent>();

	for (const ev of events) {
		if (ev.recurrence) mastersByPath.set(ev.file.path, ev);
		if (ev.seriesPath && ev.replacesDate) {
			if (!exceptionsBySeriesDate.has(ev.seriesPath)) exceptionsBySeriesDate.set(ev.seriesPath, new Map());
			exceptionsBySeriesDate.get(ev.seriesPath)!.set(ev.replacesDate, ev);
			if (!exceptionsBySeries.has(ev.seriesPath)) exceptionsBySeries.set(ev.seriesPath, []);
			exceptionsBySeries.get(ev.seriesPath)!.push(ev);
		}
	}

	return { exceptionsBySeriesDate, exceptionsBySeries, mastersByPath };
}

// All occurrences landing on date `d`: standalone events and exception notes
// at their own date, plus every master whose pattern reaches `d` and isn't
// excluded (deleted, via `excludedDates`) or overridden by an exception for
// that slot. Sorted like the original flat event list (all-day before timed,
// then by time).
function occurrencesOn(events: CalendarEvent[], index: SeriesIndex, d: Date): Occurrence[] {
	const key = toDateKey(d);
	const result: Occurrence[] = [];

	for (const ev of events) {
		if (ev.recurrence) continue; // handled via mastersByPath below
		if (ev.seriesPath) {
			if (ev.date === key) result.push({ display: ev, date: key, kind: "exception", master: index.mastersByPath.get(ev.seriesPath) });
			continue;
		}
		if (ev.date === key) result.push({ display: ev, date: key, kind: "single" });
	}

	for (const master of index.mastersByPath.values()) {
		if (!occursOn(master, d)) continue;
		if (master.excludedDates?.includes(key)) continue;
		if (index.exceptionsBySeriesDate.get(master.file.path)?.has(key)) continue;
		result.push({ display: master, date: key, kind: "master", master });
	}

	result.sort((a, b) => {
		const at = a.display.time;
		const bt = b.display.time;
		if (at && bt) return at < bt ? -1 : at > bt ? 1 : 0;
		if (at) return -1;
		if (bt) return 1;
		return 0;
	});

	return result;
}

// --- Virtual entries from sister plugins (plain-contacts / plain-tasks) ---
//
// Read-only display layer, deliberately separate from CalendarEvent/
// Occurrence/SeriesIndex above: virtual entries are never edited, moved, or
// deleted from this plugin, so they don't need a "kind" in that model, no
// series/exception handling, and no frontmatter of their own. They're only
// ever read from the other plugin's notes and, on click, open the source
// file - see wireVirtualEntryElement.

// The subset of another plugin's settings this plugin actually reads.
// Neither `app.plugins` nor a specific sister plugin's settings shape is
// part of Obsidian's public API - both are read defensively (every step
// optional-chained) so a missing/not-yet-loaded/differently-shaped plugin
// never throws, it just yields no virtual entries.
interface ContactsPluginSettings {
	folder?: string;
	typeValue?: string;
	showInCalendar?: boolean;
}

interface TasksPluginSettings {
	tasksFolder?: string;
	taskTag?: string;
	showInCalendar?: boolean;
}

function getExternalPluginSettings<T>(app: App, pluginId: string): T | undefined {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: unknown }> } }).plugins
		?.plugins;
	return plugins?.[pluginId]?.settings as T | undefined;
}

// Same "YYYY-MM-DD" | "--MM-DD" (ISO unknown-year notation) parsing as
// plain-contacts' parseBirthdateMonthDay - duplicated rather than imported
// since these are separate plugin bundles (obsidian is external, sister
// plugins are not a shared dependency).
function parseBirthdateMonthDay(raw: string): { month: number; day: number } | null {
	const match = raw.match(/^(?:\d{4}-|--)(\d{2})-(\d{2})$/);
	if (!match) return null;
	const month = Number(match[1]);
	const day = Number(match[2]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return { month, day };
}

interface VirtualBirthdayEntry {
	title: string;
	month: number;
	day: number;
	sourcePath: string;
}

interface VirtualTaskEntry {
	title: string;
	date: string; // YYYY-MM-DD, the task's own `due` value, not expanded for recurring tasks
	sourcePath: string;
}

interface VirtualEntry {
	kind: "birthday" | "task";
	title: string;
	sourcePath: string;
}

// Birthdays recur every year on the same month/day (both `YYYY-MM-DD` and
// `--MM-DD` birthdates), matched independently of the RRULE-lite recurrence
// machinery above - a parallel, much simpler rule that only this display
// layer needs. Tasks aren't expanded at all: a recurring task's `due` is
// just its own stored date, same as any other task, see VirtualTaskEntry.
function virtualEntriesOn(d: Date, birthdays: VirtualBirthdayEntry[], tasks: VirtualTaskEntry[]): VirtualEntry[] {
	const key = toDateKey(d);
	const month = d.getMonth() + 1;
	const day = d.getDate();
	const result: VirtualEntry[] = [];
	for (const b of birthdays) {
		if (b.month === month && b.day === day) result.push({ kind: "birthday", title: b.title, sourcePath: b.sourcePath });
	}
	for (const task of tasks) {
		if (task.date === key) result.push({ kind: "task", title: task.title, sourcePath: task.sourcePath });
	}
	return result;
}

// Chip/block label, with a small marker for recurring events and a
// different one for a single materialized exception of a series.
function eventLabel(ev: CalendarEvent, opts: { withTime?: boolean; isException?: boolean } = {}): string {
	const prefix = opts.isException ? "» " : ev.recurrence ? "↻ " : "";
	const time = opts.withTime && ev.time ? `${ev.time} ` : "";
	return `${prefix}${time}${ev.title}`;
}

// Fixed emoji markers (not translated) distinguishing a virtual entry's
// origin plugin at a glance - same visual language as the 🎂/☑️ used
// elsewhere in this vault's own notes.
function virtualEntryLabel(entry: VirtualEntry): string {
	const icon = entry.kind === "birthday" ? "🎂" : "☑️";
	return `${icon} ${entry.title}`;
}

const HOUR_PX = 48;
const GRID_HOURS = 24;
const DEFAULT_DURATION_MIN = 60;
const MIN_BLOCK_MIN = 30;

function parseTimeToMinutes(t?: string): number | null {
	if (!t) return null;
	const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (Number.isNaN(h) || Number.isNaN(min)) return null;
	return h * 60 + min;
}

function minutesToTimeLabel(mins: number): string {
	const h = Math.floor(mins / 60) % 24;
	const m = mins % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface LaidOutOccurrence {
	occ: Occurrence;
	startMin: number;
	endMin: number;
	col: number;
	cols: number;
}

// Assigns side-by-side columns to a day's overlapping occurrences (greedy
// layout: reuse the column that frees up earliest; the number of columns a
// connected cluster of overlapping occurrences shares is its peak
// concurrency).
function layoutTimedOccurrences(dayOccurrences: Occurrence[]): LaidOutOccurrence[] {
	const items: LaidOutOccurrence[] = dayOccurrences
		.map((occ) => {
			const startMin = parseTimeToMinutes(occ.display.time) ?? 0;
			const endMin = Math.max(
				startMin + MIN_BLOCK_MIN,
				parseTimeToMinutes(occ.display.end) ?? startMin + DEFAULT_DURATION_MIN
			);
			return { occ, startMin, endMin, col: 0, cols: 1 };
		})
		.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

	let clusterItems: LaidOutOccurrence[] = [];
	let clusterEnd = -1;
	let columnEnds: number[] = [];

	const finalizeCluster = () => {
		for (const it of clusterItems) it.cols = columnEnds.length;
	};

	for (const item of items) {
		if (clusterItems.length > 0 && item.startMin >= clusterEnd) {
			finalizeCluster();
			clusterItems = [];
			columnEnds = [];
			clusterEnd = -1;
		}

		let assigned = columnEnds.findIndex((end) => end <= item.startMin);
		if (assigned === -1) {
			assigned = columnEnds.length;
			columnEnds.push(item.endMin);
		} else {
			columnEnds[assigned] = item.endMin;
		}
		item.col = assigned;
		clusterItems.push(item);
		clusterEnd = Math.max(clusterEnd, item.endMin);
	}
	if (clusterItems.length > 0) finalizeCluster();

	return items;
}

// Month/weekday names and the first day of the week come from Obsidian's own
// moment instance, which is already set to the app's language - if the user
// switches Obsidian's language, these follow automatically.
function monthNames(): string[] {
	return moment.months();
}

// Short weekday names (2 characters), ordered starting at the locale's first
// day of the week.
function weekdayLabels(): string[] {
	return moment.weekdaysMin(true);
}

function shortWeekdayLabel(d: Date): string {
	return moment(d).format("dd");
}

function localeFirstDay(): number {
	return moment.localeData().firstDayOfWeek();
}

function weekdayIndex(d: Date): number {
	return (d.getDay() - localeFirstDay() + 7) % 7;
}

function toDateKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
	return toDateKey(a) === toDateKey(b);
}

function startOfWeek(d: Date): Date {
	const copy = new Date(d);
	copy.setHours(0, 0, 0, 0);
	copy.setDate(copy.getDate() - weekdayIndex(copy));
	return copy;
}

function addDays(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + n);
	return copy;
}

function addMonths(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setMonth(copy.getMonth() + n);
	return copy;
}

function addYears(d: Date, n: number): Date {
	const copy = new Date(d);
	copy.setFullYear(copy.getFullYear() + n);
	return copy;
}

// UI language: German only when Obsidian's moment locale is "de", English
// otherwise (not full i18n, just these two languages). The frontmatter field
// names (title/date/time/end/location/...) are unaffected by this - they're
// the vault's data schema, not UI text, see regeln/vorlagen/termin.md.
const TRANSLATIONS = {
	de: {
		day: "Tag",
		week: "Woche",
		month: "Monat",
		year: "Jahr",
		today: "Heute",
		allDay: "Ganztägig",
		newEvent: "Neuer Termin",
		editEvent: "Termin bearbeiten",
		titleLabel: "Titel",
		titlePlaceholder: "Kurzbeschreibung",
		dateLabel: "Datum",
		timeLabel: "Zeit",
		timeDesc: "Leer = ganztägig",
		endLabel: "Ende",
		locationLabel: "Ort",
		recurrenceLabel: "Wiederholung",
		recurrenceNone: "Keine",
		recurrenceDaily: "Täglich",
		recurrenceWeekly: "Wöchentlich",
		recurrenceMonthly: "Monatlich",
		recurrenceYearly: "Jährlich",
		recurrenceIntervalLabel: "Intervall",
		recurrenceIntervalDescPrefix: "z. B. 2 = alle 2",
		recurrenceUnitDaily: "Tage",
		recurrenceUnitWeekly: "Wochen",
		recurrenceUnitMonthly: "Monate",
		recurrenceUnitYearly: "Jahre",
		recurrenceEndLabel: "Endet",
		recurrenceEndNever: "Nie",
		recurrenceEndUntil: "Am Datum",
		recurrenceEndCount: "Nach Anzahl",
		recurrenceUntilLabel: "Enddatum",
		recurrenceCountLabel: "Anzahl Wiederholungen",
		create: "Anlegen",
		save: "Speichern",
		cancel: "Abbrechen",
		select: "Auswählen",
		delete: "Löschen",
		openNote: "Notiz öffnen",
		edit: "Bearbeiten",
		errorTitleMissing: "Titel fehlt",
		errorDateFormat: "Datum muss im Format YYYY-MM-DD sein",
		errorTimeFormat: "Zeit muss im Format HH:mm sein",
		errorEndFormat: "Ende muss im Format HH:mm sein",
		errorRecurrenceIntervalFormat: "Intervall muss eine Zahl ≥ 1 sein",
		errorRecurrenceUntilFormat: "Enddatum muss im Format YYYY-MM-DD sein",
		errorRecurrenceCountFormat: "Anzahl Wiederholungen muss eine Zahl ≥ 1 sein",
		errorCreateFailed: "Termin konnte nicht angelegt werden",
		errorSaveFailed: "Termin konnte nicht gespeichert werden",
		errorDeleteFailed: "Termin konnte nicht gelöscht werden",
		openCalendar: "Kalender öffnen",
		openDayView: "Tagesansicht öffnen",
		calendarViewName: "Kalender",
		settingsFolderName: "Ordner für Termin-Notizen",
		settingsFolderDesc: "Pfad relativ zum Vault, z. B. Calendar",
		settingsTagName: "Tag für Termine",
		settingsTagDesc: "Frontmatter-Tag, der eine Notiz als Termin kennzeichnet",
		scopeQuestionTitle: "Diese Änderung betrifft…",
		scopeThisEvent: "Nur diesen Termin",
		scopeThisEventDesc: "Erstellt eine Ausnahme, alle anderen Vorkommen der Serie bleiben unverändert.",
		scopeThisAndFollowing: "Diesen und alle folgenden",
		scopeThisAndFollowingDesc: "Teilt die Serie an diesem Datum, frühere Vorkommen bleiben unverändert.",
		scopeSeries: "Die ganze Serie",
		scopeSeriesDesc: "Ändert das Muster für alle Vorkommen der Serie.",
	},
	en: {
		day: "Day",
		week: "Week",
		month: "Month",
		year: "Year",
		today: "Today",
		allDay: "All day",
		newEvent: "New event",
		editEvent: "Edit event",
		titleLabel: "Title",
		titlePlaceholder: "Short description",
		dateLabel: "Date",
		timeLabel: "Time",
		timeDesc: "Empty = all day",
		endLabel: "End",
		locationLabel: "Location",
		recurrenceLabel: "Repeat",
		recurrenceNone: "None",
		recurrenceDaily: "Daily",
		recurrenceWeekly: "Weekly",
		recurrenceMonthly: "Monthly",
		recurrenceYearly: "Yearly",
		recurrenceIntervalLabel: "Interval",
		recurrenceIntervalDescPrefix: "e.g. 2 = every 2",
		recurrenceUnitDaily: "days",
		recurrenceUnitWeekly: "weeks",
		recurrenceUnitMonthly: "months",
		recurrenceUnitYearly: "years",
		recurrenceEndLabel: "Ends",
		recurrenceEndNever: "Never",
		recurrenceEndUntil: "On date",
		recurrenceEndCount: "After a number of times",
		recurrenceUntilLabel: "End date",
		recurrenceCountLabel: "Number of occurrences",
		create: "Create",
		save: "Save",
		cancel: "Cancel",
		select: "Select",
		delete: "Delete",
		openNote: "Open note",
		edit: "Edit",
		errorTitleMissing: "Title is missing",
		errorDateFormat: "Date must be in YYYY-MM-DD format",
		errorTimeFormat: "Time must be in HH:mm format",
		errorEndFormat: "End must be in HH:mm format",
		errorRecurrenceIntervalFormat: "Interval must be a number ≥ 1",
		errorRecurrenceUntilFormat: "End date must be in YYYY-MM-DD format",
		errorRecurrenceCountFormat: "Number of occurrences must be a number ≥ 1",
		errorCreateFailed: "Could not create event",
		errorSaveFailed: "Could not save event",
		errorDeleteFailed: "Could not delete event",
		openCalendar: "Open calendar",
		openDayView: "Open day view",
		calendarViewName: "Calendar",
		settingsFolderName: "Folder for event notes",
		settingsFolderDesc: "Path relative to the vault, e.g. Calendar",
		settingsTagName: "Tag for events",
		settingsTagDesc: "Frontmatter tag that marks a note as an event",
		scopeQuestionTitle: "This change applies to…",
		scopeThisEvent: "This event only",
		scopeThisEventDesc: "Creates an exception; every other occurrence in the series stays unchanged.",
		scopeThisAndFollowing: "This and all following events",
		scopeThisAndFollowingDesc: "Splits the series at this date; earlier occurrences stay unchanged.",
		scopeSeries: "The entire series",
		scopeSeriesDesc: "Changes the pattern for every occurrence in the series.",
	},
} as const;

type TranslationKey = keyof (typeof TRANSLATIONS)["de"];

function currentLang(): "de" | "en" {
	return moment.locale().toLowerCase().startsWith("de") ? "de" : "en";
}

function t(key: TranslationKey): string {
	return TRANSLATIONS[currentLang()][key];
}

// In-memory form state for the create/edit dialogs. English field names are
// fine here - the mapping to the German frontmatter keys happens explicitly
// wherever a note is read or written (see parseCalendarEvent and the
// frontmatter builders below).
type RecurrenceEndType = "never" | "until" | "count";

interface EventFormValues {
	title: string;
	date: string;
	time: string;
	end: string;
	location: string;
	recurrenceFreq: "" | RecurrenceFreq;
	recurrenceInterval: string; // numeric text, e.g. "2" for "every 2 weeks"
	recurrenceEndType: RecurrenceEndType;
	recurrenceUntil: string; // YYYY-MM-DD, only used when recurrenceEndType === "until"
	recurrenceCount: string; // numeric text, only used when recurrenceEndType === "count"
}

// Turns the structured recurrence fields back into the RRULE-lite string
// stored in frontmatter (INTERVAL is omitted when it's just 1, the default).
function combineRecurrence(values: EventFormValues): string {
	if (!values.recurrenceFreq) return "";
	const parts = [`FREQ=${values.recurrenceFreq}`];

	const interval = parseInt(values.recurrenceInterval, 10);
	if (interval > 1) parts.push(`INTERVAL=${interval}`);

	if (values.recurrenceEndType === "until" && values.recurrenceUntil) {
		parts.push(`UNTIL=${values.recurrenceUntil}`);
	}
	if (values.recurrenceEndType === "count" && values.recurrenceCount) {
		parts.push(`COUNT=${values.recurrenceCount}`);
	}

	return parts.join(";");
}

function validateEventFormValues(values: EventFormValues): string | null {
	if (!values.title.trim()) return t("errorTitleMissing");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) return t("errorDateFormat");
	if (values.time && !/^\d{1,2}:\d{2}$/.test(values.time)) return t("errorTimeFormat");
	if (values.end && !/^\d{1,2}:\d{2}$/.test(values.end)) return t("errorEndFormat");

	if (values.recurrenceFreq) {
		const interval = parseInt(values.recurrenceInterval, 10);
		if (!(interval >= 1)) return t("errorRecurrenceIntervalFormat");
		if (values.recurrenceEndType === "until" && !/^\d{4}-\d{2}-\d{2}$/.test(values.recurrenceUntil)) {
			return t("errorRecurrenceUntilFormat");
		}
		if (values.recurrenceEndType === "count" && !(parseInt(values.recurrenceCount, 10) >= 1)) {
			return t("errorRecurrenceCountFormat");
		}
	}

	return null;
}

const RECURRENCE_UNIT_KEYS: Record<RecurrenceFreq, TranslationKey> = {
	DAILY: "recurrenceUnitDaily",
	WEEKLY: "recurrenceUnitWeekly",
	MONTHLY: "recurrenceUnitMonthly",
	YEARLY: "recurrenceUnitYearly",
};

// The interval/end-date/end-count fields only make sense once a frequency is
// chosen, and which of them apply depends on the chosen end type - so this
// sub-section is cleared and rebuilt on every relevant change instead of
// being static like the fields above it.
function renderRecurrenceDetails(container: HTMLElement, values: EventFormValues, rerender: () => void) {
	container.empty();
	if (!values.recurrenceFreq) return;

	new Setting(container)
		.setName(t("recurrenceIntervalLabel"))
		.setDesc(`${t("recurrenceIntervalDescPrefix")} ${t(RECURRENCE_UNIT_KEYS[values.recurrenceFreq])}`)
		.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setValue(values.recurrenceInterval).onChange((v) => (values.recurrenceInterval = v.trim()));
		});

	new Setting(container).setName(t("recurrenceEndLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("never", t("recurrenceEndNever"))
			.addOption("until", t("recurrenceEndUntil"))
			.addOption("count", t("recurrenceEndCount"))
			.setValue(values.recurrenceEndType)
			.onChange((v) => {
				values.recurrenceEndType = v as RecurrenceEndType;
				rerender();
			});
	});

	if (values.recurrenceEndType === "until") {
		new Setting(container).setName(t("recurrenceUntilLabel")).addText((text) => {
			text.inputEl.type = "date";
			text.setValue(values.recurrenceUntil).onChange((v) => (values.recurrenceUntil = v.trim()));
		});
	}

	if (values.recurrenceEndType === "count") {
		new Setting(container).setName(t("recurrenceCountLabel")).addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setValue(values.recurrenceCount).onChange((v) => (values.recurrenceCount = v.trim()));
		});
	}
}

function buildEventFields(contentEl: HTMLElement, values: EventFormValues, opts: { showRecurrence?: boolean } = {}) {
	new Setting(contentEl).setName(t("titleLabel")).addText((text) => {
		text.setValue(values.title).setPlaceholder(t("titlePlaceholder")).onChange((v) => (values.title = v));
		text.inputEl.focus();
	});

	new Setting(contentEl)
		.setName(t("dateLabel"))
		.addText((text) => {
			text.inputEl.type = "date";
			text.setValue(values.date).onChange((v) => (values.date = v.trim()));
		});

	new Setting(contentEl)
		.setName(t("timeLabel"))
		.setDesc(t("timeDesc"))
		.addText((text) => {
			text.inputEl.type = "time";
			text.setValue(values.time).onChange((v) => (values.time = v.trim()));
		});

	new Setting(contentEl)
		.setName(t("endLabel"))
		.addText((text) => {
			text.inputEl.type = "time";
			text.setValue(values.end).onChange((v) => (values.end = v.trim()));
		});

	new Setting(contentEl)
		.setName(t("locationLabel"))
		.addText((text) => text.setValue(values.location).onChange((v) => (values.location = v.trim())));

	if (opts.showRecurrence === false) return;

	new Setting(contentEl).setName(t("recurrenceLabel")).addDropdown((dropdown) => {
		dropdown
			.addOption("", t("recurrenceNone"))
			.addOption("DAILY", t("recurrenceDaily"))
			.addOption("WEEKLY", t("recurrenceWeekly"))
			.addOption("MONTHLY", t("recurrenceMonthly"))
			.addOption("YEARLY", t("recurrenceYearly"))
			.setValue(values.recurrenceFreq)
			.onChange((v) => {
				values.recurrenceFreq = v as EventFormValues["recurrenceFreq"];
				rerenderDetails();
			});
	});

	const recurrenceDetails = contentEl.createDiv();
	const rerenderDetails = () => renderRecurrenceDetails(recurrenceDetails, values, rerenderDetails);
	rerenderDetails();
}

class NewEventModal extends Modal {
	private values: EventFormValues;
	private onSubmit: (values: EventFormValues) => void;

	constructor(
		app: App,
		initial: { date: string; time?: string; end?: string },
		onSubmit: (values: EventFormValues) => void
	) {
		super(app);
		this.values = {
			title: "",
			date: initial.date,
			time: initial.time ?? "",
			end: initial.end ?? "",
			location: "",
			recurrenceFreq: "",
			recurrenceInterval: "1",
			recurrenceEndType: "never",
			recurrenceUntil: "",
			recurrenceCount: "",
		};
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("newEvent"));
		buildEventFields(contentEl, this.values);

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("create"))
					.setCta()
					.onClick(() => {
						const error = validateEventFormValues(this.values);
						if (error) {
							new Notice(error);
							return;
						}
						this.close();
						this.onSubmit(this.values);
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class EditEventModal extends Modal {
	private values: EventFormValues;
	private allowRecurrence: boolean;
	private onSave: (values: EventFormValues) => void;
	private onOpenNote: () => void;
	private onDelete: () => void;

	constructor(
		app: App,
		ev: CalendarEvent,
		callbacks: { onSave: (values: EventFormValues) => void; onOpenNote: () => void; onDelete: () => void },
		allowRecurrence = true
	) {
		super(app);
		const rule = ev.recurrence ? parseRecurrenceRule(ev.recurrence) : null;
		this.values = {
			title: ev.title,
			date: ev.date,
			time: ev.time ?? "",
			end: ev.end ?? "",
			location: ev.location ?? "",
			recurrenceFreq: rule?.freq ?? "",
			recurrenceInterval: String(rule?.interval ?? 1),
			recurrenceEndType: rule?.until ? "until" : rule?.count ? "count" : "never",
			recurrenceUntil: rule?.until ?? "",
			recurrenceCount: rule?.count ? String(rule.count) : "",
		};
		this.allowRecurrence = allowRecurrence;
		this.onSave = callbacks.onSave;
		this.onOpenNote = callbacks.onOpenNote;
		this.onDelete = callbacks.onDelete;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("editEvent"));
		buildEventFields(contentEl, this.values, { showRecurrence: this.allowRecurrence });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("delete"))
					.setWarning()
					.onClick(() => {
						this.close();
						this.onDelete();
					})
			)
			.addButton((btn) =>
				btn.setButtonText(t("openNote")).onClick(() => {
					this.close();
					this.onOpenNote();
				})
			)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("save"))
					.setCta()
					.onClick(() => {
						const error = validateEventFormValues(this.values);
						if (error) {
							new Notice(error);
							return;
						}
						this.close();
						this.onSave(this.values);
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Asks which occurrences of a series a change applies to - Outlook's
// classic three-way choice. Only shown for occurrences that belong to a
// series (see CalendarView.isPartOfSeries); standalone events skip straight
// to editing/deleting.
class ScopeChoiceModal extends Modal {
	private onChoose: (scope: "this" | "following" | "series") => void;

	constructor(app: App, onChoose: (scope: "this" | "following" | "series") => void) {
		super(app);
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t("scopeQuestionTitle"));

		const choose = (scope: "this" | "following" | "series") => {
			this.close();
			this.onChoose(scope);
		};

		new Setting(contentEl)
			.setName(t("scopeThisEvent"))
			.setDesc(t("scopeThisEventDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).setCta().onClick(() => choose("this")));
		new Setting(contentEl)
			.setName(t("scopeThisAndFollowing"))
			.setDesc(t("scopeThisAndFollowingDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).onClick(() => choose("following")));
		new Setting(contentEl)
			.setName(t("scopeSeries"))
			.setDesc(t("scopeSeriesDesc"))
			.addButton((btn) => btn.setButtonText(t("select")).onClick(() => choose("series")));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class CalendarView extends ItemView {
	plugin: PlainCalendarPlugin;
	mode: ViewMode;
	anchor: Date = new Date();
	private events: CalendarEvent[] = [];
	private seriesIndex: SeriesIndex = { exceptionsBySeriesDate: new Map(), exceptionsBySeries: new Map(), mastersByPath: new Map() };
	// Virtual, read-only entries from sister plugins - see "Virtual entries
	// from sister plugins" above. Empty unless the respective plugin is
	// installed, enabled, and has its "show in calendar" setting on.
	private virtualBirthdays: VirtualBirthdayEntry[] = [];
	private virtualTasks: VirtualTaskEntry[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: PlainCalendarPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = plugin.settings.viewMode;
	}

	getViewType() {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText() {
		return t("calendarViewName");
	}

	getIcon() {
		return "calendar";
	}

	async onOpen() {
		this.anchor.setHours(0, 0, 0, 0);
		await this.render();
	}

	async onClose() {
		this.containerEl.empty();
	}

	private loadEvents(): CalendarEvent[] {
		const folder = normalizePath(this.plugin.settings.eventsFolder);
		const tag = this.plugin.settings.eventTag;
		const events: CalendarEvent[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folder + "/") && file.path !== folder) {
				continue;
			}
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as EventFrontmatter | undefined;
			if (!fm) continue;

			const event = parseCalendarEvent(file, fm, tag);
			if (event) events.push(event);
		}

		events.sort((a, b) => {
			if (a.date !== b.date) return a.date < b.date ? -1 : 1;
			if (a.time && b.time) return a.time < b.time ? -1 : 1;
			if (a.time) return -1;
			if (b.time) return 1;
			return 0;
		});

		return events;
	}

	// Reads people/*.md via plain-contacts' own settings (folder, type value,
	// opt-in toggle) - returns [] if plain-contacts isn't installed/enabled or
	// its "show birthdays in calendar" setting is off. Read-only: never
	// writes to plain-contacts' notes or settings.
	private loadVirtualBirthdays(): VirtualBirthdayEntry[] {
		const settings = getExternalPluginSettings<ContactsPluginSettings>(this.app, "plain-contacts");
		if (!settings?.showInCalendar) return [];

		const folder = normalizePath(settings.folder || "people");
		const typeValue = settings.typeValue || "person";
		const entries: VirtualBirthdayEntry[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folder + "/") && file.path !== folder) continue;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
				| { type?: string; title?: string; birthdate?: string }
				| undefined;
			if (!fm || fm.type !== typeValue) continue;

			const parsed = parseBirthdateMonthDay(fm.birthdate ? String(fm.birthdate) : "");
			if (!parsed) continue;

			entries.push({
				title: fm.title ? String(fm.title) : file.basename,
				month: parsed.month,
				day: parsed.day,
				sourcePath: file.path,
			});
		}

		return entries;
	}

	// Reads Tasks/*.md via plain-tasks' own settings (folder, tag, opt-in
	// toggle) - returns [] if plain-tasks isn't installed/enabled or its
	// "show tasks in calendar" setting is off. Only tasks with a `due` date
	// are shown, at that exact date - a recurring task's series isn't
	// expanded here, see VirtualTaskEntry. Read-only: never writes to
	// plain-tasks' notes or settings.
	private loadVirtualTasks(): VirtualTaskEntry[] {
		const settings = getExternalPluginSettings<TasksPluginSettings>(this.app, "plain-tasks");
		if (!settings?.showInCalendar) return [];

		const folder = normalizePath(settings.tasksFolder || "Tasks");
		const tag = settings.taskTag || "task";
		const entries: VirtualTaskEntry[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(folder + "/") && file.path !== folder) continue;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
				| { tags?: string | string[]; title?: string; due?: string }
				| undefined;
			if (!fm || !fm.due) continue;

			const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
			if (tag && !tags.includes(tag)) continue;

			entries.push({
				title: fm.title ? String(fm.title) : file.basename,
				date: String(fm.due).slice(0, 10),
				sourcePath: file.path,
			});
		}

		return entries;
	}

	private virtualEntriesFor(d: Date): VirtualEntry[] {
		return virtualEntriesOn(d, this.virtualBirthdays, this.virtualTasks);
	}

	// Opens the source note of a virtual entry - the only interaction a
	// virtual entry supports, deliberately no edit modal (see
	// wireVirtualEntryElement): these are owned by another plugin's notes,
	// not this plugin's event notes.
	private async openVirtualSource(entry: VirtualEntry) {
		const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}

	// Click opens the source note directly (no edit modal, unlike
	// wireOccurrenceElement); right click offers the same as a minimal,
	// non-editable context menu - visually distinguished via
	// plain-calendar-virtual-* classes, see styles.css.
	private wireVirtualEntryElement(el: HTMLElement, entry: VirtualEntry) {
		el.onclick = (e) => {
			e.stopPropagation();
			this.openVirtualSource(entry);
		};
		el.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle(t("openNote"))
					.setIcon("file-text")
					.onClick(() => this.openVirtualSource(entry))
			);
			menu.showAtMouseEvent(e);
		};
	}

	// Creates the target folder if it's missing. Only swallows the harmless
	// case where a second, near-simultaneous call already created it - any
	// other error (e.g. missing write permissions) is rethrown.
	private async ensureFolder(folderPath: string) {
		if (this.app.vault.getAbstractFileByPath(folderPath)) return;
		try {
			await this.app.vault.createFolder(folderPath);
		} catch (err) {
			if (!this.app.vault.getAbstractFileByPath(folderPath)) throw err;
		}
	}

	// The metadata cache is not immediately up to date after
	// vault.create()/processFrontMatter() - reading it right away would miss
	// the new/changed event or show stale data. Wait for the cache's
	// "changed" event for this file (with a timeout as a safety net) before
	// re-rendering.
	private waitForMetadata(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const ref = this.app.metadataCache.on("changed", (changedFile) => {
				if (changedFile.path === file.path && !settled) {
					settled = true;
					this.app.metadataCache.offref(ref);
					resolve();
				}
			});
			setTimeout(() => {
				if (!settled) {
					settled = true;
					this.app.metadataCache.offref(ref);
					resolve();
				}
			}, 1500);
		});
	}

	private safeFileName(date: string, title: string): string {
		const safeName = title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
		return `${date}-${safeName}.md`;
	}

	private async createNote(fields: {
		date: string;
		title: string;
		time?: string;
		end?: string;
		location?: string;
		recurrence?: string;
		excludedDates?: string[];
		seriesPath?: string;
		replacesDate?: string;
	}): Promise<TFile> {
		const folderPath = normalizePath(this.plugin.settings.eventsFolder);
		await this.ensureFolder(folderPath);
		const path = normalizePath(`${folderPath}/${this.safeFileName(fields.date, fields.title)}`);
		const today = toDateKey(new Date());

		let frontmatter =
			`---\n` +
			`title: ${fields.title}\n` +
			`tags:\n  - ${this.plugin.settings.eventTag}\n` +
			`date: ${fields.date}\n` +
			`time: ${fields.time ?? ""}\n` +
			`end: ${fields.end ?? ""}\n` +
			`location: ${fields.location ?? ""}\n`;
		if (fields.recurrence !== undefined) frontmatter += `recurrence: ${fields.recurrence}\n`;
		if (fields.excludedDates?.length) {
			frontmatter += `excluded:\n${fields.excludedDates.map((d) => `  - ${d}`).join("\n")}\n`;
		}
		if (fields.seriesPath) frontmatter += `series: ${fields.seriesPath}\n`;
		if (fields.replacesDate) frontmatter += `replaces: ${fields.replacesDate}\n`;
		frontmatter += `dateCreated: ${today}\ndateModified: ${today}\n---\n\n`;

		const file = await this.app.vault.create(path, frontmatter);
		await this.waitForMetadata(file);
		return file;
	}

	private async updateFrontmatter(file: TFile, mutate: (fm: any) => void, errorMsg: string) {
		try {
			await this.app.fileManager.processFrontMatter(file, mutate);
			await this.waitForMetadata(file);
			this.render();
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(errorMsg);
		}
	}

	private createEvent(date: Date, time?: string) {
		const suggestedEnd = time
			? minutesToTimeLabel((parseTimeToMinutes(time) ?? 0) + DEFAULT_DURATION_MIN)
			: "";

		new NewEventModal(
			this.app,
			{ date: toDateKey(date), time: time ?? "", end: suggestedEnd },
			async (values) => {
				try {
					await this.createNote({
						date: values.date,
						title: values.title,
						time: values.time,
						end: values.end,
						location: values.location,
						recurrence: combineRecurrence(values),
					});
					this.render();
				} catch (err) {
					console.error("Plain Calendar:", err);
					new Notice(t("errorCreateFailed"));
				}
			}
		).open();
	}

	private async openEvent(file: TFile) {
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private openEditModalFor(
		ev: CalendarEvent,
		opts: { allowRecurrence: boolean; onSave: (values: EventFormValues) => void; onDelete: () => void }
	) {
		new EditEventModal(
			this.app,
			ev,
			{ onSave: opts.onSave, onOpenNote: () => this.openEvent(ev.file), onDelete: opts.onDelete },
			opts.allowRecurrence
		).open();
	}

	private isPartOfSeries(occ: Occurrence): boolean {
		return occ.kind !== "single";
	}

	private editOccurrence(occ: Occurrence) {
		if (!this.isPartOfSeries(occ)) {
			this.editSingleEvent(occ.display);
			return;
		}
		new ScopeChoiceModal(this.app, (scope) => {
			if (scope === "this") this.editThisOccurrence(occ);
			else if (scope === "following") this.editThisAndFollowing(occ);
			else this.editSeries(occ);
		}).open();
	}

	private deleteOccurrence(occ: Occurrence) {
		if (!this.isPartOfSeries(occ)) {
			this.deleteSingleEvent(occ.display);
			return;
		}
		new ScopeChoiceModal(this.app, (scope) => {
			if (scope === "this") this.deleteThisOccurrence(occ);
			else if (scope === "following") this.deleteThisAndFollowing(occ);
			else this.deleteSeries(occ);
		}).open();
	}

	private editSingleEvent(ev: CalendarEvent) {
		this.openEditModalFor(ev, {
			allowRecurrence: true,
			onSave: (values) =>
				this.updateFrontmatter(
					ev.file,
					(fm) => {
						fm.title = values.title;
						fm.date = values.date;
						fm.time = values.time;
						fm.end = values.end;
						fm.location = values.location;
						fm.recurrence = combineRecurrence(values);
						fm.dateModified = toDateKey(new Date());
					},
					t("errorSaveFailed")
				),
			onDelete: () => this.deleteSingleEvent(ev),
		});
	}

	private async deleteSingleEvent(ev: CalendarEvent) {
		try {
			await this.app.fileManager.trashFile(ev.file);
			this.render();
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	// "Nur dieser Termin": for an already-materialized exception, edit its
	// own note; for a pattern-generated occurrence, create a new exception
	// note that overrides just this slot (see createNote's serie/ersetzt).
	private editThisOccurrence(occ: Occurrence) {
		if (occ.kind === "exception") {
			this.openEditModalFor(occ.display, {
				allowRecurrence: false,
				onSave: (values) =>
					this.updateFrontmatter(
						occ.display.file,
						(fm) => {
							fm.title = values.title;
							fm.date = values.date;
							fm.time = values.time;
							fm.end = values.end;
							fm.location = values.location;
							fm.dateModified = toDateKey(new Date());
						},
						t("errorSaveFailed")
					),
				onDelete: () => this.deleteThisOccurrence(occ),
			});
			return;
		}

		const master = occ.master!;
		const seed: CalendarEvent = { ...master, date: occ.date, recurrence: undefined };
		this.openEditModalFor(seed, {
			allowRecurrence: false,
			onSave: async (values) => {
				try {
					await this.createNote({
						date: values.date,
						title: values.title,
						time: values.time,
						end: values.end,
						location: values.location,
						seriesPath: master.file.path,
						replacesDate: occ.date,
					});
					this.render();
				} catch (err) {
					console.error("Plain Calendar:", err);
					new Notice(t("errorCreateFailed"));
				}
			},
			onDelete: () => this.deleteThisOccurrence(occ),
		});
	}

	private async addExclusion(master: CalendarEvent, date: string) {
		await this.app.fileManager.processFrontMatter(master.file, (fm) => {
			const list: string[] = Array.isArray(fm.excluded) ? fm.excluded : fm.excluded ? [fm.excluded] : [];
			if (!list.includes(date)) list.push(date);
			list.sort();
			fm.excluded = list;
			fm.dateModified = toDateKey(new Date());
		});
		await this.waitForMetadata(master.file);
	}

	// "Nur dieser Termin" löschen: an existing exception note is deleted
	// outright, but its replacesDate must still be excluded on the master -
	// otherwise the pattern would regenerate that occurrence right away.
	private async deleteThisOccurrence(occ: Occurrence) {
		try {
			if (occ.kind === "exception") {
				const master = occ.master;
				await this.app.fileManager.trashFile(occ.display.file);
				if (master) await this.addExclusion(master, occ.display.replacesDate ?? occ.date);
			} else if (occ.kind === "master" && occ.master) {
				await this.addExclusion(occ.master, occ.date);
			}
			this.render();
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	private editSeries(occ: Occurrence) {
		const master = occ.master;
		if (!master) return;
		this.openEditModalFor(master, {
			allowRecurrence: true,
			onSave: (values) =>
				this.updateFrontmatter(
					master.file,
					(fm) => {
						fm.title = values.title;
						fm.date = values.date;
						fm.time = values.time;
						fm.end = values.end;
						fm.location = values.location;
						fm.recurrence = combineRecurrence(values);
						fm.dateModified = toDateKey(new Date());
					},
					t("errorSaveFailed")
				),
			onDelete: () => this.deleteSeries(occ),
		});
	}

	private async deleteSeries(occ: Occurrence) {
		const master = occ.master;
		if (!master) return;
		try {
			const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
			for (const exc of exceptions) {
				await this.app.fileManager.trashFile(exc.file);
			}
			await this.app.fileManager.trashFile(master.file);
			this.render();
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	// Splits a recurring series at occurrence date `splitDate`: caps the
	// existing master to end just before it (via an exact occurrence count,
	// so no date arithmetic is needed) and creates a new master note
	// starting at `splitDate` that continues the same pattern. Exceptions
	// and excluded dates on/after `splitDate` move to the new master so they
	// stay attached to the right note. Returns null if `splitDate` is the
	// series' first occurrence - there's nothing to split off, the caller
	// should treat that as a whole-series operation instead.
	private async splitSeriesAt(master: CalendarEvent, splitDate: string): Promise<CalendarEvent | null> {
		const rule = parseRecurrenceRule(master.recurrence ?? "");
		if (!rule) return null;
		const start = parseDateKey(master.date);
		const idx = occurrenceIndex(rule, start, parseDateKey(splitDate));
		if (idx === null || idx <= 0) return null;

		await this.app.fileManager.processFrontMatter(master.file, (fm) => {
			fm.recurrence = buildRecurrenceRuleString({ freq: rule.freq, interval: rule.interval, count: idx });
			fm.excluded = (master.excludedDates ?? []).filter((d) => d < splitDate);
			fm.dateModified = toDateKey(new Date());
		});
		await this.waitForMetadata(master.file);

		const newRule: RecurrenceRule = {
			freq: rule.freq,
			interval: rule.interval,
			until: rule.until,
			count: rule.count !== undefined ? rule.count - idx : undefined,
		};
		const newFile = await this.createNote({
			date: splitDate,
			title: master.title,
			time: master.time,
			end: master.end,
			location: master.location,
			recurrence: buildRecurrenceRuleString(newRule),
			excludedDates: (master.excludedDates ?? []).filter((d) => d >= splitDate),
		});

		const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
		for (const exc of exceptions) {
			if ((exc.replacesDate ?? "") >= splitDate) {
				await this.app.fileManager.processFrontMatter(exc.file, (fm) => {
					fm.series = newFile.path;
					fm.dateModified = toDateKey(new Date());
				});
				await this.waitForMetadata(exc.file);
			}
		}

		const fm = this.app.metadataCache.getFileCache(newFile)?.frontmatter as EventFrontmatter | undefined;
		return fm ? parseCalendarEvent(newFile, fm, this.plugin.settings.eventTag) : null;
	}

	private async editThisAndFollowing(occ: Occurrence) {
		const master = occ.master;
		if (!master) return;
		try {
			const newMaster = await this.splitSeriesAt(master, occ.date);
			if (!newMaster) {
				this.editSeries(occ);
				return;
			}
			this.render();
			this.openEditModalFor(newMaster, {
				allowRecurrence: true,
				onSave: (values) =>
					this.updateFrontmatter(
						newMaster.file,
						(fm) => {
							fm.title = values.title;
							fm.date = values.date;
							fm.time = values.time;
							fm.end = values.end;
							fm.location = values.location;
							fm.recurrence = combineRecurrence(values);
							fm.dateModified = toDateKey(new Date());
						},
						t("errorSaveFailed")
					),
				onDelete: () => this.deleteSeries({ display: newMaster, date: newMaster.date, kind: "master", master: newMaster }),
			});
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(t("errorSaveFailed"));
		}
	}

	private async deleteThisAndFollowing(occ: Occurrence) {
		const master = occ.master;
		if (!master) return;
		const rule = parseRecurrenceRule(master.recurrence ?? "");
		if (!rule) return;
		const start = parseDateKey(master.date);
		const idx = occurrenceIndex(rule, start, parseDateKey(occ.date));
		if (idx === null || idx <= 0) {
			await this.deleteSeries(occ);
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(master.file, (fm) => {
				fm.recurrence = buildRecurrenceRuleString({ freq: rule.freq, interval: rule.interval, count: idx });
				fm.excluded = (master.excludedDates ?? []).filter((d) => d < occ.date);
				fm.dateModified = toDateKey(new Date());
			});
			await this.waitForMetadata(master.file);

			const exceptions = this.seriesIndex.exceptionsBySeries.get(master.file.path) ?? [];
			for (const exc of exceptions) {
				if ((exc.replacesDate ?? "") >= occ.date) {
					await this.app.fileManager.trashFile(exc.file);
				}
			}
			this.render();
		} catch (err) {
			console.error("Plain Calendar:", err);
			new Notice(t("errorDeleteFailed"));
		}
	}

	private showEventContextMenu(e: MouseEvent, occ: Occurrence) {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("edit"))
				.setIcon("pencil")
				.onClick(() => this.editOccurrence(occ))
		);
		menu.addItem((item) =>
			item
				.setTitle(t("delete"))
				.setIcon("trash")
				.onClick(() => this.deleteOccurrence(occ))
		);
		menu.showAtMouseEvent(e);
	}

	// Right click on a day cell (month view background, year view mini-day):
	// always offers to jump to the day view, plus edit/delete for every
	// occurrence on that date if there are any. Year view's mini-days don't
	// render a chip per occurrence (just a dot), so this lists all of them
	// rather than targeting one specific element like showEventContextMenu.
	private showDayContextMenu(e: MouseEvent, d: Date, occs: Occurrence[], virtualEntries: VirtualEntry[] = []) {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("openDayView"))
				.setIcon("calendar")
				.onClick(() => {
					this.anchor = d;
					this.setMode("day");
				})
		);

		occs.forEach((occ) => {
			menu.addSeparator();
			const label = eventLabel(occ.display, { withTime: true, isException: occ.kind === "exception" });
			menu.addItem((item) =>
				item
					.setTitle(`${t("edit")}: ${label}`)
					.setIcon("pencil")
					.onClick(() => this.editOccurrence(occ))
			);
			menu.addItem((item) =>
				item
					.setTitle(`${t("delete")}: ${label}`)
					.setIcon("trash")
					.onClick(() => this.deleteOccurrence(occ))
			);
		});

		// Virtual entries (birthdays/tasks from sister plugins) only ever
		// offer "open note" - no edit/delete, they aren't owned by this
		// plugin, see wireVirtualEntryElement.
		virtualEntries.forEach((entry) => {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(`${t("openNote")}: ${virtualEntryLabel(entry)}`)
					.setIcon("file-text")
					.onClick(() => this.openVirtualSource(entry))
			);
		});

		menu.showAtMouseEvent(e);
	}

	private setMode(mode: ViewMode) {
		this.mode = mode;
		this.render();
		if (this.plugin.settings.viewMode !== mode) {
			this.plugin.settings.viewMode = mode;
			void this.plugin.saveSettings();
		}
	}

	private navigate(dir: 1 | -1) {
		if (this.mode === "day") this.anchor = addDays(this.anchor, dir);
		else if (this.mode === "week") this.anchor = addDays(this.anchor, dir * 7);
		else if (this.mode === "month") this.anchor = addMonths(this.anchor, dir);
		else this.anchor = addYears(this.anchor, dir);
		this.render();
	}

	private goToday() {
		this.anchor = new Date();
		this.anchor.setHours(0, 0, 0, 0);
		this.render();
	}

	private render() {
		// Render straight into containerEl (not children[1]) so Obsidian's
		// native per-pane header - back/forward history arrows, the
		// getDisplayText() title, and the "..." more-options menu - never gets
		// drawn in the first place. Same approach Plain Contacts uses; none of
		// that chrome adds value here since this view is a single static
		// destination, not something you navigate through.
		const container = this.containerEl as HTMLElement;
		container.empty();
		container.addClass("plain-calendar-view");

		this.events = this.loadEvents();
		this.seriesIndex = buildSeriesIndex(this.events);
		this.virtualBirthdays = this.loadVirtualBirthdays();
		this.virtualTasks = this.loadVirtualTasks();

		const toolbar = container.createDiv({ cls: "plain-calendar-toolbar" });

		const nav = toolbar.createDiv({ cls: "plain-calendar-nav" });
		const navPill = nav.createDiv({ cls: "plain-calendar-pill" });
		navPill.createEl("button", { text: "‹" }).onclick = () => this.navigate(-1);
		navPill.createEl("button", { text: t("today") }).onclick = () => this.goToday();
		navPill.createEl("button", { text: "›" }).onclick = () => this.navigate(1);
		nav.createEl("span", { cls: "plain-calendar-title", text: this.titleFor() });

		const modes = toolbar.createDiv({ cls: "plain-calendar-pill" });
		(
			[
				["day", t("day")],
				["week", t("week")],
				["month", t("month")],
				["year", t("year")],
			] as [ViewMode, string][]
		).forEach(([m, label]) => {
			const btn = modes.createEl("button", { text: label });
			if (m === this.mode) btn.addClass("is-active");
			btn.onclick = () => this.setMode(m);
		});

		const body = container.createDiv({ cls: "plain-calendar-body" });
		if (this.mode === "day") this.renderDay(body);
		else if (this.mode === "week") this.renderWeek(body);
		else if (this.mode === "month") this.renderMonth(body);
		else this.renderYear(body);
	}

	private titleFor(): string {
		const months = monthNames();
		if (this.mode === "day") {
			return `${shortWeekdayLabel(this.anchor)}, ${this.anchor.getDate()}. ${
				months[this.anchor.getMonth()]
			} ${this.anchor.getFullYear()}`;
		}
		if (this.mode === "week") {
			const start = startOfWeek(this.anchor);
			const end = addDays(start, 6);
			return `${start.getDate()}. ${months[start.getMonth()]} – ${end.getDate()}. ${
				months[end.getMonth()]
			} ${end.getFullYear()}`;
		}
		if (this.mode === "month") {
			return `${months[this.anchor.getMonth()]} ${this.anchor.getFullYear()}`;
		}
		return `${this.anchor.getFullYear()}`;
	}

	private occurrencesFor(d: Date): Occurrence[] {
		return occurrencesOn(this.events, this.seriesIndex, d);
	}

	// Click opens the edit dialog, right-click the context menu - shared by
	// occurrence chips in the month, all-day, and time-grid views alike.
	private wireOccurrenceElement(el: HTMLElement, occ: Occurrence) {
		el.onclick = (e) => {
			e.stopPropagation();
			this.editOccurrence(occ);
		};
		el.oncontextmenu = (e) => this.showEventContextMenu(e, occ);
	}

	// Click creates a new event - unless the day already has several, where
	// jumping straight to the day view is more useful than piling on more
	// chips in an already-crowded cell. Right click (showDayContextMenu)
	// always offers to jump to the day view regardless of occurrence count -
	// a double-click can't do that reliably here, since the "New event"
	// modal that a single click opens immediately covers the cell and
	// swallows the second click before it arrives. Shared by month-view day
	// cells and year-view mini-days.
	private wireDayCellNavigation(cell: HTMLElement, d: Date, occs: Occurrence[], virtualCount = 0) {
		cell.onclick = () => {
			if (occs.length + virtualCount > 1) {
				this.anchor = d;
				this.setMode("day");
			} else {
				this.createEvent(d);
			}
		};
	}

	private renderDayCell(parent: HTMLElement, d: Date, opts: { muted?: boolean } = {}) {
		const cell = parent.createDiv({ cls: "plain-calendar-day" });
		if (opts.muted) cell.addClass("is-muted");
		if (isSameDay(d, new Date())) cell.addClass("is-today");

		const occs = this.occurrencesFor(d);
		const virtual = this.virtualEntriesFor(d);
		this.wireDayCellNavigation(cell, d, occs, virtual.length);
		// Occurrences already have their own edit/delete context menu on
		// their chip (wireOccurrenceElement below), so the cell's own right
		// click only needs to offer jumping to the day view.
		cell.oncontextmenu = (e) => this.showDayContextMenu(e, d, []);

		const head = cell.createDiv({ cls: "plain-calendar-day-head" });
		head.createSpan({ text: String(d.getDate()) });

		const list = cell.createDiv({ cls: "plain-calendar-day-events" });
		for (const occ of occs) {
			const chip = list.createDiv({ cls: "plain-calendar-event" });
			chip.setText(eventLabel(occ.display, { withTime: true, isException: occ.kind === "exception" }));
			this.wireOccurrenceElement(chip, occ);
		}
		for (const entry of virtual) {
			const chip = list.createDiv({ cls: `plain-calendar-event plain-calendar-virtual-event plain-calendar-virtual-${entry.kind}` });
			chip.setText(virtualEntryLabel(entry));
			this.wireVirtualEntryElement(chip, entry);
		}
	}

	private renderMonth(container: HTMLElement) {
		const grid = container.createDiv({ cls: "plain-calendar-grid plain-calendar-grid-month" });
		for (const w of weekdayLabels()) {
			grid.createDiv({ cls: "plain-calendar-weekday", text: w });
		}

		const firstOfMonth = new Date(this.anchor.getFullYear(), this.anchor.getMonth(), 1);
		const gridStart = startOfWeek(firstOfMonth);
		const month = this.anchor.getMonth();

		for (let i = 0; i < 42; i++) {
			const d = addDays(gridStart, i);
			this.renderDayCell(grid, d, { muted: d.getMonth() !== month });
		}
	}

	private renderWeek(container: HTMLElement) {
		const start = startOfWeek(this.anchor);
		const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
		this.renderTimeGrid(container, days);
	}

	private renderDay(container: HTMLElement) {
		this.renderTimeGrid(container, [this.anchor]);
	}

	private renderTimeGrid(container: HTMLElement, days: Date[]) {
		const wrap = container.createDiv({ cls: "plain-calendar-timegrid-wrap" });

		// Header row with weekday + date per column (redundant with the
		// toolbar title in day view, so only shown for more than one day)
		let header: HTMLElement | undefined;
		if (days.length > 1) {
			header = wrap.createDiv({ cls: "plain-calendar-timegrid-header" });
			header.createDiv({ cls: "plain-calendar-timegrid-gutter" });
			for (const d of days) {
				const head = header.createDiv({ cls: "plain-calendar-timegrid-daycol-head" });
				if (isSameDay(d, new Date())) head.addClass("is-today");
				head.setText(`${shortWeekdayLabel(d)} ${d.getDate()}.${d.getMonth() + 1}.`);
			}
		}

		// All-day row
		const allDayRow = wrap.createDiv({ cls: "plain-calendar-timegrid-allday" });
		allDayRow.createDiv({ cls: "plain-calendar-timegrid-gutter", text: t("allDay") });
		for (const d of days) {
			const col = allDayRow.createDiv({ cls: "plain-calendar-timegrid-allday-col" });
			const dayOccurrences = this.occurrencesFor(d).filter((o) => !o.display.time);
			for (const occ of dayOccurrences) {
				const chip = col.createDiv({ cls: "plain-calendar-event" });
				chip.setText(eventLabel(occ.display, { isException: occ.kind === "exception" }));
				this.wireOccurrenceElement(chip, occ);
			}
			// Virtual entries have no time field (birthdays never do; a
			// task's `due` has no time component either), so they always
			// render in the all-day row, never the timed hour grid below.
			for (const entry of this.virtualEntriesFor(d)) {
				const chip = col.createDiv({
					cls: `plain-calendar-event plain-calendar-virtual-event plain-calendar-virtual-${entry.kind}`,
				});
				chip.setText(virtualEntryLabel(entry));
				this.wireVirtualEntryElement(chip, entry);
			}
			col.onclick = () => this.createEvent(d);
		}

		// Scrollable hour grid
		const scroll = wrap.createDiv({ cls: "plain-calendar-timegrid-scroll" });
		const body = scroll.createDiv({ cls: "plain-calendar-timegrid-body" });
		body.style.height = `${GRID_HOURS * HOUR_PX}px`;

		const gutter = body.createDiv({ cls: "plain-calendar-timegrid-gutter plain-calendar-timegrid-gutter-hours" });
		for (let h = 0; h < GRID_HOURS; h++) {
			const label = gutter.createDiv({ cls: "plain-calendar-hour-label" });
			label.style.top = `${h * HOUR_PX + 2}px`;
			label.setText(`${String(h).padStart(2, "0")}:00`);
		}

		const now = new Date();
		for (const d of days) {
			const col = body.createDiv({ cls: "plain-calendar-timegrid-daycol" });
			col.style.backgroundSize = `100% ${HOUR_PX}px`;

			const dayOccurrences = this.occurrencesFor(d).filter((o) => o.display.time);
			for (const item of layoutTimedOccurrences(dayOccurrences)) {
				const widthPct = 100 / item.cols;
				const leftPct = item.col * widthPct;
				const block = col.createDiv({ cls: "plain-calendar-timegrid-event" });
				block.style.top = `${(item.startMin / 60) * HOUR_PX}px`;
				block.style.height = `${((item.endMin - item.startMin) / 60) * HOUR_PX}px`;
				block.style.left = `calc(${leftPct}% + 1px)`;
				block.style.width = `calc(${widthPct}% - 2px)`;
				block.setText(eventLabel(item.occ.display, { withTime: true, isException: item.occ.kind === "exception" }));
				this.wireOccurrenceElement(block, item.occ);
			}

			if (isSameDay(d, now)) {
				const nowMin = now.getHours() * 60 + now.getMinutes();
				const line = col.createDiv({ cls: "plain-calendar-timegrid-now" });
				line.style.top = `${(nowMin / 60) * HOUR_PX}px`;
			}

			col.onclick = (e) => {
				const rect = col.getBoundingClientRect();
				const offsetY = (e as MouseEvent).clientY - rect.top;
				const rawMin = (offsetY / HOUR_PX) * 60;
				const snapped = Math.max(0, Math.round(rawMin / 30) * 30);
				this.createEvent(d, minutesToTimeLabel(snapped));
			};
		}

		// Reserve the scrollbar's width in the header/all-day rows too,
		// otherwise their columns drift out of alignment with the hour grid.
		const scrollbarWidth = scroll.offsetWidth - scroll.clientWidth;
		if (scrollbarWidth > 0) {
			if (header) {
				header.createDiv({ cls: "plain-calendar-timegrid-scrollbar-spacer" }).style.flex = `0 0 ${scrollbarWidth}px`;
			}
			allDayRow.createDiv({ cls: "plain-calendar-timegrid-scrollbar-spacer" }).style.flex = `0 0 ${scrollbarWidth}px`;
		}

		// Scroll to the current time (2h lead-in), but always clamped to a
		// full hour, otherwise the topmost visible hour gets cut off.
		const maxScrollableMin = Math.max(0, body.offsetHeight - scroll.clientHeight);
		const desiredMin = Math.max(0, now.getHours() - 2) * HOUR_PX;
		const clampedMin = Math.min(desiredMin, maxScrollableMin);
		scroll.scrollTop = Math.floor(clampedMin / HOUR_PX) * HOUR_PX;
	}

	private renderYear(container: HTMLElement) {
		const grid = container.createDiv({ cls: "plain-calendar-grid-year" });
		const months = monthNames();
		const weekdays = weekdayLabels();
		for (let m = 0; m < 12; m++) {
			const monthStart = new Date(this.anchor.getFullYear(), m, 1);
			const mini = grid.createDiv({ cls: "plain-calendar-mini-month" });
			const head = mini.createDiv({ cls: "plain-calendar-mini-month-head", text: months[m] });
			head.onclick = () => {
				this.anchor = monthStart;
				this.setMode("month");
			};

			const miniGrid = mini.createDiv({ cls: "plain-calendar-mini-grid" });
			for (const w of weekdays) {
				miniGrid.createDiv({ cls: "plain-calendar-mini-weekday", text: w[0] });
			}
			const gridStart = startOfWeek(monthStart);
			for (let i = 0; i < 42; i++) {
				const d = addDays(gridStart, i);
				const cell = miniGrid.createDiv({ cls: "plain-calendar-mini-day" });
				const belongsToMonth = d.getMonth() === m;
				if (!belongsToMonth) cell.addClass("is-muted");
				if (belongsToMonth && isSameDay(d, new Date())) cell.addClass("is-today");
				const occs = this.occurrencesFor(d);
				const virtual = this.virtualEntriesFor(d);
				if (occs.length > 0) cell.addClass("has-events");
				if (virtual.length > 0) cell.addClass("has-virtual-events");
				cell.setText(String(d.getDate()));

				this.wireDayCellNavigation(cell, d, occs, virtual.length);
				cell.oncontextmenu = (e) => this.showDayContextMenu(e, d, occs, virtual);
			}
		}
	}
}

class CalendarSettingTab extends PluginSettingTab {
	plugin: PlainCalendarPlugin;

	constructor(app: App, plugin: PlainCalendarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("settingsFolderName"))
			.setDesc(t("settingsFolderDesc"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.eventsFolder)
					.onChange(async (value) => {
						this.plugin.settings.eventsFolder = value.trim() || DEFAULT_SETTINGS.eventsFolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settingsTagName"))
			.setDesc(t("settingsTagDesc"))
			.addText((text) =>
				text
					.setValue(this.plugin.settings.eventTag)
					.onChange(async (value) => {
						this.plugin.settings.eventTag = value.trim() || DEFAULT_SETTINGS.eventTag;
						await this.plugin.saveSettings();
					})
			);
	}
}

export default class PlainCalendarPlugin extends Plugin {
	settings: CalendarSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));

		this.addRibbonIcon("calendar", t("openCalendar"), () => this.activateView());

		this.addCommand({
			id: "open-calendar",
			name: t("openCalendar"),
			callback: () => this.activateView(),
		});

		this.addSettingTab(new CalendarSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CALENDAR);
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
