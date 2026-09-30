import { describe, it, expect, afterEach, vi } from 'vitest';
import { translateText } from './googleTranslate';

function stubGoogle(response: { ok?: boolean; status?: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubGoogle>): Record<string, unknown> {
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  return JSON.parse(String(init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
});

describe('translateText', () => {
  it('auto-detects the source when none is given, and returns the detection', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubGoogle({
      body: { data: { translations: [{ translatedText: 'Hallo', detectedSourceLanguage: 'cs' }] } },
    });

    await expect(translateText('Ahoj', 'de')).resolves.toEqual({
      translatedText: 'Hallo',
      detectedLanguage: 'cs',
    });
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ q: 'Ahoj', target: 'de', format: 'text' });
    expect(body).not.toHaveProperty('source');
  });

  it('pins the source when given; Google then reports no detection', async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    const fetchMock = stubGoogle({ body: { data: { translations: [{ translatedText: 'Danke' }] } } });

    await expect(translateText('diky moc', 'de', 'cs')).resolves.toEqual({
      translatedText: 'Danke',
      detectedLanguage: '',
    });
    expect(sentBody(fetchMock)).toMatchObject({ q: 'diky moc', target: 'de', source: 'cs' });
  });

  it('returns null without calling Google when the key is missing', async () => {
    const fetchMock = stubGoogle({ body: {} });
    await expect(translateText('Ahoj', 'de')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Google's own error message", async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = 'test-key';
    stubGoogle({ ok: false, status: 400, body: { error: { message: 'Invalid Value' } } });
    await expect(translateText('Ahoj', 'xx')).rejects.toThrow('Invalid Value');
  });
});
