/**
 * Console roles and what each can access in the admin console.
 *
 * RLS enforces the hard tiers: the franchisor (across cities), admin — the city
 * operator — (their own city entirely, incl. settings and staff), and staff
 * (their city's operational tables). This map is the finer-grained UX layer that
 * shows and hides sections per role.
 *
 * The franchisor is not staff of any city and deliberately gets none of the
 * operational sections: they do not run a city, they own the network.
 */

export type StaffRole = 'admin' | 'manager' | 'dispatcher' | 'support';

/** Every role that may open the console, including the one above the operators. */
export type ConsoleRole = StaffRole | 'franchisor';

export type AdminSection =
  | 'dashboard' | 'analytics' | 'stores' | 'ridersActive' | 'riders'
  | 'orders' | 'history' | 'settlements' | 'royalty' | 'merchants' | 'broadcast'
  | 'areas' | 'users' | 'settings' | 'staff' | 'territories' | 'invoices' | 'scorecard' | 'hqAlerts';

export const STAFF_ROLES: StaffRole[] = ['admin', 'manager', 'dispatcher', 'support'];

/** STAFF_ROLES is what an operator may hand out. Franchisor is not on it: only
 *  the franchisor grants that, and the database refuses anyone else. */
export const ROLE_LABEL: Record<ConsoleRole, string> = {
  admin: 'Operator', manager: 'Manager', dispatcher: 'Dispatcher',
  support: 'Support', franchisor: 'Franchisor',
};

const ALL: AdminSection[] = [
  'dashboard', 'analytics', 'stores', 'ridersActive', 'riders',
  'orders', 'history', 'settlements', 'royalty', 'merchants', 'broadcast', 'areas',
  'users', 'settings', 'staff', 'territories', 'invoices', 'scorecard', 'hqAlerts',
];

/** Sections each role may open. Settings, staff and the royalty owed are the
 *  operator's; territories are the franchisor's. */
const ACCESS: Record<ConsoleRole, AdminSection[]> = {
  admin: ALL.filter((s) => s !== 'territories'),
  manager: ['dashboard', 'analytics', 'stores', 'ridersActive', 'riders', 'orders', 'history', 'settlements', 'merchants', 'broadcast', 'areas', 'users'],
  dispatcher: ['dashboard', 'ridersActive', 'riders', 'orders', 'history'],
  support: ['dashboard', 'orders', 'history', 'broadcast'],
  franchisor: ['territories', 'invoices', 'scorecard', 'hqAlerts'],
};

/** True when a role may open a section. */
export function can(role: ConsoleRole, section: AdminSection): boolean {
  return ACCESS[role]?.includes(section) ?? false;
}

/** Sections a role may open, in canonical order. */
export function sectionsFor(role: ConsoleRole): AdminSection[] {
  return ALL.filter((s) => can(role, s));
}

export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return role === 'admin' || role === 'manager' || role === 'dispatcher' || role === 'support';
}

/** True when a role may open the console at all. */
export function isConsoleRole(role: string | null | undefined): role is ConsoleRole {
  return isStaffRole(role) || role === 'franchisor';
}
