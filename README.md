[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Humaedi95/sharpe-sprint-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Humaedi95/sharpe-sprint-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Sharpe Sprint Paper Bot

A paper-trading bot for the **Pump.fun Sharpe Sprint** bounty on make.fun.
It trades paper money on a 6-hour pump.fun replay and is ranked by **hourly
Sharpe ratio** — steady, controlled gains beat one lucky moonshot.

## Strategy

- **Diversify wide:** small equal-sized buys (~0.2 SOL) spread across many
  fresh mints, so the bot clears the 20-distinct-mint round-trip bar.
- **Enter on early momentum only:** a mint must show several trades, net buy
  pressure, and a modest rise (+4% to +60%) from its creation price. Never
  chase a coin that already ran far.
- **Tight risk control:** take-profit at +20% of cost, stop-loss at −8%,
  and a maximum hold of ~3,600 slots. At most 5 open positions at once.
- **Full exits:** every sell closes the whole position, so each trade counts
  as a clean round trip.

## Run

```sh
node main.ts
```

Node 22+, zero dependencies. The bot speaks the `agent-fun/replay/v2`
protocol on stdin/stdout via `vendor/makefun-bot.ts` (the kit's own shim,
copied verbatim). It is fully deterministic: no clock, no environment, no
`Math.random` — any randomness would be seeded only from `hello.seed`.
