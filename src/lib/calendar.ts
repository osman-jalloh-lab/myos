import { prisma } from "./db";
import { getValidToken } from "./tokens";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
  accountEmail: string;
  accountLabel: string;
  htmlLink?: string;
}

interface GCalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

interface GCalCalendar {
  id: string;
  summary?: string;
  accessRole?: string;
}

export interface CreateCalendarEventInput {
  summary: string;
  start: Date;
  end: Date;
  timeZone?: string;
  description?: string;
  location?: string;
  /** Stable source id used to make automated creates safe to retry. */
  sourceMessageId: string;
  sourceThreadId?: string;
  sourceType?: string;
}

export interface CreateCalendarEventResult {
  created: boolean;
  event: CalendarEvent;
}

// Calendars to skip — noise that adds no value to the daily brief.
const SKIP_CALENDAR_PATTERNS = [
  /holiday/i,
  /birthday/i,
  /contacts/i,
  /^en\./i,
];

function shouldSkipCalendar(cal: GCalCalendar): boolean {
  return SKIP_CALENDAR_PATTERNS.some((p) => p.test(cal.summary ?? "") || p.test(cal.id));
}

function eventFromGoogle(item: GCalEvent, account: { email: string; label: string }): CalendarEvent {
  const startRaw = item.start?.dateTime ?? item.start?.date ?? "";
  const endRaw = item.end?.dateTime ?? item.end?.date ?? "";
  return {
    id: item.id,
    summary: item.summary ?? "(no title)",
    start: startRaw,
    end: endRaw,
    allDay: !item.start?.dateTime,
    description: item.description,
    location: item.location,
    htmlLink: item.htmlLink,
    accountEmail: account.email,
    accountLabel: account.label,
  };
}

/** Lists all calendars on a Google account (shared + owned). */
async function listCalendars(token: string): Promise<GCalCalendar[]> {
  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/users/me/calendarList?maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [{ id: "primary" }]; // fallback to primary if list fails
  const data = (await res.json()) as { items?: GCalCalendar[] };
  return (data.items ?? []).filter((c) => !shouldSkipCalendar(c));
}

async function getPreferredCalendarAccount(userId: string): Promise<{ id: string; email: string; label: string }> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, email: true, label: true },
  });

  if (accounts.length === 0) {
    throw new Error("No connected Google account is available for Calendar.");
  }

  return accounts[0];
}

/**
 * Finds a previously-created Hermes event by the Gmail message that produced it.
 * Google Calendar stores this in private extended properties, so retries remain
 * idempotent even if the app restarted before it could write an AgentRun log.
 */
async function findAutomatedEventBySource(
  token: string,
  account: { email: string; label: string },
  sourceMessageId: string
): Promise<CalendarEvent | null> {
  const params = new URLSearchParams({
    maxResults: "1",
    singleEvents: "true",
    privateExtendedProperty: `hermesSourceMessageId=${sourceMessageId}`,
  });
  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return null;
  const data = (await res.json()) as { items?: GCalEvent[] };
  const item = data.items?.[0];
  return item ? eventFromGoogle(item, account) : null;
}

/**
 * Creates an event on the preferred primary calendar, or returns the previously
 * created event for the same email. Callers must provide a stable source message
 * id; this prevents duplicate events when a watcher retries a delivery.
 */
export async function createCalendarEventOnce(
  userId: string,
  input: CreateCalendarEventInput
): Promise<CreateCalendarEventResult> {
  const account = await getPreferredCalendarAccount(userId);
  const token = await getValidToken(account.id);
  const existing = await findAutomatedEventBySource(token, account, input.sourceMessageId);
  if (existing) return { created: false, event: existing };

  const timeZone = input.timeZone ?? "America/Chicago";
  const body = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { dateTime: input.start.toISOString(), timeZone },
    end: { dateTime: input.end.toISOString(), timeZone },
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        hermesSourceMessageId: input.sourceMessageId,
        ...(input.sourceThreadId ? { hermesSourceThreadId: input.sourceThreadId } : {}),
        hermesSourceType: input.sourceType ?? "automation",
      },
    },
  };

  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/primary/events?sendUpdates=none`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Google Calendar event create failed (${res.status}): ${detail}`);
  }

  const event = eventFromGoogle((await res.json()) as GCalEvent, account);
  return { created: true, event };
}

/** Fetches and merges calendar events across all linked accounts for a user.
 *  For each account, queries ALL calendars (owned + shared to that account),
 *  so sharing other Google calendars to your primary account is enough — no
 *  separate OAuth needed for each additional Google account.
 */
export async function fetchCalendarEvents(
  userId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  const seenEventIds = new Set<string>(); // deduplicate events shared across accounts
  const allEvents: CalendarEvent[] = [];

  const accountResults = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const calendars = await listCalendars(token);

      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
      });

      const calResults = await Promise.allSettled(
        calendars.map(async (cal) => {
          const res = await fetch(
            `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) return [];
          const data = (await res.json()) as { items?: GCalEvent[] };
          return (data.items ?? []).map((item) =>
            eventFromGoogle(item, { email: account.email, label: cal.summary ?? account.label })
          );
        })
      );

      return calResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    })
  );

  for (const r of accountResults) {
    if (r.status !== "fulfilled") continue;
    for (const event of r.value) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      allEvents.push(event);
    }
  }

  return allEvents.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
}

/** Returns the next N upcoming events across all linked accounts. */
export async function getUpcomingEvents(
  userId: string,
  days = 7,
  maxResults = 20
): Promise<CalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + days * 86_400_000);
  const events = await fetchCalendarEvents(userId, now, end);
  return events.slice(0, maxResults);
}

/** Returns events that overlap (conflict) within the same account or across accounts. */
export function detectConflicts(events: CalendarEvent[]): CalendarEvent[][] {
  const timed = events.filter((e) => !e.allDay);
  const conflicts: CalendarEvent[][] = [];

  for (let i = 0; i < timed.length; i++) {
    const aStart = new Date(timed[i].start).getTime();
    const aEnd = new Date(timed[i].end).getTime();
    const group: CalendarEvent[] = [timed[i]];

    for (let j = i + 1; j < timed.length; j++) {
      const bStart = new Date(timed[j].start).getTime();
      const bEnd = new Date(timed[j].end).getTime();
      if (bStart < aEnd && bEnd > aStart) {
        group.push(timed[j]);
      }
    }

    if (group.length > 1) conflicts.push(group);
  }

  return conflicts;
}
