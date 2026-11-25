# Sentinel — live testnet evidence (HSK Chain testnet, chain 133)

Run executed 2026-11-25 by `project/scripts/live-run.js` (real USDT/WHSK pool mode), verified independently by direct RPC reads (contract code present at the guard address; sell receipt status 0x1, block 36192530, 6 logs).

## Deployment

- SentinelGuard: `0x5cb71581A809df2794cfE0191802E32FFC5006f2`
  - Deploy tx: `0x4e1f4f5215322c08bb5c2e0a969a86f1e70be9714d2a37a874b0a244b2fe00a1`
  - setRiskParams tx: `0xb26dda405a032774f3587159ca110afcb999882fbaa8be660cc249328da98c84` (per-trade cap 10, daily volume cap 500, daily loss cap 100, max slippage 100 bps — quote-token units)
- Owner (throwaway testnet key): `0xcD3821db13150C1dBc3983f9FED00e990E612DC2`
- Agent (throwaway testnet key): `0x299CC3d59779acF5AfCaBd90390C2A406635e772`
- Pool: USDT/WHSK fee 500, `0xff2b7E501C870980Bf5641B4a70D0F9fb0f6f6ab` (HSKSwap V3, SwapRouter02 `0xa6914E66690c6794244B5f66a09eAEbf66254237`, QuoterV2 `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC`)

## Funding path (owner held no test USDT, so the wrap path ran)

- Agent gas top-up 0.015 HSK: `0x80e6160faf711f8845574a2457c8ee777511fc3ef426954928f0fa5551ffd35c`
- WHSK.deposit (wrap 0.05 HSK): `0xb8e51e461b93712da905e2306d6c9a2eaff6fb01f69927677c3db9a3eeba2ffc`
- Fund guard (0.04 WHSK): `0xea5713ea4c98977460a1de0c4566196c372713153881ac81d4d394a95932c759`

## Guarded trades (executed by the agent key, through the guard only)

1. SELL 0.01 WHSK → USDT: tx `0x086b288d0761144884d318747ede9e5a382584c4f3f81f5e5e847d21faae6706`, block 36192530
   - Quoted out 0.781814 USDT, amountOutMin 0.773996 USDT (1% rail), executed amountOut 0.781814 USDT
2. BUY 0.5 USDT → WHSK: tx `0x515c4e6d770c5abfc43f73b32b5a3a05081ea75f5ff7478ecc73b82d7ccbb345`, block 36192534
   - Executed amountOut 0.006389 WHSK

## End state (read back from the guard)

- Day volume: 1.281814 USDT (quote raw 1281814433891956701)
- Day realized PnL: +0.781814 USDT (from the opening sell's proceeds accounting)
- Open position: 0.006389 WHSK at average cost 0.5 USDT
- paused / halted: false / false

## Notes

- The faucet drip on this chain is 0.1 HSK per address (observed 2026-11-25), so the script's spend plan was trimmed to fit one drip (agent top-up 0.015, wrap 0.05).
- The dashboard (`project/dashboard/`) is configured with this guard address and renders its live state.
- Mainnet deployment is a separate, later step (hackathon requires it for demo eligibility and prize claim); it has NOT been done and needs the user's funding decision.
