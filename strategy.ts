// Surge-dip paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Two legs, one risk engine. The breakout leg buys a curve whose tape shows fresh,
// accelerating buy pressure: several distinct buyers, net SOL flowing in, the price
// rising and sitting near its window high, with a burst of trades in the last few
// slots. The dip leg buys a curve that fell back from its recent high while buyers
// are still stepping in, and sells on a partial rebound. Both legs size small first
// and add only into strength, cut losers on a stop, trail winners, and never hold
// past a time limit. Tiny probe round trips keep the run on pace for the guardrail
// (a round trip of at least 0.01 SOL on at least 20 coins).
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs. Iteration is over insertion-ordered maps only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Breakout leg: entry window in slots. */
  breakWindow: number;
  /** Breakout leg: buy trades in the window. */
  breakMinBuys: number;
  /** Breakout leg: distinct buying wallets in the window. */
  breakMinBuyers: number;
  /** Breakout leg: net buy SOL (buys minus sells) over the window. */
  breakMinNetSol: number;
  /** Breakout leg: price rise over the window, minus 1 (lower bound). */
  breakMinUp: number;
  /** Breakout leg: price rise over the window, minus 1 (upper bound). */
  breakMaxUp: number;
  /** Breakout leg: price now at least this share of the window high. */
  breakNearHigh: number;
  /** Breakout leg: trades in the last breakSurgeSlots slots. */
  breakSurgeTrades: number;
  breakSurgeSlots: number;
  /** Breakout leg: curve real SOL bounds at entry. */
  breakMinRq: number;
  breakMaxRq: number;
  /** Breakout leg: slots since CreateEvent before entry is allowed / after which it stops. */
  breakMinAge: number;
  breakMaxAge: number;
  /** Breakout leg: take profit when the position's value reaches cost * (1 + breakTakeProfit). */
  breakTakeProfit: number;
  /** Dip leg: lookback in slots for the recent high. */
  dipHighWindow: number;
  /** Dip leg: enter when price is at least this far below the recent high (fraction). */
  dipMin: number;
  /** Dip leg: ...and not further than this (a collapse, not a dip). */
  dipMax: number;
  /** Dip leg: trades counted for the flow check. */
  dipFlowTrades: number;
  /** Dip leg: buys among those trades. */
  dipMinBuys: number;
  /** Dip leg: net SOL over those trades. */
  dipMinNetSol: number;
  /** Dip leg: slots since CreateEvent before entry is allowed. */
  dipMinAge: number;
  /** Dip leg: share of the dip gap whose recovery takes profit. */
  dipRecover: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most SOL at cost in one position. */
  maxPosSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Keep adding while the entry signal still holds, up to maxPosSol. */
  pyramid: boolean;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: the run must end with at least 200 fills over at least 20 coins. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// Settings traded with. Chosen by hand for robustness across windows, then checked
// with grade-local on the dev window; flat regions preferred over a single best cell.
export const DEFAULT_PARAMS: Params = {
  breakWindow: 24,
  breakMinBuys: 4,
  breakMinBuyers: 5,
  breakMinNetSol: 1.2,
  breakMinUp: 0.06,
  breakMaxUp: 1.2,
  breakNearHigh: 0.92,
  breakSurgeTrades: 3,
  breakSurgeSlots: 8,
  breakMinRq: 1.5,
  breakMaxRq: 50,
  breakMinAge: 200,
  breakMaxAge: 6000,
  breakTakeProfit: 0.5,
  dipHighWindow: 60,
  dipMin: 0.15,
  dipMax: 0.25,
  dipFlowTrades: 20,
  dipMinBuys: 10,
  dipMinNetSol: 0.2,
  dipMinAge: 200,
  dipRecover: 0.6,
  firstSol: 0.03,
  addSol: 0.08,
  maxPosSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.1,
  trail: 0.15,
  trailArm: 0.05,
  maxHold: 400,
  holdIfUp: 0.1,
  fadeWindow: 12,
  fadeNetSol: 0.5,
  bigSellSol: 5,
  cooldown: 300,
  maxEntries: 1,
  pyramid: true,
  addStep: 0.02,
  addIfUp: 0,
  maxMain: 4,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

type Leg = 'break' | 'dip';

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
  /** Which leg opened it. */
  leg: Leg;
  /** Entry price and the recent high at entry (dip leg take-profit target). */
  entryPrice: number;
  entryHigh: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.breakWindow, p.dipHighWindow, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Breakout signal on a curve's tape at slot `now`. */
  const breakSignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.breakMinRq || rqSol > p.breakMaxRq) return false;
    if (t.created === null || now - t.created < p.breakMinAge) return false;
    if (now - t.created > p.breakMaxAge) return false;
    const from = now - p.breakWindow;
    const mid = now - p.breakWindow / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let surge = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.slot > now - p.breakSurgeSlots) surge++;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.breakMinBuys || byUser.size < p.breakMinBuyers) return false;
    if (surge < p.breakSurgeTrades) return false;
    const net = buySol - sellSol;
    if (net < p.breakMinNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.breakMinUp || up > p.breakMaxUp) return false;
    if (last < high * p.breakNearHigh) return false;
    if (netNew <= 0 || netNew < netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > 0.6 * buySol) return false;
    return true;
  };

  /** Dip signal on a curve's tape at slot `now`. Returns the recent high or 0. */
  const dipSignal = (t: Tape, now: number): number => {
    if (t.created === null || now - t.created < p.dipMinAge) return 0;
    let high = 0;
    let last = 0;
    for (const tr of t.trades) {
      if (tr.slot <= now - p.dipHighWindow) continue;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (high <= 0 || last <= 0) return 0;
    const dd = 1 - last / high;
    if (dd < p.dipMin || dd > p.dipMax) return 0;
    const n = Math.min(p.dipFlowTrades, t.trades.length);
    let buys = 0;
    let net = 0;
    let lastIsBuy = false;
    for (let i = t.trades.length - n; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      if (tr.buy) buys++;
      net += tr.buy ? tr.sol : -tr.sol;
      lastIsBuy = tr.buy;
    }
    if (buys < p.dipMinBuys) return 0;
    if (net < p.dipMinNetSol) return 0;
    if (!lastIsBuy) return 0;
    return high;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && h.leg === 'break' && value >= cost * (1 + p.breakTakeProfit)) exit = true;
        if (!exit && h.leg === 'dip') {
          const target = h.entryPrice + p.dipRecover * (h.entryHigh - h.entryPrice);
          const price = vq / vt;
          if (price >= target) exit = true;
        }
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let leg: Leg = 'break';
        let entryHigh = 0;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (breakSignal(t, now, rqSol)) {
            leg = 'break';
          } else {
            const high = dipSignal(t, now);
            if (high <= 0) continue;
            leg = 'dip';
            entryHigh = high;
          }
          want = Math.min(p.firstSol, p.maxPosSol);
        } else {
          // Pyramid into strength only: the position is up, the price stepped up from the
          // last add, and net SOL still flows in.
          if (!p.pyramid || h.exiting || !h.filled || h.invested >= p.maxPosSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (flow(t, now, p.breakWindow) < p.breakMinNetSol) continue;
          if (rqSol > p.breakMaxRq) continue;
          leg = h.leg;
          entryHigh = h.entryHigh;
          want = Math.min(p.addSol, p.maxPosSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, leg, entryPrice: price, entryHigh });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
