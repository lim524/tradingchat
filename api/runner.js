import {json,body,db,wrap} from '../lib/server.mjs';
import {requireThat,hash,uuid} from '../lib/core.mjs';
// Scoped, expiring machine credential. Never accepts a browser login cookie.
export default wrap(async(req,res)=>{
 requireThat(req.method==='POST',405,'POST만 허용합니다.');
 requireThat((req.headers['content-type']||'').startsWith('application/json'),415,'JSON 요청만 허용합니다.');
 const token=(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
 requireThat(token,401,'실행기 인증이 필요합니다.');
 const rows=await db(`runner_connections?token_hash=eq.${hash(token)}&revoked_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`);
 requireThat(rows.length===1,401,'실행기 연결이 만료되었거나 폐기됐습니다.');const r=rows[0];const b=body(req);
 const accounts=await db(`exchange_accounts?id=eq.${r.account_id}&user_id=eq.${r.user_id}&limit=1`);
 requireThat(accounts.length===1,401,'연결 계좌를 찾을 수 없습니다.');const account=accounts[0];
 requireThat(b.mode===account.mode&&(b.exchange===undefined?account.exchange==='binance':b.exchange===account.exchange)&&(b.accountType===undefined?account.exchange==='binance':b.accountType===account.account_type)&&(b.accountId===undefined||b.accountId===account.id),400,'실행기 거래소·계좌·환경이 연결 토큰과 일치하지 않습니다.');
 requireThat(b.action==='snapshot'&&uuid(b.id)&&['testnet','live'].includes(b.mode)&&Number.isFinite(b.timestamp)&&Math.abs(Date.now()-b.timestamp)<60000,400,'실행기 요청 만료 또는 형식 오류');
 for(const k of ['balance','unrealizedPnl'])requireThat(typeof b[k]==='number'&&Number.isFinite(b[k])&&Math.abs(b[k])<=1e12,400,'계좌 수치 오류');
 requireThat(Array.isArray(b.positions)&&b.positions.length<=100,400,'포지션 형식 오류');
 const positions=b.positions.map(p=>{requireThat(/^[A-Z0-9]{2,20}USDT$/.test(p.symbol)&&['quantity','unrealizedPnl'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k])&&Math.abs(p[k])<=1e12),400,'포지션 수치 오류');return {symbol:p.symbol,quantity:p.quantity,unrealizedPnl:p.unrealizedPnl};});
 // UUID idempotency key; a replay fails rather than duplicating snapshots.
 await db('rpc/save_account_snapshot',{method:'POST',data:{p_id:b.id,p_user:r.user_id,p_runner:r.id,p_mode:b.mode,p_balance:b.balance,p_unreal:b.unrealizedPnl,p_positions:positions}});
 json(res,200,{ok:true,accountId:account.id,exchange:account.exchange,mode:account.mode,capabilities:['account:read'],ordersEnabled:false});
});
