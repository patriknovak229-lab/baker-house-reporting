'use client';
import { useEffect, useRef, useState } from 'react';
import {
  COMMON_LANGUAGES,
  OTHER_LANGUAGES,
  canonicalLanguageCode,
  translateLanguageName,
} from '@/utils/translateLanguages';

/** Where the message is written. The operator writes Czech or English; auto
 *  also covers pasting a guest's message in to read it. */
type SourceMode = 'auto' | 'cs' | 'en';

const SOURCE_OPTIONS: { value: SourceMode; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'cs', label: 'Czech' },
  { value: 'en', label: 'English' },
];

/** Google's per-request guidance — also stops a stray paste of a whole
 *  document from being billed. */
const MAX_CHARS = 5000;

/** What a translation was made from, so it can be flagged the moment the
 *  message or the languages no longer match it. */
interface TranslationSource {
  sourceText: string;
  sourceMode: SourceMode;
  target: string;
  /** Google's detected source language — empty when the source was pinned. */
  detected: string;
}

/**
 * Survives the modal closing (a stray backdrop click) and tab switches, so a
 * half-written message, its translation and the chosen languages are still
 * there on reopen. A page reload clears it.
 */
let draft = {
  text: '',
  sourceMode: 'auto' as SourceMode,
  target: 'en',
  translated: '',
  result: null as TranslationSource | null,
};

/**
 * Stand-alone translator for messages the operator sends outside the app
 * (WhatsApp, email): write in Czech or English, pick a language, copy the
 * result. Google Translate via /api/translate — literal, never adds content.
 */
export default function TranslateModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState(draft.text);
  const [sourceMode, setSourceMode] = useState<SourceMode>(draft.sourceMode);
  const [target, setTarget] = useState(draft.target);
  const [translated, setTranslated] = useState(draft.translated);
  const [result, setResult] = useState<TranslationSource | null>(draft.result);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Only the latest request may land — switching language twice quickly must
  // not let the first, slower response overwrite the second.
  const requestSeq = useRef(0);

  useEffect(() => {
    draft = { text, sourceMode, target, translated, result };
  }, [text, sourceMode, target, translated, result]);

  const sameLanguagePinned = sourceMode !== 'auto' && sourceMode === target;
  const isStale =
    result !== null &&
    (result.sourceText !== text || result.sourceMode !== sourceMode || result.target !== target);
  const alreadyInTarget =
    result !== null &&
    result.detected !== '' &&
    canonicalLanguageCode(result.detected) === canonicalLanguageCode(result.target);

  async function translate(next: { sourceMode?: SourceMode; target?: string } = {}) {
    const src = next.sourceMode ?? sourceMode;
    const tgt = next.target ?? target;
    const input = text;
    if (!input.trim() || (src !== 'auto' && src === tgt)) return;

    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input,
          targetLang: tgt,
          ...(src !== 'auto' ? { sourceLang: src } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? 'Translation failed');
      setTranslated(String(data.translatedText ?? ''));
      setResult({
        sourceText: input,
        sourceMode: src,
        target: tgt,
        detected: String(data.detectedLanguage ?? ''),
      });
    } catch (e) {
      if (seq === requestSeq.current) setError((e as Error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  // Once something has been translated, changing a language re-runs it (as
  // Google Translate does) rather than leaving the old language on screen.
  function changeSource(next: SourceMode) {
    setSourceMode(next);
    if (result) void translate({ sourceMode: next });
  }

  function changeTarget(next: string) {
    setTarget(next);
    if (result) void translate({ target: next });
  }

  function clear() {
    requestSeq.current++; // drop any response still in flight
    setText('');
    setTranslated('');
    setResult(null);
    setError(null);
    setLoading(false);
  }

  async function copy() {
    if (!translated) return;
    try {
      await navigator.clipboard.writeText(translated);
      setError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard access denied. Select the text and copy manually.');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-sky-50">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-sky-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
            </svg>
            <h2 className="text-base font-semibold text-gray-800">Translate</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* Languages */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div>
              <span className="block text-xs font-medium text-gray-500 mb-1">From</span>
              <div className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5">
                {SOURCE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => changeSource(o.value)}
                    className={`px-3 py-1.5 rounded text-sm transition-colors ${
                      sourceMode === o.value
                        ? 'bg-white shadow-sm text-sky-700 font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <svg className="hidden sm:block w-4 h-4 text-gray-300 mb-2.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="sm:flex-1">
              <label htmlFor="translate-target" className="block text-xs font-medium text-gray-500 mb-1">To</label>
              <select
                id="translate-target"
                value={target}
                onChange={(e) => changeTarget(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              >
                <optgroup label="Common">
                  {COMMON_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Other languages">
                  {OTHER_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>

          {/* Message */}
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void translate();
                }
              }}
              maxLength={MAX_CHARS}
              rows={6}
              autoFocus
              aria-label="Message to translate"
              placeholder="Type or paste the message you want to send…"
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            />
            <div className="flex items-center justify-between gap-3 mt-2">
              <span className="text-xs text-gray-400">
                {text.length > MAX_CHARS * 0.8 ? `${text.length} / ${MAX_CHARS} characters` : '⌘/Ctrl + Enter to translate'}
              </span>
              <div className="flex items-center gap-2">
                {(text || translated) && (
                  <button
                    type="button"
                    onClick={clear}
                    className="px-3 py-2 rounded-md text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void translate()}
                  disabled={loading || !text.trim() || sameLanguagePinned}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Translating…' : 'Translate'}
                </button>
              </div>
            </div>
            {sameLanguagePinned && (
              <p className="text-xs text-amber-700 mt-1">Pick a target language different from the one you&apos;re writing in.</p>
            )}
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {/* Translation */}
          {result && (
            <div>
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-xs font-medium text-gray-500">
                  {translateLanguageName(result.target)}
                  <span className="font-normal text-gray-400">
                    {' · from '}
                    {result.sourceMode === 'auto'
                      ? result.detected
                        ? `${translateLanguageName(result.detected)} (detected)`
                        : 'auto-detect'
                      : translateLanguageName(result.sourceMode)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={copy}
                  disabled={!translated}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium transition-colors disabled:opacity-50 ${
                    copied
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-sky-200 bg-white text-sky-700 hover:bg-sky-50'
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {copied ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    )}
                  </svg>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <textarea
                value={translated}
                onChange={(e) => setTranslated(e.target.value)}
                rows={6}
                aria-label="Translation"
                className={`w-full border border-sky-100 bg-sky-50/40 rounded-md px-3 py-2 text-sm text-gray-800 resize-y focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition-opacity ${
                  isStale || loading ? 'opacity-50' : ''
                }`}
              />
              {isStale && !loading && !sameLanguagePinned && (
                <p className="text-xs text-amber-700 mt-1">
                  Out of date: the message or language changed since this translation. Press Translate to update it.
                </p>
              )}
              {alreadyInTarget && !isStale && !loading && (
                <p className="text-xs text-gray-500 mt-1">
                  The message is already in {translateLanguageName(result.target)}, so it came back unchanged.
                </p>
              )}
            </div>
          )}

          <p className="text-[11px] text-gray-400">
            Machine translation (Google Translate). You can edit the result before copying. Double-check names,
            dates, times and prices before sending.
          </p>
        </div>
      </div>
    </div>
  );
}
