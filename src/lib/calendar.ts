import { prisma } from "./db";
import { getValidToken } from "./tokens";

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

/** Fetches and merges calendar events across all linked accounts for a user. */
export async function fetchCalendarEvents(
  userId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
      });

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) {
        throw new Error(`Calendar API ${res.status} for ${account.email}`);
      }

      const data = (await res.json()) as { items?: GCalEvent[] };
      return (data.items ?? []).map<CalendarEvent>((item) => {
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
      });
    })
  );

  const allEvents: CalendarEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") allEvents.push(...r.value);
    // Fulfilled accounts contribute; rejected ones (bad token, network) are silently skipped.
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
