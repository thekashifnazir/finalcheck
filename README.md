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

Two screens, one engine:
- **Ops console** (`/ops/`): the five-stage walkthrough. Mandate → agent shops with the guard off
  (it gets prompt-injected by hidden text on a listing and adds a £4.99/mo subscription) → guard on:
  3 violations blocked, hidden text revealed → agent rebuilds a compliant cart → approve and sign.
- **Consumer view** (`/`): plain-English protection status (UK or Singapore pack), set, revoke or
  skip a mandate, and a feed of what your agent did.

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
                 ├─ mandate rules: OVER_BUDGET, CATEGORY_MISMATCH, EXPIRED
                 └─ baseline rules: UNDISCLOSED_RECURRING, INJECTED_INSTRUCTION
            ──► verdict {violations + basis/ref from the policy pack}
            ──► receipt.buildReceipt → canonical JSON → SHA-256 → intent receipt
```
- Cloudflare Worker (`app/worker/`) serves static assets and `/api/*`; KV stores prefs and events.
- The engine (`app/public/lib/`) is plain ES modules shared by the browser, the Worker and the tests.
- Policy packs (`app/public/policies/uk.json`, `sg.json`) are data: each rule's basis and reference
  live there, not in code.
- Money is integer pence everywhere. Hidden listing text is displayed as evidence, never interpreted.

## How to run

```bash
git clone https://github.com/thekashifnazir/finalcheck && cd finalcheck/app
npm install
npm test                       # unit tests (node:test)
cp .dev.vars.example .dev.vars # optional: add APP_ANTHROPIC_API_KEY for the LLM parse
npm run dev                    # http://localhost:8787  (ops console at /ops/)
```
No key? Everything still works: the parser falls back to the keyword ruleset.
Fully offline: `npm run static` serves the pages without the Worker (client-side parse, no feed).

## Models, APIs and external services

- **Anthropic Messages API**: Claude (`claude-haiku-5-5` by default, `APP_LLM_MODEL` overrides) for
  one intent-parse call per mandate. Optional. OpenAI `gpt-4.1-mini` is used only if no Anthropic key is set.
- **Cloudflare Workers + Workers KV**: hosting, API and demo state.
- Web Crypto `SHA-256` (built in) for receipt hashing. No payment APIs are called.

## Assumptions

- The agent's only way to pay is through FinalCheck, so a tricked agent can't route around the check.
- A mandate holds only cap, scope and expiry: no card or identity data.
- Listing content (including text hidden from the human) is untrusted data, never instructions.
- The policy packs are an illustrative subset, written for this prototype and not reviewed by a lawyer.

## Known limitations

- **Demo data.** The agent run is scripted, the four listings and merchants are fictional, and
  the payment rail is mocked: no real money moves. The UI says so in a banner.
- The receipt "signature" is a SHA-256 hash of the canonical receipt JSON, not a key signature.
- Only 5 rules are implemented. The policy packs list more baseline codes (gift cards, lookalike
  merchants, drip pricing, first-time payee…) that the engine doesn't run yet; it skips codes it doesn't know.
- Injection detection is a keyword match on hidden text. It catches the demo case, not paraphrased attacks.
- Single demo user; prefs and events are shared by everyone using the deployed URL.
- The consumer view keeps the active mandate in the browser (labelled on screen).

## What we'd build next

- An MCP tool server so any agent pays only through FinalCheck (the engine is already UI-free).
- Real key signatures (Ed25519) on receipts, verifiable by a merchant or bank.
- The remaining baseline fraud rules, and recurring-charge monitoring with one-tap revocation.
- A virtual-card issuer behind the verdict, so a block stops the money, not just the agent.
- Dispute filing that attaches the receipt automatically.

## Licence

MIT — see [LICENSE](LICENSE).
