import { configured,originCheck,body,json,auth,setSession,remote,wrap } from '../lib/server.mjs';
import {requireThat} from '../lib/core.mjs';
export default wrap(async(req,res)=>{
  if(req.method==='GET') {
    if(!configured())return json(res,200,{configured:false,user:null});
    try{const u=await auth(req,res);return json(res,200,{configured:true,user:{id:u.id,email:u.email}})}catch(e){if(e.status!==401)throw e;return json(res,200,{configured:true,user:null})}
  }
  requireThat(req.method==='POST',405,'허용되지 않은 메서드');originCheck(req);const b=body(req);
  requireThat(configured(),503,'Supabase 환경변수를 설정하세요.');
  if(b.action==='logout') {
    // Invalidate the access session when possible, then always clear both cookies.
    try {const u=await auth(req,res);await fetch(`${process.env.SUPABASE_URL}/auth/v1/logout`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,Authorization:`Bearer ${u.access}`},signal:AbortSignal.timeout(10000)});}catch(e){if(e.status!==401)throw e;}finally{setSession(res,null)}
    return json(res,200,{ok:true});
  }
  requireThat(b.action==='login' && typeof b.email==='string' && typeof b.password==='string' && b.password.length<=200 && b.email.length<=320,400,'로그인 정보를 확인하세요.');
  requireThat(b.email.toLowerCase()===process.env.OWNER_EMAIL.toLowerCase(),401,'로그인 정보를 확인하세요.');
  let s;try{s=await remote(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:b.email,password:b.password})},'인증')}catch{ return json(res,401,{error:'로그인 정보를 확인하세요.'}); }
  requireThat(s.user?.email_confirmed_at && s.user.email.toLowerCase()===process.env.OWNER_EMAIL.toLowerCase(),401,'이메일 인증을 완료하세요.');
  setSession(res,s);json(res,200,{user:{id:s.user.id,email:s.user.email}});
});
