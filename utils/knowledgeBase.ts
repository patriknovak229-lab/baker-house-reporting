/**
 * Loads the property knowledge base (data/ai-knowledge-base.md) that grounds
 * the AI guest-reply composer. The markdown file is the single source of
 * truth, edited directly; this just reads it at runtime.
 *
 * Bundling note: the file is pulled into the serverless function via
 * `outputFileTracingIncludes` in next.config.ts (the webhook route). Without
 * that entry the read would ENOENT on Vercel. Cached at module scope, so a
 * KB edit takes effect on the next deploy (which is when the file changes
 * anyway).
 */

import fs from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

export function getKnowledgeBase(): string {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(
      path.join(process.cwd(), 'data', 'ai-knowledge-base.md'),
      'utf-8',
    );
  } catch (err) {
    console.error(
      '[knowledgeBase] could not read data/ai-knowledge-base.md:',
      err instanceof Error ? err.message : err,
    );
    cached = '';
  }
  return cached;
}
