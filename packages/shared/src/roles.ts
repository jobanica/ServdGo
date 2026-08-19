/**
 * Staff roles and what each can access in the admin console.
 *
 * RLS enforces two hard tiers (see 0011_staff_rls.sql): admin (everything,
 * incl. settings + staff management) and staff (operational tables). This map
 * is the finer-grained UX layer that shows/hides admin sections per role.
 */

export type StaffRole = 'admin' | 'manager' | 'dispatcher' | 'support';

export type AdminSection =
  | 'dashboard' | 'analytics' | 'stores' | 'ridersActive' | 'riders'
  | 'orders' | 'history' | 'settlements' | 'broadcast' | 'areas' | 'users' | 'settings' | 'staff';

export const STAFF_ROLES: StaffRole[] = ['admin', 'manager', 'dispatcher', 'support'];

export const ROLE_LABEL: Record<StaffRole, string> = {
  admin: 'Admin', manager: 'Manager', dispatcher: 'Dispatcher', support: 'Support',
};

const ALL: AdminSection[] = [
  'dashboard', 'analytics', 'stores', 'ridersActive', 'riders',
  'orders', 'history', 'settlements', 'broadcast', 'areas', 'users', 'settings', 'staff',
];

/** Sections each role may open. Settings + staff are admin-only. */
const ACCESS: Record<StaffRole, AdminSection[]> = {
  admin: ALL,
  manager: ['dashboard', 'analytics', 'stores', 'ridersActive', 'riders', 'orders', 'history', 'settlements', 'broadcast', 'areas', 'users'],
  dispatcher: ['dashboard', 'ridersActive', 'riders', 'orders', 'history'],
  support: ['dashboard', 'orders', 'history', 'broadcast'],
};

/** True when a role may open a section. */
export function can(role: StaffRole, section: AdminSection): boolean {
  return ACCESS[role]?.includes(section) ?? false;
}

/** Sections a role may open, in canonical order. */
export function sectionsFor(role: StaffRole): AdminSection[] {
  return ALL.filter((s) => can(role, s));
}

export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return role === 'admin' || role === 'manager' || role === 'dispatcher' || role === 'support';
}
