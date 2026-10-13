// Demo state on Workers KV: prefs and the activity feed for one user.
// makeStore takes anything with KV's get(key, 'json') / put(key, string) / delete(key),
// so tests pass memoryKV() and the Worker passes env.FC_STORE.

export const DEFAULT_PREFS = { region: 'uk', mandate_choice: 'ask', agents_paused: false };
export const REGIONS = ['uk', 'sg'];
export const MANDATE_CHOICES = ['ask', 'baseline'];
export const EVENTS_CAP = 50;

// In-memory stand-in for a KV namespace (tests, local scripts).
export function memoryKV() {
  const m = new Map();
  return {
    async get(key, type) {
      const v = m.has(key) ? m.get(key) : null;
      return v != null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
  };
}

// Throws on an unknown region or choice, so a bad POST can't poison stored prefs.
export function validatePrefsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('prefs must be an object');
  const out = {};
  if ('region' in patch) {
    if (!REGIONS.includes(patch.region)) throw new Error(`region must be one of ${REGIONS.join(', ')}`);
    out.region = patch.region;
  }
  if ('mandate_choice' in patch) {
    if (!MANDATE_CHOICES.includes(patch.mandate_choice)) throw new Error(`mandate_choice must be one of ${MANDATE_CHOICES.join(', ')}`);
    out.mandate_choice = patch.mandate_choice;
  }
  if ('agents_paused' in patch) {
    if (typeof patch.agents_paused !== 'boolean') throw new Error('agents_paused must be true or false');
    out.agents_paused = patch.agents_paused;
  }
  return out;
}

export function makeStore(kv, user = 'demo') {
  const PREFS = `prefs:${user}`;
  const EVENTS = `events:${user}`;
  const MANDATE = `mandate:${user}`;
  return {
    // The standing mandate an agent spends against: {id, mandate, status, created_at, agent}.
    // One per user; status is "active" until revoked or used up (one-off).
    async getStandingMandate() {
      return kv.get(MANDATE, 'json');
    },
    async setStandingMandate(record) {
      await kv.put(MANDATE, JSON.stringify(record));
      return record;
    },
    async setMandateStatus(status) {
      const rec = await kv.get(MANDATE, 'json');
      if (!rec) return null;
      const next = { ...rec, status, [`${status}_at`]: new Date().toISOString() };
      await kv.put(MANDATE, JSON.stringify(next));
      return next;
    },
    async getPrefs() {
      return { ...DEFAULT_PREFS, ...((await kv.get(PREFS, 'json')) ?? {}) };
    },
    async setPrefs(patch) {
      const next = { ...(await this.getPrefs()), ...validatePrefsPatch(patch) };
      await kv.put(PREFS, JSON.stringify(next));
      return next;
    },
    // Newest first.
    async listEvents(n = EVENTS_CAP) {
      return ((await kv.get(EVENTS, 'json')) ?? []).slice(0, n);
    },
    // Pass related events together (e.g. receipt + order) so they land in one write.
    // Arguments are oldest first; the stored list is newest first, capped.
    async addEvents(...events) {
      const current = (await kv.get(EVENTS, 'json')) ?? [];
      const next = [...events.reverse(), ...current].slice(0, EVENTS_CAP);
      await kv.put(EVENTS, JSON.stringify(next));
      return next;
    },
    async resetEvents() {
      await kv.delete(EVENTS);
    },
  };
}
