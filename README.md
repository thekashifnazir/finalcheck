# FinalCheck

The last checkpoint before an AI agent spends your money

**SGN × LSE Generate Fintech Hackathon** · track: Fraud and Security · team: FinalCheck

▶ **[Demo video (60s)](demo/demo.mp4)**

## What we built

FinalCheck is the last checkpoint between a person and an AI agent that spends their money.

You write what you want in plain English ("a birthday gift for my mum — under £40, one-off, no
subscriptions"). FinalCheck turns it into a **spending mandate**: cap, scope, expiry, no recurring.
Before any cart is paid, a rules engine checks the agent's cart against that mandate and against a
**baseline** of scam rules that apply even with no mandate. A cart that breaks the mandate is blocked
with the reason and the regulation behind it. A compliant cart gets a hashed **intent receipt**,
which is the evidence for a dispute (there is no chargeback reason code for "my AI agent did it").

Console for humans, tools for agents, one engine:
- **Consumer view** (`/`): plain-English protection status (UK or Singapore pack). A short
  conversation builds the mandate: you say what you want, and it asks only for what you left out
  (price, renewals, purpose, end date). You can revoke the mandate, or skip it and keep baseline
  protection. **Pause my agent** is a kill switch: every purchase the agent tries is refused and
  logged until you resume. A feed shows what your agent did, in sentences.
- **Ops console** (`/ops/`): three scenarios, walked through stage by stage.
  **A** hidden instruction + upsell: prompt-injected listing, £4.99/mo add-on, over budget.
  **B** lookalike merchant + drip fee: a shop 2 characters off the real domain, a fee that appears
  only at checkout, card details pasted into a gift message.
  **C** coerced gift-card purchase: "Mum texted from a new number". FinalCheck halts, nothing is
  paid, and a refusal record is kept.
  Signed receipts can be verified against the published key, and a **tamper** button edits the total
  to show the signature check failing.
- **Agent tools** (`/mcp`): a remote MCP server. An agent like Claude lists products, sets or asks
  for a mandate, checks a cart, and pays only through `sign_receipt`. If there's no mandate, the agent
  is told to ask the person once: set one, or continue with baseline protection.
  [`app/mcp/TRANSCRIPT.md`](app/mcp/TRANSCRIPT.md) records a real Claude agent going through it:
  the handshake, a refused cart, a signed and verified purchase, and the pause.

## Operational problem

Agentic checkout is shipping now (card networks ran live agent transactions in 2026; AP2 defines
agent payment mandates), but nothing sits between "the agent decided" and "the money left".
Red-team studies manipulate shopping-agent carts with hidden page text 56–90% of the time.
UK APP fraud was £576.4m across 248k cases in 2025 (UK Finance), and about a third of
reimbursement claims are rejected, so the person needs evidence of what they actually authorised.

## Architecture

```
plain-English intent ──► /api/parse ──► Claude (optional) ─┐
                         keyword ruleset (always) ─────────┴─► mergeMandate: the LLM may only TIGHTEN
agent cart ──► rules.check(mandate | null, cart, listings, now, policyPack)
                 ├─ mandate rules (4): OVER_BUDGET, CATEGORY_MISMATCH, EXPIRED, QUANTITY_ANOMALY
                 └─ baseline rules (9): UNDISCLOSED_RECURRING, INJECTED_INSTRUCTION, RESTRICTED_CATEGORY,
                    MERCHANT_UNVERIFIED, PRICE_DRIFT, FIRST_TIME_PAYEE, PRESSURE_CUE, DATA_EXFIL,
                    CURRENCY_MISMATCH  (these run even with no mandate)
            ──► verdict {violations + basis/ref from the policy pack}
            ──► receipt.buildReceipt → canonical JSON → Ed25519 signature → intent receipt
```
- `/api/sign` and the MCP `sign_receipt` tool **re-run the check on the server**, rebuilding the cart
  from listing IDs, so a client can't lie about prices or skip the verdict.
- Cloudflare Worker (`app/worker/`) serves static assets and `/api/*`; KV stores prefs and events.
- The engine (`app/public/lib/`) is plain ES modules shared by the browser, the Worker and the tests.
- Policy packs (`app/public/policies/uk.json`, `sg.json`) are data: each rule's basis and reference
  live there, not in code.
- Money is integer pence everywhere. Hidden listing text is displayed as evidence, never interpreted.

## How to run

Requires Node 22+ (Wrangler 4, WebCrypto Ed25519) and python3 for `npm run static`.

```bash
git clone https://github.com/thekashifnazir/finalcheck && cd finalcheck/app
npm install
npm test                       # unit tests (node:test)
cp .dev.vars.example .dev.vars # optional: add APP_ANTHROPIC_API_KEY for the LLM parse
npm run dev                    # http://localhost:8787  (ops console at /ops/)
```
- Consumer view: http://localhost:8787/ · ops console: http://localhost:8787/ops/
- Agents connect with `claude mcp add --transport http finalcheck http://localhost:8787/mcp`
- Optional signed receipts: `node scripts/gen-keys.mjs >> .dev.vars`, then restart `npm run dev`.
- No key? Everything still works: the parser falls back to the keyword ruleset.
- Fully offline: `npm run static` serves the pages on http://localhost:8000 (/ and /ops/) without the
  Worker (client-side parse, no feed or server receipts). Port taken? `python3 -m http.server 8001 -d public`.
- Live: https://finalcheck.kash-553.workers.dev

## Models, APIs and external services

- **Anthropic Messages API**: Claude (`claude-haiku-5-5` by default, `APP_LLM_MODEL` overrides) for
  one intent-parse call per mandate. Optional. OpenAI `gpt-4.1-mini` is used only if no Anthropic key is set.
- **Cloudflare Workers + Workers KV**: hosting, API and demo state.
- Web Crypto (built in): SHA-256 and Ed25519 for receipt signing; `GET /api/keys` publishes the
  public key and `POST /api/verify` checks a receipt. No payment APIs are called.
- Model Context Protocol (Streamable HTTP, hand-rolled JSON-RPC) for the agent tools.

## Assumptions

- The agent's only way to pay is through FinalCheck, so a tricked agent can't route around the check.
- A mandate holds only cap, scope and expiry: no card or identity data.
- Listing content (including text hidden from the human) is untrusted data, never instructions.
- The policy packs are an illustrative subset, written for this prototype and not reviewed by a lawyer.

## Known limitations

- **Demo data.** The agent run is scripted, the four listings and merchants are fictional, and
  the payment rail is mocked: no real money moves. The UI says so in a banner.
- Receipts are Ed25519-signed only when a signing key is configured. Without one they carry a SHA-256
  hash, and the receipt says so. There is one demo key, with no rotation or revocation.
- The fraud rules are deliberately simple: injection detection is a keyword match on hidden text,
  lookalike detection is edit distance against a short verified-merchant list, and pressure cues
  are phrase matches. They catch the scripted scenarios, not a determined attacker.
- Single demo user. Prefs, the standing mandate and events are shared by everyone using the
  deployed URL, and KV writes can race under concurrent use.
- Agent identity is a label ("mcp"/"console"), not a per-agent credential.
- **An agent can set or decline its own mandate** through the MCP tools (`set_mandate`,
  `decline_mandate`). The tool descriptions say "only with the user's words", but nothing enforces it
  yet. The fix is agent-set mandates staying "pending" until the person approves them on the page.
- `/api/sign` is unauthenticated and trusts the mandate the ops console sends. It's the demo console's
  route; agents pay through `/mcp`, which uses the stored mandate and honours the pause.
- A one-off mandate can be spent twice by two truly simultaneous agent calls (KV read-then-write).
  A Durable Object would serialise it.
- Recurring charges have no cap of their own when subscriptions are allowed. The parser takes the
  first amount it sees ("up to 3 gifts, max £100" reads as £3). It errs tighter, never looser.
- Listings carry no currency, so an S$ mandate isn't flagged against £-priced test listings.
- The mandate conversation understands caps, renewals, gift/anything, weekdays, "tonight" and
  "in N days". Anything else gets a hint and the question is asked again.

## What we'd build next

- Per-agent credentials and signed mandate tokens, so a merchant can verify which agent acted
  under which mandate.
- Recurring-charge monitoring with one-tap revocation.
- Stronger detectors behind the same rule codes (model-based injection and pressure classifiers).
- A virtual-card issuer behind the verdict, so a block stops the money, not just the agent.
- Dispute filing that attaches the receipt automatically.

## Licence

MIT — see [LICENSE](LICENSE).
