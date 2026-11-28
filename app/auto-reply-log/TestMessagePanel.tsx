'use client';

import { useState } from 'react';

/**
 * "Test a guest message" — type what a guest might write, pick the booking
 * facts, and see exactly what the live pipeline would produce: category,
 * language, urgency, the Czech AI draft, the translated text the guest would
 * get, and whether it would auto-send or wait for review. Nothing is sent.
 * Backed by POST /api/auto-reply-log/test.
 */

const ROOMS = ['K.102', 'K.103', 'K.106', 'K.201', 'K.202', 'K.203', 'O.308'];

interface TestResult {
  detection: { category: string; confidence: number; language: string };
  urgency: { urgent: boolean; labels: string[] };
  contact: {
    extracted: { phone: string | null; car: string | null; plate: string | null; onlyContactInfo: boolean; parkingRequest: boolean };
    thankYou: string | null;
  } | null;
  draftCs?: string;
  translated?: string | null;
  translateError?: string | null;
  model?: string;
  outcome: 'auto-send' | 'review' | 'skip' | 'contact-thanks';
  outcomeText: string;
}

const OUTCOME_CLASS: Record<TestResult['outcome'], string> = {
  'auto-send': 'bg-emerald-50 border-emerald-200 text-emerald-800',
  review: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  skip: 'bg-gray-50 border-gray-200 text-gray-700',
  'contact-thanks': 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

export default function TestMessagePanel() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [firstName, setFirstName] = useState('Jan');
  const [nationality, setNationality] = useState('CZ');
  const [room, setRoom] = useState('K.106');
  const [parkingSpace, setParkingSpace] = useState('17');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [earlyCheckIn, setEarlyCheckIn] = useState(false);
  const [lateCheckout, setLateCheckout] = useState(false);
  const [contactAsked, setContactAsked] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/auto-reply-log/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message, firstName, nationality, room, parkingSpace,
          checkIn, checkOut, earlyCheckIn, lateCheckout, contactAsked,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setResult(json as TestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const input = 'rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none';
  const label = 'text-xs text-gray-600 flex flex-col gap-1';

  return (
    <section className="mb-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-semibold text-gray-700 uppercase tracking-wide flex items-center gap-2"
      >
        <span className="text-gray-400">{open ? '▾' : '▸'}</span> Test a guest message
      </button>
      {open && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-500 mb-3 max-w-3xl">
            Write a message as a guest would. It runs through the live pipeline (category, urgency,
            knowledge base, translation) against the booking below. <b>Nothing is sent or saved.</b>
          </p>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="e.g. Hi, we arrive at 11 — can we park the car before check-in?"
            className={`${input} w-full mb-3`}
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-3">
            <label className={label}>First name
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={input} />
            </label>
            <label className={label}>Country (2 letters)
              <input value={nationality} onChange={(e) => setNationality(e.target.value.toUpperCase().slice(0, 2))} className={input} />
            </label>
            <label className={label}>Apartment
              <select value={room} onChange={(e) => setRoom(e.target.value)} className={input}>
                {ROOMS.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label className={label}>Parking space
              <input value={parkingSpace} onChange={(e) => setParkingSpace(e.target.value)} placeholder="blank = unknown" className={input} />
            </label>
            <label className={label}>Check-in
              <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className={input} />
            </label>
            <label className={label}>Check-out
              <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className={input} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4 mb-4 text-xs text-gray-700">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={earlyCheckIn} onChange={(e) => setEarlyCheckIn(e.target.checked)} />
              Rate includes early check-in
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={lateCheckout} onChange={(e) => setLateCheckout(e.target.checked)} />
              Rate includes late checkout
            </label>
            <label className="flex items-center gap-1.5" title="Our post-booking 'phone + coming by car?' question was already sent">
              <input type="checkbox" checked={contactAsked} onChange={(e) => setContactAsked(e.target.checked)} />
              Phone/car question already asked
            </label>
            <button
              onClick={run}
              disabled={running || !message.trim()}
              className="ml-auto px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-50"
            >
              {running ? 'Running… (~10 s)' : 'Run test'}
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          {result && (
            <div className="space-y-3">
              <div className={`rounded-md border p-3 text-sm ${OUTCOME_CLASS[result.outcome]}`}>
                {result.outcomeText}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
                <span>Category: <b className="font-mono">{result.detection.category}</b> ({Math.round(result.detection.confidence * 100)}%)</span>
                <span>Language: <b className="font-mono">{result.detection.language || '?'}</b></span>
                <span>Urgent: <b>{result.urgency.urgent ? `yes — ${result.urgency.labels.join(', ')}` : 'no'}</b></span>
                {result.contact && (
                  <span>
                    Contact capture: <span className="font-mono">{JSON.stringify(result.contact.extracted)}</span>
                  </span>
                )}
              </div>

              {result.contact?.thankYou && (
                <Reply title="Automatic thank-you (what the guest gets)" text={result.contact.thankYou} />
              )}
              {result.translated && <Reply title={`What the guest gets (${result.detection.language})`} text={result.translated} />}
              {result.translateError && (
                <div className="text-xs text-red-700">Translation failed: {result.translateError} — production would queue it for review.</div>
              )}
              {result.draftCs !== undefined && (
                <Reply
                  title={result.translated ? 'Czech draft (what you review)' : 'Draft (what the guest gets)'}
                  text={result.draftCs || '(no reply — SKIP)'}
                  muted={!!result.translated}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Reply({ title, text, muted }: { title: string; text: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 mb-1">{title}</div>
      <pre className={`whitespace-pre-wrap break-words rounded-md border border-gray-200 p-3 text-sm font-sans ${muted ? 'bg-gray-50 text-gray-600' : 'bg-white text-gray-900'}`}>
        {text}
      </pre>
    </div>
  );
}
