import {auth,originCheck,body,json,db,owned,wrap} from '../lib/server.mjs';
import {requireThat,uuid,hash} from '../lib/core.mjs';
import {askAI} from '../lib/ai.mjs';
export const config={maxDuration:60};
export default wrap(async(req,res)=>{
  requireThat(req.method==='POST',405,'허용되지 않은 메서드');originCheck(req);const u=await auth(req,res);const b=body(req);
  requireThat(uuid(b.strategyId) && ['demo','testnet','live'].includes(b.mode) && typeof b.message==='string' && b.message.trim().length>0 && b.message.length<=4000,400,'메시지를 확인하세요.');
  await owned('strategies',b.strategyId,u.id);
  const rows=await db(`messages?user_id=eq.${u.id}&strategy_id=eq.${b.strategyId}&mode=eq.${b.mode}&order=created_at.desc,id.desc&limit=12`);
  const latest=(await db(`strategy_versions?user_id=eq.${u.id}&strategy_id=eq.${b.strategyId}&mode=eq.${b.mode}&order=version.desc&limit=1`))[0];
  const history=rows.reverse().map(m=>({role:m.role,content:m.content}));
  if(latest)history.unshift({role:'user',content:`참조 전용 최신 제안(승인·실행 여부를 뜻하지 않음): ${JSON.stringify(latest.plan)}`});
  history.push({role:'user',content:b.message.trim()});
  const result=await askAI(u.id,b.provider||'openai',history);
  // Atomic version allocation + user/assistant messages: no half-saved proposal.
  const saved=await db('rpc/save_strategy_chat',{method:'POST',data:{p_user:u.id,p_strategy:b.strategyId,p_mode:b.mode,p_user_message:b.message.trim(),p_reply:result.reply,p_plan:result.plan,p_hash:result.plan?hash(result.plan):null,p_model:result.model,p_usage:result.usage}});
  json(res,200,{ok:true,result:saved});
});
