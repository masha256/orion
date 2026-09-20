import type { FetchedPage } from './guardrails.js';
import type { ModelMessageParam } from './model.js';

/**
 * The pages web_fetch returned so far in this run, read from the transcript. Citation verification checks quotes against
 * these and nothing else, so a page that did not come back as text (a PDF, a fetch error) cannot be cited: it fails closed.
 */
export function fetchedPagesFrom(messages: ModelMessageParam[]): FetchedPage[] {
  const pages: FetchedPage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'web_fetch_tool_result' || block.content.type !== 'web_fetch_result') continue;
      const source = block.content.content.source;
      if (source.type === 'text') pages.push({ url: block.content.url, text: source.data });
    }
  }
  return pages;
}
