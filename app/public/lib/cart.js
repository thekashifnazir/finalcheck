// Cart builder shared by the ops console, the MCP server and /api/sign, so every surface prices
// a cart the same way. Pure — no DOM, no fetch. Money is integer pence.
//
// Input items:  { listing_id, quantity?, notes?, add_recurring_addon? }
// Output items: { listing_id, name, price, quantity, currency?, notes?, fees? } plus, when asked
//               for, the listing's recurring add-on as its own row with `recurring` set.

export function buildCart(items, listingsById) {
  const out = [];
  for (const it of items ?? []) {
    const l = listingsById[it.listing_id];
    if (!l) throw new Error(`unknown listing_id ${JSON.stringify(it.listing_id)}`);
    const qty = Number.isInteger(it.quantity) && it.quantity > 0 ? it.quantity : 1;
    const row = { listing_id: l.id, name: l.name, price: l.price, quantity: qty };
    if (l.currency) row.currency = l.currency;
    if (it.notes) row.notes = String(it.notes);
    if (l.checkout_fees?.length) row.fees = l.checkout_fees.map((f) => ({ label: f.label, amount: f.amount }));
    out.push(row);
    if (it.add_recurring_addon && l.recurring_addon) {
      const a = l.recurring_addon;
      out.push({ listing_id: l.id, name: a.name, price: a.price, quantity: 1, recurring: a.interval });
    }
  }
  const first = listingsById[items?.[0]?.listing_id];
  return { merchant: first?.merchant ?? null, items: out };
}

const qtyOf = (i) => (Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1);
export const feesOf = (i) => (i.fees ?? []).reduce((a, f) => a + f.amount, 0);
export const lineTotal = (i) => i.price * qtyOf(i) + feesOf(i);

// one_off_total = Σ price × qty + Σ fees over non-recurring rows.
export function cartTotals(cart) {
  let one_off_total = 0;
  let recurring_total = 0;
  for (const i of cart.items) {
    if (i.recurring) recurring_total += lineTotal(i);
    else one_off_total += lineTotal(i);
  }
  return { one_off_total, recurring_total, pending_total: one_off_total + recurring_total };
}
