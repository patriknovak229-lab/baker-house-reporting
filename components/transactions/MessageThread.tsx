'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { ThreadMessage } from '@/app/api/messages/route';

const ACTIVE_WINDOW_MS = 120 * 60 * 1000; // 120 minutes
const POLL_INTERVAL_MS = 30_000;

interface MessageThreadProps {
  beds24Id: number;       // raw Beds24 booking ID (not "BH-" prefixed)
  hasUnread: boolean;     // driven by the table-level unread poll
  guestName: string;
  /** Physical room (e.g. "K.201"), used by templates to inject the
   *  correct parking-space number into the parking template. */
  room?: string;
  /** Guest first name — used by templates for personalised greetings. */
  guestFirstName?: string;
}

// Parking spaces per physical room — kept in sync with utils/parkingUtils.ts.
// Used by the parking template in the templates dropdown.
const ROOM_PARKING_SPACE: Record<string, string> = {
  'K.201': '153',
  'K.202': '167',
  'K.203': '160',
};

interface Template {
  id: string;
  label: string;
  /** Two-language template — operator picks which to insert. */
  textCs: string;
  textEn: string;
}

function buildTemplates(args: { room?: string; guestFirstName?: string }): Template[] {
  const greeting = (lang: 'cs' | 'en') => {
    if (!args.guestFirstName) return lang === 'cs' ? 'Dobrý den,' : 'Hello,';
    return lang === 'cs'
      ? `Dobrý den ${args.guestFirstName},`
      : `Hi ${args.guestFirstName},`;
  };

  // Look up parking — fall back to a placeholder if the room is unknown
  // or combined ("K.202 + K.203"). For combined we just say "underground level 2".
  const parkingSpace = args.room ? ROOM_PARKING_SPACE[args.room] : null;

  const templates: Template[] = [
    {
      id: 'invoice-details',
      label: 'Ask for invoice details',
      textCs: [
        greeting('cs'),
        '',
        'Děkujeme za Vaši rezervaci! Pro vystavení faktury potřebujeme od Vás následující údaje (Booking.com nám bohužel přeposílá pouze svou interní e-mailovou adresu):',
        '',
        '1. Váš skutečný e-mail (na který Vám fakturu zašleme)',
        '2. Název společnosti (pokud chcete fakturu na firmu)',
        '3. IČO a DIČ společnosti',
        '4. Adresa společnosti',
        '',
        'Pokud chcete fakturu pouze na fyzickou osobu, postačí e-mail a Vaše jméno.',
        '',
        'Děkujeme!',
        'Patrik & Zuzana',
      ].join('\n'),
      textEn: [
        greeting('en'),
        '',
        'Thank you for your reservation! To issue your invoice, we need the following information (Booking.com only forwards their internal proxy email, so we can\'t reach you directly):',
        '',
        '1. Your real email address (where we\'ll send the invoice)',
        '2. Company name (if invoicing to a company)',
        '3. Company ID (IČO) and VAT number (DIČ)',
        '4. Company address',
        '',
        'If you\'d like the invoice issued to you as an individual, just your email and full name will do.',
        '',
        'Thank you!',
        'Patrik & Zuzana',
      ].join('\n'),
    },
    {
      id: 'parking',
      label: 'Parking info',
      textCs: parkingSpace
        ? [
            greeting('cs'),
            '',
            `Vaše rezervované parkovací místo je v podzemním parkovišti, 2. patro, místo č. ${parkingSpace}. Místo je označeno cedulí "Baker House Apartments".`,
            '',
            'Pokud budete potřebovat pomoc s navigací nebo přístupem k parkovišti, dejte nám prosím vědět.',
            '',
            'Hezký den!',
            'Patrik & Zuzana',
          ].join('\n')
        : [
            greeting('cs'),
            '',
            'Parkování je k dispozici v podzemním parkovišti, 2. patro. Pošleme Vám konkrétní místo před příjezdem.',
            '',
            'Hezký den!',
            'Patrik & Zuzana',
          ].join('\n'),
      textEn: parkingSpace
        ? [
            greeting('en'),
            '',
            `Your reserved parking space is in the underground garage, level −2, space #${parkingSpace}. The space is labelled "Baker House Apartments".`,
            '',
            'Let us know if you need help with directions or accessing the garage.',
            '',
            'Have a nice day!',
            'Patrik & Zuzana',
          ].join('\n')
        : [
            greeting('en'),
            '',
            'Parking is available in the underground garage, level −2. We\'ll send you the specific space number before your arrival.',
            '',
            'Have a nice day!',
            'Patrik & Zuzana',
          ].join('\n'),
    },
  ];

  return templates;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

// A conversation is "active" if the most recent message (from either side) is
// within 120 minutes, or if there's an unanswered guest message.
function isConversationActive(messages: ThreadMessage[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  const age = Date.now() - new Date(last.time).getTime();
  if (age < ACTIVE_WINDOW_MS) return true;
  // Unanswered = last message is from guest
  return last.source === 'guest';
}

export default function MessageThread({ beds24Id, hasUnread, guestName, room, guestFirstName }: MessageThreadProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [translations, setTranslations] = useState<Record<number, { text: string; lang: string } | 'loading'>>({});
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages?bookingId=${beds24Id}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data: ThreadMessage[] = await res.json();
      const sorted = [...data].reverse(); // oldest → newest (top → bottom)
      setMessages((prev) => {
        // Preserve optimistic host messages not yet confirmed by Beds24.
        // Optimistic IDs are Date.now() (~1.7 trillion); real Beds24 IDs are
        // sequential integers in the millions — reliably distinguishable.
        const OPTIMISTIC_ID_THRESHOLD = 1_000_000_000_000;
        const OPTIMISTIC_MAX_AGE_MS = 5 * 60 * 1000; // drop after 5 min regardless
        const now = Date.now();
        const pending = prev.filter(
          (m) =>
            m.id > OPTIMISTIC_ID_THRESHOLD &&
            m.source === 'host' &&
            now - new Date(m.time).getTime() < OPTIMISTIC_MAX_AGE_MS &&
            // Not yet confirmed: no real message in fetched data with same text
            !sorted.some((d) => d.source === 'host' && d.text === m.text)
        );
        return [...sorted, ...pending];
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [beds24Id]);

  // Derived visibility — must be declared before effects that reference it
  const active = isConversationActive(messages);
  const showThread = open || hasUnread || active;

  // Auto-open when a new unread message arrives
  useEffect(() => {
    if (hasUnread) setOpen(true);
  }, [hasUnread]);

  // Fetch + poll whenever thread is visible (open OR active OR unread)
  useEffect(() => {
    if (!showThread) return;
    fetchMessages();
    const id = setInterval(fetchMessages, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [showThread, fetchMessages]);

  // Scroll to bottom of message container (not the whole page) when messages change
  useEffect(() => {
    if (open && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, open]);

  async function handleSend() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId: beds24Id, message: draft.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setDraft('');
      // Optimistic update — show sent bubble immediately without waiting for Beds24
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(), // temporary; overwritten when server re-fetch resolves
          source: 'host' as const,
          text: draft.trim(),
          time: new Date().toISOString(),
        },
      ]);
      // Re-sync after Beds24 write propagation (~3–4 s)
      setTimeout(fetchMessages, 4000);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  async function handleTranslate(msgId: number, text: string) {
    setTranslations((prev) => ({ ...prev, [msgId]: 'loading' }));
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Translation failed');
      setTranslations((prev) => ({
        ...prev,
        [msgId]: { text: data.translatedText, lang: data.detectedLanguage },
      }));
    } catch {
      setTranslations((prev) => {
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
    }
  }

  // Header button — always visible
  const buttonBase = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors';

  return (
    <div>
      {/* Toggle button */}
      <button
        onClick={() => { setOpen((v) => !v); }}
        className={`${buttonBase} ${
          hasUnread
            ? 'bg-indigo-600 text-white hover:bg-indigo-700'
            : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
        }`}
      >
        {/* Envelope icon */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        Message Guest
        {hasUnread && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
          </span>
        )}
      </button>

      {/* Thread panel */}
      {showThread && (
        <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden">
          {/* Thread header */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Messages · {guestName}
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div ref={messagesContainerRef} className="max-h-64 overflow-y-auto px-3 py-3 space-y-2 bg-white">
            {loadError && (
              <p className="text-xs text-red-500 text-center">{loadError}</p>
            )}
            {!loadError && messages.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No messages yet.</p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.source === 'host' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-snug ${
                    msg.source === 'host'
                      ? 'bg-indigo-600 text-white rounded-br-none'
                      : msg.source === 'system'
                        ? 'bg-gray-100 text-gray-500 italic text-xs'
                        : 'bg-gray-100 text-gray-800 rounded-bl-none'
                  }`}
                >
                  {msg.text}
                </div>
                {/* Translate button / result */}
                <>
                  {translations[msg.id] === 'loading' ? (
                      <span className="text-[10px] text-gray-400 mt-0.5 px-1 italic">Translating…</span>
                    ) : translations[msg.id] && typeof translations[msg.id] === 'object' ? (
                      <div className="max-w-[85%] mt-1 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 text-sm text-gray-700 leading-snug">
                        {(translations[msg.id] as { text: string; lang: string }).text}
                        <span className="block text-[10px] text-gray-400 mt-0.5">
                          Translated from {(translations[msg.id] as { text: string; lang: string }).lang?.toUpperCase()}
                        </span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleTranslate(msg.id, msg.text)}
                        className="text-[10px] text-indigo-500 hover:text-indigo-700 mt-0.5 px-1 flex items-center gap-0.5"
                        title="Translate to Czech"
                      >
                        🌐 Translate
                      </button>
                  )}
                </>
                <span className="text-[10px] text-gray-400 mt-0.5 px-1">
                  {msg.source === 'host' ? 'You' : msg.source === 'guest' ? guestName : 'System'} · {formatTime(msg.time)}
                </span>
              </div>
            ))}
          </div>

          {/* Send box */}
          <div className="border-t border-gray-200 p-3 bg-white space-y-2">
            {sendError && (
              <p className="text-xs text-red-500">{sendError}</p>
            )}

            {/* Template inserts — operator picks language; text drops into the
                draft (replaces empty draft, otherwise prepends with a blank line). */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Templates:</span>
              {buildTemplates({ room, guestFirstName }).map((tpl) => (
                <div key={tpl.id} className="inline-flex items-stretch border border-gray-200 rounded-md overflow-hidden">
                  <span className="px-2 py-1 text-[10px] font-medium text-gray-600 bg-gray-50">{tpl.label}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((prev) => (prev.trim() ? `${tpl.textCs}\n\n${prev}` : tpl.textCs));
                      textareaRef.current?.focus();
                    }}
                    className="px-2 py-1 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 transition-colors border-l border-gray-200"
                    title="Insert Czech version"
                  >
                    CZ
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((prev) => (prev.trim() ? `${tpl.textEn}\n\n${prev}` : tpl.textEn));
                      textareaRef.current?.focus();
                    }}
                    className="px-2 py-1 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 transition-colors border-l border-gray-200"
                    title="Insert English version"
                  >
                    EN
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
                rows={2}
                className="flex-1 text-sm border border-gray-200 rounded-md px-2.5 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-300"
              />
              <button
                onClick={handleSend}
                disabled={!draft.trim() || sending}
                className="self-end px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {sending ? '…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
