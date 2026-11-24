'use client';

import { useCallback, useEffect, useState } from 'react';
import { AREA_LABELS, PERMISSIONS, ROLE_LABELS, ROLES, type Area, type Role } from '@/utils/roles';

interface AppUser {
  email: string;
  role: string;
  note: string | null;
  updatedAt: string;
  updatedBy: string;
}

interface Change {
  id: number;
  email: string;
  oldRole: string | null;
  newRole: string | null;
  changedBy: string;
  changedAt: string;
}

interface UsersResponse {
  users: AppUser[];
  changes: Change[];
  envAdmins: string[];
  me: string;
}

function roleLabel(role: string | null): string {
  if (!role) return '—';
  return ROLE_LABELS[role as Role] ?? role;
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function accessFor(area: Area, role: Role): string {
  if (PERMISSIONS[area].change.includes(role)) return 'Change';
  if (PERMISSIONS[area].view.includes(role)) return 'View';
  return '—';
}

export default function UsersAdmin() {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/users', { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? `HTTP ${res.status}`);
      return;
    }
    setError(null);
    setData(json as UsersResponse);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: { email: string; role: Role; note?: string | null }) {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      await load();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    if (!window.confirm(`Remove ${target}? They lose access within a minute.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users?email=${encodeURIComponent(target)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `HTTP ${res.status}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (await save({ email, role, note })) {
      setEmail('');
      setNote('');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-1">
            Who can sign in, and with which role. Changes take effect within a minute; a removed user is signed out.
          </p>
        </header>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Add a user</h2>
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-gray-600 gap-1 grow min-w-[14rem]">
              Google account email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
                placeholder="name@gmail.com"
              />
            </label>
            <label className="flex flex-col text-xs text-gray-600 gap-1">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-gray-600 gap-1 grow min-w-[10rem]">
              Note (optional)
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
                placeholder="e.g. cleaning lead"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Note</th>
                <th className="px-4 py-2">Last change</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.envAdmins.map((e) => (
                <tr key={`env-${e}`} className="bg-indigo-50/40">
                  <td className="px-4 py-2 font-mono text-gray-900">{e}</td>
                  <td className="px-4 py-2 text-gray-900">Admin</td>
                  <td className="px-4 py-2 text-gray-500" colSpan={3}>
                    Set in Vercel (ADMIN_EMAILS) — always admin, can&apos;t be changed here
                  </td>
                </tr>
              ))}
              {data?.users.map((u) => (
                <tr key={u.email}>
                  <td className="px-4 py-2 font-mono text-gray-900">{u.email}</td>
                  <td className="px-4 py-2">
                    <select
                      value={u.role}
                      disabled={busy || u.email === data.me}
                      onChange={(e) => void save({ email: u.email, role: e.target.value as Role, note: u.note })}
                      className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{u.note ?? ''}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {formatTs(u.updatedAt)} · {u.updatedBy}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {u.email !== data.me && (
                      <button
                        onClick={() => void remove(u.email)}
                        disabled={busy}
                        className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {data && data.users.length === 0 && (
                <tr>
                  <td className="px-4 py-3 text-gray-500" colSpan={5}>
                    No users yet — add them above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
          <h2 className="text-sm font-semibold text-gray-900 px-4 pt-4">What each role can do</h2>
          <p className="text-xs text-gray-500 px-4 pb-3">Set in the code (utils/roles.ts); ask to change it.</p>
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2">Area</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-4 py-2">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(Object.keys(PERMISSIONS) as Area[]).map((area) => (
                <tr key={area}>
                  <td className="px-4 py-2 text-gray-900">{AREA_LABELS[area]}</td>
                  {ROLES.map((r) => {
                    const a = accessFor(area, r);
                    return (
                      <td
                        key={r}
                        className={`px-4 py-2 ${a === 'Change' ? 'text-emerald-700 font-medium' : a === 'View' ? 'text-sky-700' : 'text-gray-300'}`}
                      >
                        {a}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
          <h2 className="text-sm font-semibold text-gray-900 px-4 py-3">Change history</h2>
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {data?.changes.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{formatTs(c.changedAt)}</td>
                  <td className="px-4 py-2 font-mono text-gray-900">{c.email}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {c.oldRole === null ? 'added as ' : c.newRole === null ? 'removed (was ' : ''}
                    {c.oldRole === null
                      ? roleLabel(c.newRole)
                      : c.newRole === null
                        ? `${roleLabel(c.oldRole)})`
                        : `${roleLabel(c.oldRole)} → ${roleLabel(c.newRole)}`}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">by {c.changedBy}</td>
                </tr>
              ))}
              {data && data.changes.length === 0 && (
                <tr>
                  <td className="px-4 py-3 text-gray-500">No changes yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
