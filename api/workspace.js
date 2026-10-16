import {randomBytes} from 'node:crypto';
import {auth,originCheck,body,json,db,owned,wrap} from '../lib/server.mjs';
import {requireThat,uuid,hash} from '../lib/core.mjs';
export default wrap(async(req,res)=>{
  requireThat(['GET','POST'].includes(req.method),405,'허용되지 않은 메서드');originCheck(req);const u=await auth(req,res);
  if(req.method==='GET') {
    const names=['strategies','strategy_versions','messages','approvals','trades','journal_entries','sessions','account_snapshots','strategy_performance','exchange_accounts'];
    const data=await Promise.all(names.map(t=>db(`${t}?user_id=eq.${u.id}&${t==='strategy_performance'?'order=version.desc':'order=created_at.desc'}&limit=${t==='messages'?300:500}`)));
    const runner=await db(`runner_connections?user_id=eq.${u.id}&select=id,account_id,label,created_at,last_seen,expires_at,revoked_at&order=created_at.desc&limit=100`);
    return json(res,200,{...Object.fromEntries(names.map((n,i)=>[n,data[i]])),runner,models:{openai:process.env.OPENAI_CHAT_MODEL||null,gemini:process.env.GEMINI_CHAT_MODEL||null},liveEnabled:false,limits:{list:500,messages:300}});
  }
  const b=body(req);let result;
  if(b.action==='createStrategy') {
    requireThat(typeof b.title==='string' && b.title.trim().length>0 && b.title.length<=120,400,'전략 이름을 입력하세요.');
    result=await db('strategies',{method:'POST',data:{user_id:u.id,title:b.title.trim()}});
  }else if(b.action==='decision') {
    requireThat(uuid(b.versionId) && ['approve','reject','revoke'].includes(b.decision),400,'승인 요청 오류');
    const v=await owned('strategy_versions',b.versionId,u.id);
    requireThat(b.planHash===v.plan_hash,409,'운용안이 변경됐습니다. 새로고침 후 확인하세요.');
    requireThat(v.mode!=='live'||b.decision!=='approve',423,'실거래 주문은 통합 검증 전 잠겨 있습니다.');
    result=await db('rpc/decide_strategy',{method:'POST',data:{p_user:u.id,p_version:v.id,p_hash:b.planHash,p_decision:b.decision}});
  }else if(b.action==='session') {
    requireThat(uuid(b.approvalId) && ['start','stop','paperStep'].includes(b.command),400,'실행 요청 오류');
    result=await db('rpc/control_session',{method:'POST',data:{p_user:u.id,p_approval:b.approvalId,p_command:b.command}});
  }else if(b.action==='journal') {
    requireThat(uuid(b.tradeId) && typeof b.notes==='string' && b.notes.length<=6000 && Array.isArray(b.tags) && b.tags.length<=10 && b.tags.every(t=>typeof t==='string'&&t.length<=30),400,'일지 내용을 확인하세요.');
    await owned('trades',b.tradeId,u.id);
    result=await db('rpc/save_journal',{method:'POST',data:{p_user:u.id,p_trade:b.tradeId,p_notes:b.notes,p_tags:b.tags}});
  }else if(b.action==='createAccount') {
    requireThat(['binance','bitget'].includes(b.exchange)&&['live','testnet'].includes(b.mode)&&typeof b.label==='string'&&b.label.trim().length>0&&b.label.length<=60,400,'거래소·계좌 이름·환경을 확인하세요.');
    const accountType=b.exchange==='binance'?'futures':b.accountType;
    requireThat(b.exchange==='binance'||['classic','uta'].includes(accountType),400,'비트겟 계정 유형을 선택하세요.');
    result=await db('exchange_accounts',{method:'POST',data:{user_id:u.id,exchange:b.exchange,account_type:accountType,mode:b.mode,label:b.label.trim()}});
  }else if(b.action==='pairRunner') {
    requireThat(uuid(b.accountId),400,'연결할 계좌를 선택하세요.');
    const account=await owned('exchange_accounts',b.accountId,u.id);
    const token=randomBytes(32).toString('base64url');
    result=await db('rpc/pair_account_runner',{method:'POST',data:{p_user:u.id,p_account:account.id,p_hash:hash(token)}});
    const r=Array.isArray(result)?result[0]:result;
    return json(res,200,{token,expiresAt:r.expires_at,accountId:account.id,exchange:account.exchange,accountType:account.account_type,mode:account.mode});
  }else if(b.action==='revokeRunner') {
    requireThat(uuid(b.accountId),400,'연결을 폐기할 계좌를 선택하세요.');
    await owned('exchange_accounts',b.accountId,u.id);
    await db(`runner_connections?user_id=eq.${u.id}&account_id=eq.${b.accountId}&revoked_at=is.null`,{method:'PATCH',data:{revoked_at:new Date().toISOString()}});result={ok:true};
  }else requireThat(false,400,'알 수 없는 작업');
  json(res,200,{ok:true,result});
});
