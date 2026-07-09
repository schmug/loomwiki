// SPDX-License-Identifier: Apache-2.0

// Typed client for /api/calendar, /api/events, and the workspace members
// list (v0.1 M9).

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import type {
  CalendarResponse,
  CreateEventRequest,
  EventWithAttendees,
  MemberSummary,
  PatchEventRequest,
} from "@loomwiki/schema";

export interface EventPayload {
  event: EventWithAttendees;
}

export interface MembersPayload {
  members: MemberSummary[];
}

export function getCalendar(
  from: number,
  to: number,
  opts: { room?: string; user?: string } = {},
): Promise<CalendarResponse> {
  const p = new URLSearchParams({ from: String(from), to: String(to) });
  if (opts.room !== undefined) p.set("room", opts.room);
  if (opts.user !== undefined) p.set("user", opts.user);
  return apiGet(`/api/calendar?${p.toString()}`);
}

export function createEvent(body: CreateEventRequest): Promise<EventPayload> {
  return apiPost("/api/events", body);
}

export function patchEvent(eventId: string, body: PatchEventRequest): Promise<EventPayload> {
  return apiPatch(`/api/events/${eventId}`, body);
}

/** DELETE /api/events/:id is a soft-cancel (sets cancelled_at). */
export function cancelEvent(eventId: string): Promise<EventPayload> {
  return apiDelete(`/api/events/${eventId}`);
}

export function addAttendee(eventId: string, userId: string): Promise<EventPayload> {
  return apiPost(`/api/events/${eventId}/attendees/${userId}`);
}

export function removeAttendee(eventId: string, userId: string): Promise<EventPayload> {
  return apiDelete(`/api/events/${eventId}/attendees/${userId}`);
}

export function listMembers(workspaceId: string): Promise<MembersPayload> {
  return apiGet(`/api/workspaces/${workspaceId}/members`);
}
