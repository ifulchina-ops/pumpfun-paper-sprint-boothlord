[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ifulchina-ops/pumpfun-paper-sprint-boothlord/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ifulchina-ops/pumpfun-paper-sprint-boothlord/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# QuickFlip — Pump.fun Paper Sprint

A minimal deterministic paper-trading bot for the
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
competition on [make.fun](https://make.fun). It paper-trades pump.fun
bonding curves on a replayed 6-hour window; no real funds are ever involved.

## Strategy

- Buy each new coin once, early, for a fixed 0.05 SOL stake — but only once
  the curve shows real early buyers (a size cap of at least 0.025 SOL, i.e.
  2.5 SOL of real reserve), so stillborn curves are skipped.
- Sell the whole position when it is up 15%, down 10%, or has been held for
  60 slots — whichever comes first.
- At most 5 open positions, so the maximum drawdown stays far under the 50%
  guardrail.

## Determinism

The bot never reads the clock, the environment, or `Math.random`. Every
decision is a pure function of the `hello` caps and the `batch` stream, so
the two grading executions produce identical action logs.

## Layout

- `main.ts` — the strategy (Node 22, run as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored
  byte-identical from the competition kit.
- `.makefun/owner.json` — the payout wallet claim file.

## License

0BSD — see [LICENSE](LICENSE).
