// Sharpe Sprint Paper Bot — Pump.fun Sharpe Sprint (make.fun).
//
// Paper-trades a 6-hour pump.fun replay, ranked by HOURLY SHARPE RATIO.
// Strategy: many small, diversified buys on fresh mints showing early
// momentum, tight take-profit / stop-loss / max-hold exits, at most 5 open
// positions. Steady controlled gains beat one lucky moonshot.
//
// Wire protocol: agent-fun/replay/v2. The hello message opens the run, each
// batch carries one slot of events, and the orders decided on a batch's slot
// fill two slots later. stdout carries replies only; diagnostics go to stderr.
// Fully deterministic: no clock, no environment, no Math.random.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const BUY_SIZE_LAMPORTS = 200_000_000n; // 0.20 SOL per entry
const MIN_BUY_LAMPORTS = 30_000_000n; // 0.03 SOL; below this a round trip is noise
const MIN_REAL_RESERVE_LAMPORTS = 3_000_000_000n; // need real reserves >= 3 SOL
const MIN_TRADES = 8; // a mint must show at least this many trades first
const MIN_BUY_SHARE = 0.7; // at least 70% of its trades must be buys
const MIN_RISE = 1.1; // price must be up >= 10% from creation ...
const MAX_RISE = 1.5; // ... but never chase a mint that already ran +50%
const TAKE_PROFIT = 1.15; // sell the full position at +15% of cost
const STOP_LOSS = 0.95; // sell the full position at -5% of cost
const MAX_HOLD_SLOTS = 2400; // ~16 minutes; then exit whatever the price
const TRAIL_TRIGGER = 1.08; // once up 8%, trail the peak ...
const TRAIL_GIVEBACK = 0.05; // ... and sell after giving back 5 points
const MAX_SLIPPAGE_BPS = 500;

// ------------------------------------------------------------------ helpers

/** SOL per token from a curve's virtual reserves. */
function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

interface MintStats {
  firstPrice: number;
  maxPrice: number;
  buys: number;
  sells: number;
}

// Per-mint momentum stats, mints we already round-tripped (never re-buy),
// the slot each open position was first seen (for the max-hold exit), and
// each open position's peak value/cost ratio (for the trailing exit).
const stats = new Map<string, MintStats>();
const doneMints = new Set<string>();
const heldSince = new Map<string, number>();
const peakRatio = new Map<string, number>();

await runBot({
  onHello(state) {
    console.error(`hello: capital=${state.hello.capital.lamports} seed=${state.hello.seed}`);
  },

  onBatch(state: BotState, batch: Batch) {
    // ---- fold this batch's events into the per-mint stats -------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (!stats.has(e.mint)) stats.set(e.mint, { firstPrice: p, maxPrice: p, buys: 0, sells: 0 });
      } else if (e.event === 'TradeEvent') {
        let s = stats.get(e.mint);
        if (s === undefined) {
          const curve = state.curves.get(e.mint);
          const p0 = curve ? priceOf(curve) : 0;
          s = { firstPrice: p0, maxPrice: p0, buys: 0, sells: 0 };
          stats.set(e.mint, s);
        }
        if (e.is_buy) s.buys += 1;
        else s.sells += 1;
        const p = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        if (p > s.maxPrice) s.maxPrice = p;
      }
    }

    // ---- track hold times; forget mints whose positions closed --------
    for (const mint of state.positions.keys()) {
      if (!heldSince.has(mint)) heldSince.set(mint, batch.slot);
    }
    for (const mint of [...heldSince.keys()]) {
      if (!state.positions.has(mint)) {
        heldSince.delete(mint);
        peakRatio.delete(mint);
        doneMints.add(mint);
      }
    }

    const out: Array<
      | { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }
      | { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number }
    > = [];

    // ---- exits first: TP / SL / trailing / max-hold, always FULL -----
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const p = priceOf(curve);
      if (p <= 0) continue;
      const value = (holding.token_amount * BigInt(Math.floor(p * 1e12))) / 1_000_000_000_000n;
      const ratio = Number(value) / Number(holding.cost_lamports);
      const peak = Math.max(peakRatio.get(mint) ?? ratio, ratio);
      peakRatio.set(mint, peak);
      const held = batch.slot - (heldSince.get(mint) ?? batch.slot);
      const trailed = peak >= TRAIL_TRIGGER && ratio <= peak - TRAIL_GIVEBACK;
      if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || trailed || held >= MAX_HOLD_SLOTS) {
        out.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    // ---- entries: fresh mints with early momentum, best first ---------
    const freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots > 0) {
      const candidates: Array<{ mint: string; score: number; size: bigint }> = [];
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (state.positions.has(mint) || doneMints.has(mint)) continue;
        if (curve.trades < MIN_TRADES) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
        let pendingBuy = false;
        for (const po of state.pending.values()) {
          if (po.order.side === 'buy' && po.order.mint === mint) {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) continue;
        const s = stats.get(mint);
        if (s === undefined || s.firstPrice <= 0) continue;
        const total = s.buys + s.sells;
        if (total < MIN_TRADES) continue;
        const buyShare = s.buys / total;
        if (buyShare < MIN_BUY_SHARE) continue;
        const p = priceOf(curve);
        const rise = p / s.firstPrice;
        if (rise < MIN_RISE || rise > MAX_RISE) continue;
        if (s.maxPrice > 0 && p < 0.97 * s.maxPrice) continue; // fading off its high: skip
        const cap = state.maxBuyLamports(mint);
        const size = cap < BUY_SIZE_LAMPORTS ? cap : BUY_SIZE_LAMPORTS;
        if (size < MIN_BUY_LAMPORTS) continue;
        candidates.push({ mint, score: rise * buyShare, size });
      }
      candidates.sort((a, b) => b.score - a.score);
      let cash = state.freeCashLamports();
      const txFee = state.txFeeLamports();
      for (const c of candidates) {
        if (out.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.committedPositionCount() + out.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (cash < c.size + txFee) break;
        out.push({ side: 'buy', mint: c.mint, quote_lamports: c.size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cash -= c.size + txFee;
      }
    }

    return out;
  },

  onDone(state, done) {
    const cash = Number(state.cash) / Number(LAMPORTS_PER_SOL);
    console.error(`done: reason=${done.reason} cash=${cash.toFixed(4)} SOL round_trips=${doneMints.size}`);
  },
});
