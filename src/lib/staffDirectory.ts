import { supabase } from './supabase'

/**
 * Staff directory (migration 0041): id + display name for every user
 * holding a non-agent role. Backed by the staff_directory() RPC because
 * profiles RLS lets only owner/manager (or the user themselves) read
 * profile rows — staff and agents resolving a receiver's name, and
 * staff filling the "လက်ခံသူ" form select, would otherwise see nobody.
 * The RPC returns active and inactive people alike: forms offer only
 * the active ones, while name lookups for historical rows still
 * resolve a since-deactivated receiver.
 */
export interface StaffPerson {
  id: string
  name: string
  active: boolean
}

export interface StaffDirectory {
  /** Everyone, active first — for name lookups. */
  all: StaffPerson[]
  /** Active only — for form selects. */
  active: StaffPerson[]
  /** id -> display name (display_name when set, else username). */
  nameOf: Map<string, string>
}

const EMPTY: StaffDirectory = { all: [], active: [], nameOf: new Map() }

export async function fetchStaffDirectory(): Promise<StaffDirectory> {
  const { data, error } = await supabase.rpc('staff_directory')
  if (error || !data) return EMPTY
  const all = (data as { id: string; name: string; active: boolean }[]).map((r) => ({
    id: r.id,
    name: r.name,
    active: r.active,
  }))
  return {
    all,
    active: all.filter((p) => p.active),
    nameOf: new Map(all.map((p) => [p.id, p.name] as const)),
  }
}

/**
 * The accountable receiver of a cash row: received_by when recorded,
 * else the typist (the pre-0041 meaning of the row). Mirrors the
 * coalesce(received_by, created_by) derivation used by the
 * notification triggers and the cash-handover expectation.
 */
export function receiverId(row: {
  received_by?: string | null
  created_by: string | null
}): string | null {
  return row.received_by ?? row.created_by
}

export function receiverName(
  dir: StaffDirectory,
  row: { received_by?: string | null; created_by: string | null },
): string | null {
  const id = receiverId(row)
  return id ? (dir.nameOf.get(id) ?? null) : null
}
