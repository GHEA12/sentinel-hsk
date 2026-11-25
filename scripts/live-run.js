'use strict';

// Sentinel — testnet deploy + live-run script (HashKey Chain testnet, 133).
//
// WHAT IT DOES
//   1. Loads (or generates) throwaway TESTNET-ONLY owner/agent keys in
//      scripts/.env (gitignored, mode 600).
//   2. Funding gate: the owner wallet needs a little testnet HSK for gas.
//      The only source is the official faucet (https://faucet.hsk.xyz,
//      1 HSK / address / 24h, browser + Google reCAPTCHA) — if the balance
//      is short, this script prints the address to drip and exits (code 2).
//   3. Deploys SentinelGuard (SwapRouter02 + QuoterV2, chain 133 addresses),
//      sets demo risk caps, tops up the agent with gas.
//   4. Funds the guard and runs guarded swaps through the guard contract:
//        default mode: the real HSKSwap USDT/WHSK fee-500 pool.
//          - If the owner holds test USDT, it funds the guard with USDT and
//            BUYs WHSK, then SELLs half the position back.
//          - Otherwise it wraps native HSK into WHSK, funds the guard with
//            WHSK, SELLs into USDT, then BUYs back with part of the proceeds.
//        --mock-pool: deploys two MockERC20s, creates + initializes a V3
//          pool via the HSKSwap Factory, seeds liquidity via the NFPM, and
//          trades against that instead (full control of liquidity).
//   5. Prints every tx hash, the guard's dayStats/position, and a ready-to-
//      paste agent/.env block.
//
// SAFETY
//   - Hard-refuses to run on any chain other than 133, and refuses RPC URLs
//     containing "mainnet". There is no mainnet path in this script.
//   - Keys are random throwaway testnet keys generated locally; they are
//     never the user's wallets.
//
// Usage:
//   node scripts/live-run.js              # real USDT/WHSK pool (fee 500)
//   node scripts/live-run.js --mock-pool  # self-deployed mock pool (fee 3000)

const fs = require('fs');
const path = require('path');
// ethers is the agent's single dependency; resolve it from agent/node_modules
// (run `npm install` in agent/ first if this require fails).
const { ethers } = require(path.join(__dirname, '..', 'agent', 'node_modules', 'ethers'));

const CHAIN_ID = 133;
const RPC_URL = process.env.RPC_URL || 'https://testnet.hsk.xyz';

// HSKSwap V3, testnet (133) — verified in ../RESEARCH.md.
const ROUTER = '0xa6914E66690c6794244B5f66a09eAEbf66254237';
const QUOTER = '0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC';
const FACTORY = '0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0';
const NFPM = '0x73dEc6bfa6751509b08480bd97f54b874E3b20e8';
const USDT = '0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f'; // 18 dp on testnet
const WHSK = '0xca8aaceec5db1e91b9ed3a344ba026c4a2b3ebf6'; // 18 dp
const POOL_FEE = 500;

const ENV_PATH = path.join(__dirname, '.env');
const BUILD_DIR = path.join(__dirname, '..', 'contracts', 'build');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const WHSK_ABI = [...ERC20_ABI, 'function deposit() payable', 'function withdraw(uint256)'];
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
];
const FACTORY_ABI = [
  'function getPool(address,address,uint24) view returns (address)',
  'function createPool(address,address,uint24) returns (address)',
];
const POOL_ABI = ['function initialize(uint160 sqrtPriceX96)'];
const NFPM_ABI = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];
const GUARD_ABI = [
  'function executeSwap(address tokenIn, address tokenOut, uint24 feeTier, uint256 amountIn, uint256 amountOutMin) returns (uint256)',
  'function setRiskParams(uint256,uint256,uint256,uint256)',
  'function dailyVolumeCapQuote() view returns (uint256)',
  'function dayStats() view returns (uint256 volumeQuote, int256 realizedPnlQuote)',
  'function getPosition(address) view returns (uint256 amount, uint256 costQuote)',
  'function paused() view returns (bool)',
  'function halted() view returns (bool)',
  'event TradeExecuted(address indexed tokenIn, address indexed tokenOut, uint24 feeTier, uint256 amountIn, uint256 amountOut, uint256 notionalQuote, int256 dayRealizedPnlQuote)',
];

// ---------------------------------------------------------------- env / keys

function loadEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function saveEnvFile(values) {
  const lines = [
    '# Sentinel live-run keys — TESTNET (chain 133) ONLY. Throwaway keys,',
    '# generated locally by scripts/live-run.js. Gitignored. Never fund these',
    '# addresses with mainnet assets.',
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    '',
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

function ensureKeys() {
  const env = loadEnvFile();
  let changed = false;
  if (!env.OWNER_PRIVATE_KEY) { env.OWNER_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey; changed = true; }
  if (!env.AGENT_PRIVATE_KEY) { env.AGENT_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey; changed = true; }
  if (changed) saveEnvFile(env);
  return env;
}

// ------------------------------------------------------------------- helpers

function artifact(name) {
  const abi = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, `${name}.abi`), 'utf8'));
  const bin = fs.readFileSync(path.join(BUILD_DIR, `${name}.bin`), 'utf8').trim();
  return { abi, bin };
}

async function send(label, txPromise) {
  const tx = await txPromise;
  console.log(`  ${label}: sent ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  ${label}: confirmed in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);
  return receipt;
}

async function quoteOut(quoter, tokenIn, tokenOut, amountIn, fee) {
  const res = await quoter.quoteExactInputSingle.staticCall({
    tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
  });
  return res[0];
}

function minOut(quoted, slippageBps = 100n) {
  return (quoted * (10_000n - slippageBps)) / 10_000n;
}

async function guardedSwap({ guardAgent, quoter, tokenIn, tokenOut, fee, amountIn, label }) {
  const quoted = await quoteOut(quoter, tokenIn, tokenOut, amountIn, fee);
  const out = minOut(quoted);
  console.log(`  ${label}: amountIn=${amountIn} quotedOut=${quoted} amountOutMin=${out}`);
  const receipt = await send(label, guardAgent.executeSwap(tokenIn, tokenOut, fee, amountIn, out));
  const ev = receipt.logs
    .map((l) => { try { return guardAgent.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === 'TradeExecuted');
  if (ev) console.log(`  ${label}: TradeExecuted amountOut=${ev.args.amountOut} notionalQuote=${ev.args.notionalQuote} dayPnl=${ev.args.dayRealizedPnlQuote}`);
  return receipt;
}

// ---------------------------------------------------------------------- main

async function main() {
  const mockMode = process.argv.includes('--mock-pool');

  if (/mainnet/i.test(RPC_URL)) {
    console.error('REFUSING: RPC_URL points at mainnet. This script is testnet-only.');
    process.exit(1);
  }

  const env = ensureKeys();
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    console.error(`REFUSING: expected chain ${CHAIN_ID}, RPC reports ${network.chainId}.`);
    process.exit(1);
  }
  console.log(`[live-run] chain ${network.chainId} via ${RPC_URL} (mode: ${mockMode ? 'mock-pool' : 'real USDT/WHSK pool'})`);

  const owner = new ethers.Wallet(env.OWNER_PRIVATE_KEY, provider);
  const agent = new ethers.Wallet(env.AGENT_PRIVATE_KEY, provider);
  console.log(`[live-run] owner ${owner.address}`);
  console.log(`[live-run] agent ${agent.address}`);

  // ------------------------------------------------------------ funding gate
  const ownerBal = await provider.getBalance(owner.address);
  const agentBal = await provider.getBalance(agent.address);
  console.log(`[live-run] balances: owner ${ethers.formatEther(ownerBal)} HSK | agent ${ethers.formatEther(agentBal)} HSK`);
  const MIN_OWNER = ethers.parseEther('0.085');
  if (ownerBal < MIN_OWNER) {
    console.log(`
FUNDING GATE — not enough testnet HSK yet.
  1. Open https://faucet.hsk.xyz (browser; Google reCAPTCHA; 1 HSK / address / 24h)
  2. Request a drip to the OWNER address:  ${owner.address}
  3. Re-run this script. It will top up the agent, deploy, and trade.
No transactions were sent.`);
    process.exit(2);
  }
  if (agentBal < ethers.parseEther('0.005')) {
    await send('agent gas top-up', owner.sendTransaction({ to: agent.address, value: ethers.parseEther('0.015') }));
  }

  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);

  // ------------------------------------------------------------ mock-pool setup
  let quoteToken = USDT;
  let tradeToken = WHSK;
  let fee = POOL_FEE;
  if (mockMode) {
    fee = 3000;
    const mock = artifact('mocks_MockERC20_sol_MockERC20');
    const mockFactory = new ethers.ContractFactory(mock.abi, mock.bin, owner);
    console.log('[live-run] deploying mock tokens…');
    const susd = await mockFactory.deploy('Sentinel Quote', 'SUSD', 18);
    await susd.waitForDeployment();
    const sast = await mockFactory.deploy('Sentinel Asset', 'SAST', 18);
    await sast.waitForDeployment();
    quoteToken = await susd.getAddress();
    tradeToken = await sast.getAddress();
    console.log(`  SUSD ${quoteToken}\n  SAST ${tradeToken}`);
    const mintAmt = ethers.parseUnits('100000', 18);
    await send('mint SUSD', susd.mint(owner.address, mintAmt));
    await send('mint SAST', sast.mint(owner.address, mintAmt));

    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, owner);
    let poolAddr = await factory.getPool(quoteToken, tradeToken, fee);
    if (poolAddr === ethers.ZeroAddress) {
      const r = await send('factory.createPool', factory.createPool(quoteToken, tradeToken, fee));
      poolAddr = await factory.getPool(quoteToken, tradeToken, fee);
      console.log(`  pool created: ${poolAddr} (tx ${r.hash})`);
      const pool = new ethers.Contract(poolAddr, POOL_ABI, owner);
      // Price 1.0 (both tokens 18 dp): sqrtPriceX96 = 2^96.
      await send('pool.initialize', pool.initialize(79228162514264337593543950336n));
    } else {
      console.log(`  pool already exists: ${poolAddr}`);
    }
    const [t0, t1] = quoteToken.toLowerCase() < tradeToken.toLowerCase()
      ? [quoteToken, tradeToken] : [tradeToken, quoteToken];
    const liqAmt = ethers.parseUnits('10000', 18);
    const susdC = new ethers.Contract(quoteToken, ERC20_ABI, owner);
    const sastC = new ethers.Contract(tradeToken, ERC20_ABI, owner);
    await send('approve NFPM (quote)', susdC.approve(NFPM, liqAmt));
    await send('approve NFPM (trade)', sastC.approve(NFPM, liqAmt));
    const nfpm = new ethers.Contract(NFPM, NFPM_ABI, owner);
    await send('nfpm.mint (seed liquidity)', nfpm.mint({
      token0: t0, token1: t1, fee,
      tickLower: -887220, tickUpper: 887220,
      amount0Desired: liqAmt, amount1Desired: liqAmt,
      amount0Min: 0, amount1Min: 0,
      recipient: owner.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    }));
  }

  // ------------------------------------------------------------ guard deploy
  let guardAddress = env.GUARD_ADDRESS;
  if (!guardAddress) {
    const g = artifact('SentinelGuard_sol_SentinelGuard');
    const guardFactory = new ethers.ContractFactory(g.abi, g.bin, owner);
    console.log('[live-run] deploying SentinelGuard…');
    const guard = await guardFactory.deploy(ROUTER, QUOTER, quoteToken, agent.address);
    await guard.waitForDeployment();
    guardAddress = await guard.getAddress();
    env.GUARD_ADDRESS = guardAddress;
    saveEnvFile(env);
    console.log(`  SentinelGuard deployed: ${guardAddress} (deploy tx ${guard.deploymentTransaction().hash})`);
  } else {
    console.log(`[live-run] reusing SentinelGuard at ${guardAddress}`);
  }
  const guardOwner = new ethers.Contract(guardAddress, GUARD_ABI, owner);
  const guardAgent = new ethers.Contract(guardAddress, GUARD_ABI, agent);

  if ((await guardOwner.dailyVolumeCapQuote()) === 0n) {
    // Demo caps, in raw token units (both tokens are 18 dp here).
    const scale = mockMode ? 100n : 1n;
    await send('guard.setRiskParams', guardOwner.setRiskParams(
      ethers.parseUnits('10', 18) * scale,   // per-trade cap (input-token units)
      ethers.parseUnits('500', 18) * scale,  // daily volume cap (quote units)
      ethers.parseUnits('100', 18) * scale,  // daily loss cap (quote units)
      100                                     // max slippage bps (1%)
    ));
  }

  // ------------------------------------------------------------ fund + trade
  const quote = new ethers.Contract(quoteToken, ERC20_ABI, owner);
  const trade = new ethers.Contract(tradeToken, mockMode ? ERC20_ABI : WHSK_ABI, owner);

  if (mockMode) {
    await send('fund guard (1000 SUSD)', quote.transfer(guardAddress, ethers.parseUnits('1000', 18)));
    await guardedSwap({ guardAgent, quoter, tokenIn: quoteToken, tokenOut: tradeToken, fee, amountIn: ethers.parseUnits('100', 18), label: 'BUY 100 SUSD -> SAST' });
    await guardedSwap({ guardAgent, quoter, tokenIn: tradeToken, tokenOut: quoteToken, fee, amountIn: ethers.parseUnits('50', 18), label: 'SELL 50 SAST -> SUSD' });
  } else {
    const ownerUsdt = await quote.balanceOf(owner.address);
    if (ownerUsdt >= ethers.parseUnits('5', 18)) {
      await send('fund guard (5 USDT)', quote.transfer(guardAddress, ethers.parseUnits('5', 18)));
      await guardedSwap({ guardAgent, quoter, tokenIn: USDT, tokenOut: WHSK, fee, amountIn: ethers.parseUnits('1', 18), label: 'BUY 1 USDT -> WHSK' });
      const [pos] = await guardAgent.getPosition(WHSK);
      if (pos > 0n) {
        await guardedSwap({ guardAgent, quoter, tokenIn: WHSK, tokenOut: USDT, fee, amountIn: pos / 2n, label: 'SELL half WHSK position -> USDT' });
      }
    } else {
      console.log('[live-run] owner holds no test USDT — wrap path: wrap 0.06 HSK, fund guard with WHSK, sell first.');
      const whsk = new ethers.Contract(WHSK, WHSK_ABI, owner);
      await send('WHSK.deposit (wrap 0.05 HSK)', whsk.deposit({ value: ethers.parseEther('0.05') }));
      await send('fund guard (0.04 WHSK)', whsk.transfer(guardAddress, ethers.parseEther('0.04')));
      await guardedSwap({ guardAgent, quoter, tokenIn: WHSK, tokenOut: USDT, fee, amountIn: ethers.parseEther('0.01'), label: 'SELL 0.01 WHSK -> USDT' });
      const guardUsdt = await quote.balanceOf(guardAddress);
      if (guardUsdt >= ethers.parseUnits('0.5', 18)) {
        await guardedSwap({ guardAgent, quoter, tokenIn: USDT, tokenOut: WHSK, fee, amountIn: ethers.parseUnits('0.5', 18), label: 'BUY 0.5 USDT -> WHSK' });
      }
    }
  }

  // --------------------------------------------------------------- reporting
  const [vol, pnl] = await guardOwner.dayStats();
  const [posAmt, posCost] = await guardOwner.getPosition(tradeToken);
  console.log(`
[live-run] DONE
  guard:        ${guardAddress}
  day volume:   ${vol} (quote raw)
  day PnL:      ${pnl} (quote raw)
  position:     amount=${posAmt} costQuote=${posCost} (${tradeToken})
  paused/halted: ${await guardOwner.paused()} / ${await guardOwner.halted()}

Paste into agent/.env to run the agent loop against this deployment:
  RPC_URL=${RPC_URL}
  CHAIN_ID=133
  GUARD_ADDRESS=${guardAddress}
  ROUTER_ADDRESS=${ROUTER}
  QUOTER_ADDRESS=${QUOTER}
  QUOTE_TOKEN=${quoteToken}
  TRADE_TOKEN=${tradeToken}
  QUOTE_DECIMALS=18
  TRADE_DECIMALS=18
  FEE_TIER=${fee}
  AGENT_PRIVATE_KEY=<the AGENT_PRIVATE_KEY from scripts/.env>
  DRY_RUN=true`);
}

main().catch((err) => {
  console.error('[live-run] fatal:', err.shortMessage || err.message || err);
  process.exit(1);
});
