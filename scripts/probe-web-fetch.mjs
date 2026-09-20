// One live request, a few cents: does the web_fetch server tool return the page text to the client?
// Orion verifies citations against that text (src/agent/research.ts), so the answer decides WEB_FETCH_TOOL_TYPE in
// src/agent/model.ts. Usage, from the repo root:  node scripts/probe-web-fetch.mjs [tool_type] [url]
// Credentials: ANTHROPIC_API_KEY in the environment, or an `ant auth login` profile.
import Anthropic from "@anthropic-ai/sdk";

const toolType = process.argv[2] ?? "web_fetch_20260209";
const url = process.argv[3] ?? "https://example.com/";
const client = new Anthropic();

const message = await client.beta.messages
  .stream({
    model: "claude-opus-5",
    max_tokens: 2000,
    tools: [{ type: toolType, name: "web_fetch", max_uses: 1, max_content_tokens: 5000 }],
    messages: [{ role: "user", content: `Fetch ${url} with web_fetch and tell me its title in one line.` }],
  })
  .finalMessage();

let pages = 0;
for (const block of message.content) {
  if (block.type !== "web_fetch_tool_result") continue;
  if (block.content.type !== "web_fetch_result") {
    console.log(`fetch error: ${JSON.stringify(block.content)}`);
    continue;
  }
  const source = block.content.content.source;
  pages += 1;
  console.log(`url: ${block.content.url}`);
  console.log(`source.type: ${source.type}  length: ${source.data?.length ?? 0}`);
  console.log(`first 200 chars: ${JSON.stringify(String(source.data ?? "").slice(0, 200))}`);
}
console.log(`stop_reason: ${message.stop_reason}  usage: ${JSON.stringify(message.usage)}`);
console.log(
  pages > 0
    ? `PASS: ${toolType} returns page text to the client. Citation verification can read it.`
    : `FAIL: no web_fetch_result with text came back for ${toolType}. Try: node scripts/probe-web-fetch.mjs web_fetch_20250910`,
);
process.exitCode = pages > 0 ? 0 : 1;
