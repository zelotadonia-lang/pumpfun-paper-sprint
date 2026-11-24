// surge-dip: a two-leg paper bot for the agent-fun pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte. DEFAULT_PARAMS are the V2 settings:
// tight stops, small size, fast exits — the variant that lost least on the dev window
// (net -0.78 SOL vs -9.45 for the house momentum pilot, -0.42 for its sniper).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
