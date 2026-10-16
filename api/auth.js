import {createHmac} from 'node:crypto';
import {configured,originCheck,body,json,auth,setSession,db,wrap} from '../lib/server.mjs';
import {requireThat} from '../lib/core.mjs';
import {gateConfigured,issueSession,verifySession,getSessionCookie} from '../lib/session.mjs';
import {verifyPassword} from '../lib/gate.mjs';
export default wrap(async(req,res)=>{
 if(req.method==='GET'){
  const ready=gateConfigured()&&configured();
  if(!ready)return json(res,200,{configured:false,user:null});
  if(!await verifySession(getSessionCookie(req.headers.cookie||'')))return json(res,200,{configured:true,user:null});
  const u=await auth(req,res);return json(res,200,{configured:true,user:{id:u.id,email:u.email}});
 }
 requireThat(req.method==='POST',405,'허용되지 않은 메서드');originCheck(req);const b=body(req);
 if(b.action==='logout'){setSession(res,null);return json(res,200,{ok:true});}
 requireThat(gateConfigured()&&configured(),503,'관리자가 Vercel 비밀번호·Supabase 환경변수를 설정해야 합니다.');
 requireThat(b.action==='login'&&typeof b.password==='string'&&b.password.length>0&&b.password.length<=200,400,'비밀번호를 입력하세요.');
 // A persistent DB quota works across serverless instances; no process-local counter.
 const ip=String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim().slice(0,100);
 const bucket=createHmac('sha256',process.env.APP_SESSION_SECRET).update(ip).digest('hex');
 await db('rpc/reserve_password_attempt',{method:'POST',data:{p_bucket:bucket}});
 requireThat(verifyPassword(b.password),401,'비밀번호가 일치하지 않습니다.');
 // Check the data owner configuration before granting access; no Supabase Auth call.
 const rows=await db('workspace_config?singleton=eq.true&select=owner_id');
 requireThat(rows.length===1,503,'비밀번호 로그인용 Supabase 추가 SQL을 실행하세요.');
 setSession(res,await issueSession());
 json(res,200,{user:{id:rows[0].owner_id,email:'개인 워크스페이스'}});
});
