// Kairos — calendar & time
// Owns ONLY these tools (this is what enforces no-overlap):
//   calendar.read | conflict-scan | time-block | prep-notes
// CAN:  aggregate events across accounts, detect conflicts, suggest time blocks
// CANNOT: create/move events without approval; send email; touch email/finance/memory

import {
  fetchCalendarEvents,
  getUpcomingEvents,
  detectConflicts,
  type CalendarEvent,
} from "@/lib/calendar";

export const kairos = {
  name: "Kairos",
  domain: "calendar & time",
  tools: ["calendar.read", "conflict-scan", "time-block", "prep-notes"] as const,
};

// ── calendar.read ─────────────────────────────────────────────────────────────

export async function calendarRead(
  userId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  return fetchCalendarEvents(userId, timeMin, timeMax);
}

// ── conflict-scan ─────────────────────────────────────────────────────────────

export interface ConflictScanResult {
  conflicts: CalendarEvent[][];
  totalEvents: number;
  conflictCount: number;
}

export async function conflictScan(
  userId: string,
  days = 7
): Promise<ConflictScanResult> {
  const events = await getUpcomingEvents(userId, days);
  const conflicts = detectConflicts(events);
  return { conflicts, totalEvents: events.length, conflictCount: conflicts.length };
}

// ── time-block ────────────────────────────────────────────────────────────────
// Returns suggested 30-min or 60-min open slots on a given day.

export interface TimeBlock {
  start: Date;
  end: Date;
  durationMinutes: number;
}

export async function timeBlock(
  userId: string,
  date: Date,
  durationMinutes = 60
): Promise<TimeBlock[]> {
  const dayStart = new Date(date);
  dayStart.setHours(8, 0, 0, 0); // work day 08:00
  const dayEnd = new Date(date);
  dayEnd.setHours(18, 0, 0, 0); // work day 18:00

  const events = await fetchCalendarEvents(userId, dayStart, dayEnd);
  const busySlots = events
    .filter((e) => !e.allDay)
    .map((e) => ({ s: new Date(e.start).getTime(), e: new Date(e.end).getTime() }));

  const slots: TimeBlock[] = [];
  const step = durationMinutes * 60_000;
  let cursor = dayStart.getTime();

  while (cursor + step <= dayEnd.getTime()) {
    const slotEnd = cursor + step;
    const free = busySlots.every((b) => slotEnd <= b.s || cursor >= b.e);
    if (free) {
      slots.push({
        start: new Date(cursor),
        end: new Date(slotEnd),
        durationMinutes,
      });
    }
    cursor += 30 * 60_000; // advance by 30-min increments
  }

  return slots;
}

// ── prep-notes ────────────────────────────────────────────────────────────────
// Returns today's events with titles suitable for a morning prep summary.
// Argus uses this output to build the daily brief — Kairos just fetches.

export async function prepNotes(userId: string, days = 1): Promise<CalendarEvent[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endWindow = new Date(startOfDay);
  endWindow.setDate(startOfDay.getDate() + days);
  endWindow.setHours(23, 59, 59, 999);
  return fetchCalendarEvents(userId, startOfDay, endWindow);
}
