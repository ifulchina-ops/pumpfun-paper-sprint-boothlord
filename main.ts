// QuickFlip: a small deterministic paper-trading bot for the pump.fun replay.
//
// The harness speaks agent-fun/replay/v2: it sends one hello, then one batch
// per slot, then done. Every batch carries the slot's events, the marks of the
// curves we touch, the fills of our orders, and the account after those fills.
// We answer each batch with one reply holding our orders for that slot.
//
// Strategy, in one paragraph: buy each new coin once, early, for a fixed stake
// (0.05 SOL when the size cap allows it), but only once the curve shows real
// early buyers — a size cap of at least 0.025 SOL, i.e. 2.5 SOL of real
// reserve. Then flip it fast: a position is sold in full as soon as it is up
// 15%, down 10%, or has been held 60 slots. Nothing here reads the clock, the
// environment, or Math.random: the same hello and the same batches always
// produce the same orders, so the two grading executions agree byte for byte.
//
// Guardrails this bot is built to meet: at least 20 distinct coins round
// tripped at 0.01 SOL or more each, and a maximum drawdown far under 50%
// (at most 5 open positions of 0.05 SOL against 10 SOL of capital).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL spent on one coin when the size cap allows the full stake. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
/** A buy smaller than this does not count toward the 20-coin round-trip bar. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/**
 * A coin is only bought once its size cap reaches this: a cap of 0.025 SOL
 * means 2.5 SOL of real reserve, i.e. real early buyers, not a stillborn
 * curve. This selectivity is what keeps the fee bleed down — v1 bought at
 * 0.01 SOL and round-tripped 711 coins for -1.37 SOL on the dev window.
 */
const ENTRY_MIN_CAP_LAMPORTS = LAMPORTS_PER_SOL / 40n; // 0.025 SOL
/** Take profit when the mark is at least this many bps above the entry price. */
const TAKE_PROFIT_BPS = 1500; // +15%
/** Stop loss when the mark is at least this many bps below the entry price. */
const STOP_LOSS_BPS = 1000; // -10%
/** Sell whatever is left after this many slots held, win or lose. */
const MAX_HOLD_SLOTS = 60;
/** A candidate that never reaches a tradeable size is dropped after this long. */
const CANDIDATE_MAX_AGE_SLOTS = 600;
/** Slippage left wide open so an exit is never refused for the price moving. */
const MAX_SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------------ memory

/** Coins created and not yet decided (bought once, or skipped for good). */
const candidates = new Set<string>();
/** Coins already bought once: never buy the same coin twice. */
const decided = new Set<string>();
/** Decision slot of each buy we sent, so the hold clock is deterministic. */
const buySlot = new Map<string, number>();

/**
 * Compare the mark price against the entry price without any division:
 * mark = curve.virtual_quote_reserves / curve.virtual_token_reserves,
 * entry = position.cost_lamports / position.token_amount.
 * Returns the mark in bps of the entry (10000 = exactly the entry price).
 */
function markBpsOfEntry(
  quoteReserves: bigint,
  tokenReserves: bigint,
  costLamports: bigint,
  tokenAmount: bigint,
): bigint {
  if (tokenReserves === 0n || tokenAmount === 0n || costLamports === 0n) return 10_000n;
  return (quoteReserves * tokenAmount * 10_000n) / (tokenReserves * costLamports);
}

await runBot({
  onHello(state) {
    const { caps, capital } = state.hello;
    console.error(
      `quickflip: hello received; capital ${capital.lamports} lamports, ` +
        `max ${caps.max_open_positions} open positions, ` +
        `max ${caps.max_orders_per_batch} orders per batch, ` +
        `stake ${STAKE_LAMPORTS} lamports`,
    );
  },

  onBatch(state: BotState, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // ---- housekeeping from the fills this batch reports ------------------
    // A buy that never filled frees its coin for the record (it stays
    // decided: one attempt per coin, win or lose). A filled sell closes the
    // hold clock for that coin.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status !== 'filled') buySlot.delete(fill.mint);
      if (fill.side === 'sell' && fill.status === 'filled') buySlot.delete(fill.mint);
    }
    // Mints with a sell already in flight must not get a second sell order.
    const selling = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') selling.add(pending.order.mint);
    }

    // ---- exits first: take profit, stop loss, or the hold clock ---------
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const mark = markBpsOfEntry(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        holding.cost_lamports,
        holding.token_amount,
      );
      const held = buySlot.has(mint) ? batch.slot - (buySlot.get(mint) as number) : 0;
      const takeProfit = mark >= 10_000n + BigInt(TAKE_PROFIT_BPS);
      const stopLoss = mark <= 10_000n - BigInt(STOP_LOSS_BPS);
      const timedOut = held >= MAX_HOLD_SLOTS;
      if (!takeProfit && !stopLoss && !timedOut) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
    }

    // ---- entries: new coins get one decision each -----------------------
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const room = (): boolean => orders.length < caps.max_orders_per_batch;

    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!decided.has(event.mint)) candidates.add(event.mint);
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      if (!candidates.has(event.mint)) continue;
      const curve = state.curves.get(event.mint);
      if (curve === undefined) continue;
      // A completed curve, or one that sat too long without tradeable size,
      // is dropped: the decision is made once, on the first batch where the
      // size cap lets us buy a meaningful amount.
      const age = curve.created_slot === null ? 0 : batch.slot - curve.created_slot;
      if (curve.complete || age > CANDIDATE_MAX_AGE_SLOTS) {
        candidates.delete(event.mint);
        decided.add(event.mint);
        continue;
      }
      const cap = state.maxBuyLamports(event.mint);
      if (cap < ENTRY_MIN_CAP_LAMPORTS) continue;
      candidates.delete(event.mint);
      decided.add(event.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (!room() || slots <= 0 || free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint: event.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      buySlot.set(event.mint, batch.slot);
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
