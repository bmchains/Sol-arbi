const test=require('node:test')
const assert=require('node:assert/strict')
const {principal,fee}=require('./bot.cjs')
test('USDC ceiling and exact integer conversion',()=>{
  assert.equal(principal('10000000'),10000000000000n)
  for(const invalid of ['0','-1','1e6','10000001']) assert.throws(()=>principal(invalid))
})
test('fee bound includes rounding and disabled sentinel',()=>{
  assert.equal(fee(100n,0n),0n)
  assert.equal(fee(1000000n,3000000000000000n),3002n)
  assert.throws(()=>fee(1n,18446744073709551615n))
})
