import { parseAbi, parseAbiItem, toEventSelector } from 'viem';

/**
 * Every ABI the pool scan reads (Phase 3 R4). Signatures are copied from the Aero sources the scoping measured with
 * (dromos-labs metadex-public V3/src and metadex-slipstream-public contracts, as read in
 * phase3-r4-scoping/onchain-revenue.md §5-§6, incentives-and-events.md §1, scripts/measure.py and scripts/poolenum.py).
 * Nothing Aero-specific beyond these ABIs lives in the engine: every address comes from the scan config.
 */

/** V2 and CL pool factories (IPoolFactory / ICLFactory). */
export const FACTORY_ABI = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256 index) view returns (address)',
  /** V2 factories (IPoolFactory.poolTape). */
  'function poolTape() view returns (address)',
  /** CL factories (ICLFactory.clPoolTape). */
  'function clPoolTape() view returns (address)',
  /** CL factories: the swap hook that records a CL pool's fees on the tape (CLFactory.getPoolSwapHook). */
  'function getPoolSwapHook(address _pool) view returns (address)',
]);

/** Both pool kinds' token getters (poolenum.py reads them the same way on V2 and CL pools). */
export const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  /** V2 Pool.pendingFees(_account): the raw fees owed to the gauge, before any gauge-side gating. */
  'function pendingFees(address _account) view returns (uint256 _amount0, uint256 _amount1)',
  /** CL pool public `GaugeFees gaugeFees` (ICLPoolState.gaugeFees). */
  'function gaugeFees() view returns (uint128 token0, uint128 token1)',
]);

/**
 * PoolTape (V2): the public `accumulators` mapping returns 10 values (IPoolTape.sol); the scan reads cumulativeFee0/1 and
 * lastSwapTimestamp. Registration: BasePoolTape.allowedCaller(pool), 0 = not registered (onchain-revenue.md §4).
 */
export const POOL_TAPE_ABI = parseAbi([
  'function accumulators(address _pool) view returns (uint128 cumulativeFee0, uint128 cumulativeFee1, uint128 cumulativeVolume0, uint128 cumulativeVolume1, uint128 cumulativeMevVolume0, uint128 cumulativeMevVolume1, uint128 cumulativeMevFee0, uint128 cumulativeMevFee1, uint48 lastSwapTimestamp, uint48 swapCount)',
  'function allowedCaller(address _pool) view returns (address _caller)',
]);

/** CLPoolTape: `accumulators` returns the 20-field Accumulator struct (ICLPoolTape.sol), fields in storage order. */
export const CL_POOL_TAPE_ABI = parseAbi([
  'struct Accumulator { uint40 lastSwapTimestamp; uint40 lastObservationTimestamp; uint32 swapCount; int24 lastTick; int24 intervalMaxTick; int24 intervalMinTick; int24 intervalOpenTick; uint48 volatilityCorrob; uint120 cumulativeVolume0; uint120 cumulativeVolume1; uint16 intervalSwapCount; uint120 cumulativeFee0; uint120 cumulativeFee1; uint8 volatilityRingHead; uint8 volatilityRingCount; uint120 cumulativeMevVolume0; uint120 cumulativeMevVolume1; uint8 nOver; uint120 cumulativeMevFee0; uint120 cumulativeMevFee1; }',
  'function accumulators(address _pool) view returns (Accumulator _accumulator)',
  'function allowedCaller(address _pool) view returns (address _caller)',
]);

/** FactoryRegistry (IFactoryRegistry.sol): the pool factories, gauge factories, each one's gauges, each gauge's pool. */
export const FACTORY_REGISTRY_ABI = parseAbi([
  'function targetFactories() view returns (address[] _factories)',
  'function gaugeFactories() view returns (address[] _factories)',
  'function factoryToGauges(address _factory) view returns (address[] _gauges)',
  'function gaugeToTarget(address _gauge) view returns (address _target)',
]);

/** V2Gauge / CLGauge (IGauge.votingRewardsManager): the VRM that emits the gauge's FeesCollected. */
export const GAUGE_ABI = parseAbi(['function votingRewardsManager() view returns (address)']);

/** The root Voter on Base (IVoter.chains / VoterStorageBase.chains). */
export const ROOT_VOTER_ABI = parseAbi(['function chains() view returns (uint256[] _chainIds)']);

/**
 * Pricing reads (pricing.ts). CL: slot0 (ICLPoolState.slot0) and observe (ICLPoolDerivedState.observe) from
 * metadex-slipstream-public; V2: Pool.getReserves from metadex-public V3/src/pools/Pool.sol. The scoping read the same
 * three (scripts/measure.py) plus `balanceOf(pool)` of both tokens. viem decodes slot0's sqrtPriceX96 and observe's
 * int56 tickCumulatives as bigint.
 */
export const CL_POOL_PRICE_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
]);
export const V2_POOL_PRICE_ABI = parseAbi(['function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)']);

/** ERC-20 reads (viem's erc20Abi): a token's decimals and a pool's balance of it. */
export const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

/**
 * Chainlink AggregatorV3Interface (the feed proxy): latestRoundData as src/prices/evmMethods.ts reads it, plus the
 * `description()` and `decimals()` the scoping read on every anchor feed (onchain-revenue.md §3.1).
 */
export const CHAINLINK_FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Multicall3 (same address on all 8 chains, `eth_getCode` MEASURED, onchain-revenue.md §10; viem's chain config).
 * `getCurrentBlockTimestamp()` (viem's multicall3Abi) at e−1 gives that block's timestamp: feed staleness is measured
 * at it, and Elysium's cross-chain anchors find their Base block from it.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256 timestamp)']);

/**
 * IVotingRewardsManager `FeesCollected(address indexed _gauge, address indexed _token, uint256 _amount)`, emitted by the
 * VRM when it collects its gauge's fees (VotingRewardsManager.sol). measure.py keys it by (log address = VRM, topics[2] =
 * token) and reads the amount from the first data word.
 */
export const FEES_COLLECTED_EVENT = parseAbiItem('event FeesCollected(address indexed _gauge, address indexed _token, uint256 _amount)');
export const FEES_COLLECTED_TOPIC = toEventSelector(FEES_COLLECTED_EVENT);
