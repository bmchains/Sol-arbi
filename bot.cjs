const http = require('node:http')
const fs = require('node:fs')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const {parseReserve} = require('@solendprotocol/solend-sdk/state/reserve')
const {flashBorrowReserveLiquidityInstruction: borrow} = require('@solendprotocol/solend-sdk/instructions/flashBorrowReserveLiquidity')
const {flashRepayReserveLiquidityInstruction: repay} = require('@solendprotocol/solend-sdk/instructions/flashRepayReserveLiquidity')
const {PublicKey, TransactionInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction} = web3
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL = 'So11111111111111111111111111111111111111112'
const lender = new PublicKey('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo')
const env = process.env
const status = {mode:env.MODE || 'scan',state:'starting',checks:0}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms))
function principal(value) {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value)>10000000n) throw Error('Invalid USDC loan size')
  return BigInt(value)*1000000n
}
function fee(amount, wad) {
  if (wad === 18446744073709551615n) throw Error('Flash loans disabled')
  return wad === 0n ? 0n : (amount*wad+10n**18n-1n)/10n**18n+2n
}
async function jupiter(path, options={}) {
  const response = await fetch('https://api.jup.ag/swap/v1/'+path,{...options,signal:AbortSignal.timeout(8000),headers:{'x-api-key':env.JUPITER_API_KEY,'Content-Type':'application/json'}})
  if (!response.ok) throw Error('Jupiter HTTP '+response.status)
  return response.json()
}
async function quote(from,to,amount,exclude='') {
  const params = new URLSearchParams({inputMint:from,outputMint:to,amount:String(amount),slippageBps:'10',onlyDirectRoutes:'true',maxAccounts:'32'})
  if (exclude) params.set('excludeDexes',exclude)
  const q = await jupiter('quote?'+params)
  if(q.inputMint!==from || q.outputMint!==to || BigInt(q.inAmount)!==amount || q.swapMode!=='ExactIn' || !q.routePlan?.length || BigInt(q.otherAmountThreshold)<=0n) throw Error('Invalid quote')
  return q
}
const venues = q => [...new Set(q.routePlan.map(r=>r.swapInfo.label))]
async function check(rpc,amount,mint) {
  const buy = await quote(USDC,mint,amount)
  await sleep(1100)
  const sell = await quote(mint,USDC,BigInt(buy.otherAmountThreshold),venues(buy).join(','))
  const floor = BigInt(sell.otherAmountThreshold)
  status.last = {at:new Date().toISOString(),mint,principalUSDC:String(amount/1000000n),buy:venues(buy),sell:venues(sell),grossFloorMicroUSDC:String(floor-amount)}
  status.checks++
  status.state='scanning'
  if(status.mode==='scan' || floor<=amount) return
  const reserveKey = new PublicKey(env.USDC_RESERVE)
  const account = await rpc.getAccountInfo(reserveKey)
  if (!account?.owner.equals(lender)) throw Error('Invalid reserve owner')
  const reserve = parseReserve(reserveKey,account).info
  const liquidity = reserve.liquidity
  if(liquidity.mintPubkey.toString()!==USDC || BigInt(liquidity.availableAmount.toString())<amount) throw Error('Insufficient USDC reserve')
  const loanFee = fee(amount,BigInt(reserve.config.fees.flashLoanFeeWad.toString()))
  const margin = BigInt(env.MIN_PROFIT_MICRO_USDC || '1000000')
  const cost = BigInt(env.NETWORK_BUDGET_MICRO_USDC || '1000000')
  if(margin<=0n || cost<=0n) throw Error('Positive cost budget and margin required')
  if(floor < amount+loanFee+margin+cost) return
  const live = status.mode==='live'
  const signer = live ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(env.SIGNER_FILE,'utf8')))) : null
  const owner = signer?.publicKey || new PublicKey(env.SIMULATION_WALLET)
  const ata = spl.getAssociatedTokenAddressSync(new PublicKey(USDC),owner)
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1400000})]
  const tables=new Set()
  const swaps=[]
  for(const q of [buy,sell]) {
    const b=await jupiter('swap-instructions',{method:'POST',body:JSON.stringify({quoteResponse:q,userPublicKey:owner.toString(),wrapAndUnwrapSol:false,useSharedAccounts:false})})
    if(b.cleanupInstruction || b.otherInstructions?.length || b.tokenLedgerInstruction || b.swapInstruction?.programId!=='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') throw Error('Unsupported route instructions')
    const decode=i=>new TransactionInstruction({programId:new PublicKey(i.programId),keys:i.accounts.map(a=>({...a,pubkey:new PublicKey(a.pubkey)})),data:Buffer.from(i.data,'base64')})
    // Require pre-existing token accounts. Ignore idempotent ATA setup only.
    if(b.setupInstructions.some(i=>i.programId!==spl.ASSOCIATED_TOKEN_PROGRAM_ID.toString() || i.data!=='AQ==')) throw Error('Unsupported setup')
    swaps.push(decode(b.swapInstruction))
    b.addressLookupTableAddresses.forEach(t=>tables.add(t))
  }
  const index=instructions.length
  instructions.push(borrow(Number(amount),liquidity.supplyPubkey,ata,reserveKey,reserve.lendingMarket,lender),...swaps,
    repay(Number(amount),index,ata,liquidity.supplyPubkey,reserve.config.feeReceiver,reserve.config.feeReceiver,reserveKey,reserve.lendingMarket,owner,lender))
  const lookups=await Promise.all([...tables].map(async t=>(await rpc.getAddressLookupTable(new PublicKey(t))).value))
  const block=await rpc.getLatestBlockhash()
  const message=new TransactionMessage({payerKey:owner,recentBlockhash:block.blockhash,instructions}).compileToV0Message(lookups)
  const tx=new VersionedTransaction(message)
  if(tx.serialize().length>1232) throw Error('Oversized transaction')
  const sim=await rpc.simulateTransaction(tx,{sigVerify:false,minContextSlot:Math.max(buy.contextSlot,sell.contextSlot)})
  if(sim.value.err) throw Error('Simulation rejected')
  status.last.simulated=true
  if(!live) return
  tx.sign([signer])
  // Stop after one submission attempt, including uncertain RPC outcomes.
  status.state='submission attempted'
  const signature=await rpc.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:1})
  status.signature=signature
  const confirmed=await rpc.confirmTransaction({...block,signature},'confirmed')
  status.state=confirmed.value.err?'transaction failed':'confirmed'
}
async function run(){
  if(!['scan','simulate','live'].includes(status.mode)) throw Error('Invalid mode')
  const rpc=new web3.Connection(env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com','confirmed')
  const sizes=(env.LOAN_SIZES_USDC || '1000,10000,100000,1000000,10000000').split(',').map(principal)
  const mints=(env.ROUTE_MINTS || WSOL).split(',').map(m=>new PublicKey(m).toString())
  if(!env.JUPITER_API_KEY){status.state='waiting for JUPITER_API_KEY';return}
  while(true) for(const mint of mints) for(const size of sizes){
    try{await check(rpc,size,mint)}catch(e){if(status.state!=='submission attempted')status.state='scan error';console.error(e.message.replace(/https?:\/\/\S+/g,'[endpoint]'))}
    if(['submission attempted','transaction failed','confirmed'].includes(status.state))return
    await sleep(3000)
  }
}
if(require.main===module){
  http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(status))}).listen(Number(env.PORT||8080))
  run().catch(()=>{status.state='configuration error'})
}
module.exports={principal,fee}
