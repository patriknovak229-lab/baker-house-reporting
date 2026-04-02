'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import type { ThreadMessage } from '@/app/api/messages/route';

const ACTIVE_WINDOW_MS = 120 * 60 * 1000; // 120 minutes
const POLL_INTERVAL_MS = 30_000;

interface MessageThreadProps {
  beds24Id: number;       // raw Beds24 booking ID (not "BH-" prefixed)
  hasUnread: boolean;     // driven by the table-level unread poll
  guestName: string;
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

export default function MessageThread({ beds24Id, hasUnread, guestName }: MessageThreadProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages?bookingId=${beds24Id}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data: ThreadMessage[] = await res.json();
      setMessages(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load messages');
    }
  }, [beds24Id]);

  // Auto-open when a new unread message arrives
  useEffect(() => {
    if (hasUnread) setOpen(true);
  }, [hasUnread]);

  // Fetch + poll while open
  useEffect(() => {
    if (!open) return;
    fetchMessages();
    const id = setInterval(fetchMessages, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, fetchMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const active = isConversationActive(messages);
  const showThread = open || hasUnread || active;

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
      await fetchMessages();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
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
          <div className="max-h-64 overflow-y-auto px-3 py-3 space-y-2 bg-white">
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
                <span className="text-[10px] text-gray-400 mt-0.5 px-1">
                  {msg.source === 'host' ? 'You' : msg.source === 'guest' ? guestName : 'System'} · {formatTime(msg.time)}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Send box */}
          <div className="border-t border-gray-200 p-3 bg-white">
            {sendError && (
              <p className="text-xs text-red-500 mb-1.5">{sendError}</p>
            )}
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
