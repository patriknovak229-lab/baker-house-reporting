'use client';
import { useState } from 'react';
import FloatingPanel from '@/components/shared/FloatingPanel';
import { pragueToday } from '@/utils/periodUtils';
import { TEAM_ALL, TEAM_TEXT_MAX, normalizeEmail, type TeamUser } from '@/utils/teamItems';

// The two operator-to-operator forms behind the "Create Notification" and
// "General Task" pills. Both address one operator or everyone; the server
// stamps the author from the session.

const inputCls =
  'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2';

/** "All users" + one chip per operator. The team is small enough for chips. */
function UserPicker({
  users,
  me,
  value,
  onChange,
  accent,
}: {
  users: TeamUser[];
  me: string;
  value: string;
  onChange: (v: string) => void;
  accent: 'blue' | 'orange';
}) {
  const on = accent === 'blue' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-orange-500 border-orange-500 text-white';
  const off =
    accent === 'blue'
      ? 'bg-white border-gray-200 text-gray-700 hover:border-blue-300 hover:bg-blue-50'
      : 'bg-white border-gray-200 text-gray-700 hover:border-orange-300 hover:bg-orange-50';
  const options = [
    { value: TEAM_ALL, label: 'All users' },
    ...users.map((u) => ({
      value: u.email,
      label: normalizeEmail(u.email) === normalizeEmail(me) ? `${u.name} (me)` : u.name,
      title: u.email,
    })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={'title' in o ? o.title : 'Everyone with access to Transactions'}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${value === o.value ? on : off}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
  ring,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ring: string;
}) {
  return (
    <>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        maxLength={TEAM_TEXT_MAX}
        placeholder={placeholder}
        className={`${inputCls} ${ring} resize-y`}
      />
      {value.length > TEAM_TEXT_MAX * 0.8 && (
        <p className="text-[10px] text-gray-400 mt-1 text-right">
          {value.length}/{TEAM_TEXT_MAX}
        </p>
      )}
    </>
  );
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
}

const bellIcon = (
  <svg className="w-5 h-5 text-blue-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);

const taskIcon = (
  <svg className="w-5 h-5 text-orange-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

export function CreateNotificationModal({
  users,
  me,
  onClose,
  onCreated,
}: {
  users: TeamUser[];
  me: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [recipient, setRecipient] = useState<string>(TEAM_ALL);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const recipientLabel =
    recipient === TEAM_ALL ? 'everyone' : users.find((u) => u.email === recipient)?.name ?? recipient;

  async function handleSubmit() {
    if (!text.trim()) {
      setError('Write the message first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await post('/api/team/notifications', { recipient, text });
      setSentTo(recipientLabel);
      setText('');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send notification');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FloatingPanel
      id="team-notification"
      title="Create Notification"
      subtitle="Let a colleague (or yourself) know about something. It shows in their Notifications banner until they mark it read."
      icon={bellIcon}
      headerClassName="bg-blue-50"
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">For *</label>
          <UserPicker users={users} me={me} value={recipient} onChange={setRecipient} accent="blue" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Message *</label>
          <TextField
            value={text}
            onChange={(v) => { setText(v); setSentTo(null); }}
            placeholder="e.g. Guests in K.201 and K.202 informed about the fire alarm drill on Thursday 10:00."
            ring="focus:ring-blue-300"
          />
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
        {sentTo && !error && (
          <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            Sent to {sentTo}.
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            {sentTo ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !text.trim()}
            className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {submitting ? 'Sending…' : `Send to ${recipientLabel}`}
          </button>
        </div>
      </div>
    </FloatingPanel>
  );
}

export function GeneralTaskModal({
  users,
  me,
  onClose,
  onCreated,
}: {
  users: TeamUser[];
  me: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [assignee, setAssignee] = useState<string>(TEAM_ALL);
  const [text, setText] = useState('');
  const [dueDate, setDueDate] = useState(pragueToday);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const assigneeLabel =
    assignee === TEAM_ALL ? 'everyone' : users.find((u) => u.email === assignee)?.name ?? assignee;

  async function handleSubmit() {
    if (!text.trim()) {
      setError('Describe the task first.');
      return;
    }
    if (!dueDate) {
      setError('Pick the date the task is due.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await post('/api/team/tasks', { assignee, text, dueDate });
      setSaved(true);
      setText('');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FloatingPanel
      id="general-task"
      title="General Task"
      subtitle="A to-do that isn't tied to a reservation. It joins Pending tasks from 7 days before it's due."
      icon={taskIcon}
      headerClassName="bg-orange-50"
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">For *</label>
          <UserPicker users={users} me={me} value={assignee} onChange={setAssignee} accent="orange" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Due *</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => { setDueDate(e.target.value); setSaved(false); }}
            className={`${inputCls} focus:ring-orange-300`}
          />
          <p className="text-[10px] text-gray-400 mt-1">
            Once the date has passed and it isn&apos;t done, it turns red and a Telegram goes to the operations group.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Task *</label>
          <TextField
            value={text}
            onChange={(v) => { setText(v); setSaved(false); }}
            placeholder="e.g. Renew the parking permit for Karlův Dům."
            ring="focus:ring-orange-300"
          />
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
        {saved && !error && (
          <p className="text-xs text-orange-800 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
            Task created.
          </p>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 py-2.5 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            {saved ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !text.trim() || !dueDate}
            className="flex-1 py-2.5 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-40 transition-colors"
          >
            {submitting ? 'Saving…' : `Create task for ${assigneeLabel}`}
          </button>
        </div>
      </div>
    </FloatingPanel>
  );
}
