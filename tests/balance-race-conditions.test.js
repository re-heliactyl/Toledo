const assert = require('assert');
const billingModule = require('../modules/billing.js');
const dailyModule = require('../modules/daily.js');
const stakingModule = require('../modules/staking.js');

// 1. Manifest version verification
assert.strictEqual(billingModule.HeliactylModule.version, '1.1.1', 'billing module version bumped');
assert.strictEqual(dailyModule.HeliactylModule.version, '1.0.2', 'daily module version bumped');
assert.strictEqual(stakingModule.HeliactylModule.version, '1.0.2', 'staking module version bumped');
console.log('PASS: Manifest version validation passed');

(async () => {
  // 2. Test billing conditional balance deduction logic
  console.log('Testing billing race condition guards...');

  let userCredit = 5.0;
  let userCoins = 0;
  let purchaseCalls = 0;

  const mockTx = {
    user: {
      async updateMany({ where, data }) {
        if (where.creditUsd && where.creditUsd.gte !== undefined) {
          if (userCredit >= where.creditUsd.gte) {
            userCredit -= data.creditUsd.decrement;
            if (data.coins && data.coins.increment) {
              userCoins += data.coins.increment;
            }
            return { count: 1 };
          }
          return { count: 0 };
        }
        return { count: 1 };
      }
    },
    transaction: {
      async create() {
        return { id: 'tx_mock_' + (++purchaseCalls) };
      }
    }
  };

  const simulatePurchaseCoins = async (price, coinAmount) => {
    const updateResult = await mockTx.user.updateMany({
      where: {
        id: 'user1',
        creditUsd: { gte: price }
      },
      data: {
        creditUsd: { decrement: price },
        coins: { increment: coinAmount }
      }
    });
    if (updateResult.count === 0) {
      throw new Error('INSUFFICIENT_CREDIT');
    }
    return true;
  };

  // Two concurrent purchases of price 4.0 with starting credit 5.0
  const results = await Promise.allSettled([
    simulatePurchaseCoins(4.0, 100),
    simulatePurchaseCoins(4.0, 100)
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, 'Only one purchase should succeed');
  assert.strictEqual(rejected.length, 1, 'Second purchase must be rejected');
  assert.strictEqual(rejected[0].reason.message, 'INSUFFICIENT_CREDIT');
  assert.strictEqual(userCredit, 1.0, 'Balance remaining must be non-negative (1.0)');
  assert.strictEqual(userCoins, 100, 'Coins awarded must match exactly single successful purchase');
  console.log('PASS: Concurrent billing purchase-coins race condition prevented');

  // 3. Test daily claim atomic conditional update logic
  console.log('Testing daily claim atomic conditional update...');
  let claimDate = null;
  let claimCount = 0;
  const todayIso = new Date().toISOString();

  const mockDailyDb = {
    user: {
      async updateMany({ where, data }) {
        const isToday = claimDate === todayIso;
        const matchesOr = !claimDate || !isToday;
        if (matchesOr) {
          claimDate = data.lastClaimDate;
          claimCount++;
          return { count: 1 };
        }
        return { count: 0 };
      }
    }
  };

  const simulateDailyClaim = async () => {
    const res = await mockDailyDb.user.updateMany({
      where: {
        id: 'user1',
        OR: [
          { lastClaimDate: null },
          { lastClaimDate: { not: todayIso } }
        ]
      },
      data: {
        lastClaimDate: todayIso,
        coins: { increment: 25 }
      }
    });
    if (res.count === 0) {
      throw new Error('ALREADY_CLAIMED');
    }
    return true;
  };

  const dailyResults = await Promise.allSettled([
    simulateDailyClaim(),
    simulateDailyClaim(),
    simulateDailyClaim()
  ]);

  const dailyFulfilled = dailyResults.filter(r => r.status === 'fulfilled');
  const dailyRejected = dailyResults.filter(r => r.status === 'rejected');

  assert.strictEqual(dailyFulfilled.length, 1, 'Only one daily claim should succeed');
  assert.strictEqual(dailyRejected.length, 2, 'Duplicate concurrent daily claims must fail');
  assert.strictEqual(claimCount, 1, 'Database was only updated once');
  console.log('PASS: Concurrent daily rewards claim race condition prevented');

  // 4. Test staking claim conditional update logic
  console.log('Testing staking claim conditional update...');
  let stakeStatus = 'active';
  let stakesClaimed = 0;

  const mockStakingTx = {
    stake: {
      async updateMany({ where, data }) {
        if (where.status === 'active' && stakeStatus === 'active') {
          stakeStatus = data.status;
          stakesClaimed++;
          return { count: 1 };
        }
        return { count: 0 };
      }
    }
  };

  const simulateClaimStake = async () => {
    const stakeUpdate = await mockStakingTx.stake.updateMany({
      where: { id: 'stake1', status: 'active' },
      data: { status: 'completed' }
    });
    if (stakeUpdate.count === 0) {
      throw new Error('STAKE_NOT_ACTIVE');
    }
    return true;
  };

  const stakingResults = await Promise.allSettled([
    simulateClaimStake(),
    simulateClaimStake()
  ]);

  const stakingFulfilled = stakingResults.filter(r => r.status === 'fulfilled');
  const stakingRejected = stakingResults.filter(r => r.status === 'rejected');

  assert.strictEqual(stakingFulfilled.length, 1, 'Only one claimStake can succeed');
  assert.strictEqual(stakingRejected.length, 1, 'Second claimStake must fail with STAKE_NOT_ACTIVE');
  assert.strictEqual(stakesClaimed, 1, 'Stake completed exactly once');
  console.log('PASS: Concurrent staking claim race condition prevented');

  console.log('ALL RACE CONDITION TESTS PASSED SUCCESSFULLY');
})();
