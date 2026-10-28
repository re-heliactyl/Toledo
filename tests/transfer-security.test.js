// Server transfer security test
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validate, schemas } = require('../handlers/validate');

async function runTests() {
  console.log('=== Testing Server Transfer Removal & Dead Code Elimination ===');

  // Test 1: Verify serverTransfer schema has been completely removed from schemas
  {
    console.log('Test 1: Verify serverTransfer schema has been removed');
    assert.strictEqual(schemas.serverTransfer, undefined, 'serverTransfer schema must not exist');
    console.log('  Passed');
  }

  // Test 2: Verify files_transfer.js contains no transfer endpoints or dead helper functions
  {
    console.log('Test 2: Verify transfer endpoints and dead code removed from files_transfer.js');
    const moduleCode = fs.readFileSync(path.join(__dirname, '../modules/server/files_transfer.js'), 'utf8');
    assert.ok(!moduleCode.includes('/server/transfer'), 'Must not contain /server/transfer route');
    assert.ok(!moduleCode.includes('/server/:id/transfer'), 'Must not contain /server/:id/transfer route');
    assert.ok(!moduleCode.includes('manage/transfer'), 'Must not contain manage/transfer call');
    assert.ok(!moduleCode.includes('getAvailableAllocations'), 'Must not contain dead getAvailableAllocations helper');
    console.log('  Passed');
  }

  console.log('=== All Server Transfer removal tests passed! ===');
}

runTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
