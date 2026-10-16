import { AppError, requireThat } from './core.mjs';
import {gateConfigured,getSessionCookie,verifySession,sessionCookieName,SESSION_SECONDS} from './session.mjs';
export const configured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
export function originCheck(req) {
  if(req.method==='GET')return;
  requireThat(req.headers.origin === process.env.APP_ORIGIN,403,'요청 출처가 일치하지 않습니다.');
  requireThat((req.headers['content-type']||'').startsWith('application/json'),415,'JSON 요청만 허용합니다.');
}
export function body(req) {
  let b=req.body;
  if(typeof b==='string') {requireThat(Buffer.byteLength(b)<=24000,413,'요청이 너무 큽니다.');try{b=JSON.parse(b)}catch{throw new AppError(400,'JSON 형식 오류')}}
  requireThat(b && typeof b==='object' && !Array.isArray(b) && Buffer.byteLength(JSON.stringify(b))<=24000,400,'요청 형식 오류');
  return b;
}
export function json(res,status,value){res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
export async function remote(url, init={}, label='서비스') {
  let r;try{r=await fetch(url,{...init,signal:AbortSignal.timeout(45000)})}catch{throw new AppError(502,`${label} 연결 실패`)}
  let data;try{data=await r.json()}catch{data=null}
  if(!r.ok) {
    const known={
      'Password attempt limit':[429,'입력 시도가 많습니다. 15분 뒤 다시 시도하세요.'],
      'Account mismatch':[409,'연결 토큰과 거래 계좌·환경이 일치하지 않습니다.'],
      'Account not found':[404,'계좌를 찾을 수 없습니다.'],
      'Runner rate limit':[429,'실행기 요청은 10초 간격으로 제한됩니다.'],
      'Runner expired':[401,'실행기 연결이 만료되거나 폐기됐습니다.'],
      'AI daily limit reached':[429,'하루 AI 호출 한도에 도달했습니다.'],
      'Approval expired':[409,'승인이 만료되거나 철회됐습니다.'],
      'Stop active session first':[409,'기존 세션과 모의 포지션을 먼저 종료하세요.'],
      'Daily session limit reached':[409,'한국시간 일일 손실·거래 횟수 한도에 도달했습니다.'],
      'Simulation not running':[409,'실행 중인 모의 세션이 없습니다.'],
      'Live execution locked':[423,'실거래 주문은 잠겨 있습니다.'],
      'Testnet execution pending validation':[423,'테스트넷 자동 주문은 통합 검증 대기 중입니다.'],
      'Plan mismatch':[409,'운용안 버전이 일치하지 않습니다.']
    };
    const mapped=label==='DB'?known[data?.message]:null;
    throw new AppError(mapped?.[0]||(r.status===429?429:502),mapped?.[1]||`${label} 요청 실패 (${r.status})`);
  }
  return data;
}
export async function db(path,{method='GET',data,representation=true}={}) {
  requireThat(configured(),503,'Supabase 서버 환경변수를 먼저 설정하세요.');
  return remote(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{method,headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:representation?'return=representation':'return=minimal'},...(data===undefined?{}:{body:JSON.stringify(data)})},'DB');
}
export function setSession(res,token) {
  const secure=process.env.APP_ORIGIN?.startsWith('https:')?'; Secure':'';
  res.setHeader('Set-Cookie',[`${sessionCookieName()}=${token||''}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${token?SESSION_SECONDS:0}`,
    // Clear the previous Supabase login cookies during the transition.
    `tc_access=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`,
    `tc_refresh=; Path=/api; HttpOnly; SameSite=Strict${secure}; Max-Age=0`]);
}
export async function auth(req,res) {
  requireThat(gateConfigured(),503,'Vercel 사이트 비밀번호와 세션 설정이 필요합니다.');
  requireThat(await verifySession(getSessionCookie(req.headers.cookie||'')),401,'사이트 비밀번호를 입력하세요.');
  const rows=await db('workspace_config?singleton=eq.true&select=owner_id');
  requireThat(rows.length===1,503,'비밀번호 로그인용 Supabase 추가 SQL을 실행하세요.');
  return {id:rows[0].owner_id,email:'개인 워크스페이스'};
}
export const wrap = fn => async(req,res)=>{try{await fn(req,res)}catch(e){json(res,e instanceof AppError?e.status:500,{error:e instanceof AppError?e.message:'처리 중 오류가 발생했습니다. 다시 확인해주세요.'});}};
export const owned = (table,id,userId) => db(`${table}?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}`).then(rows=>{requireThat(rows?.length===1,404,'데이터를 찾을 수 없습니다.');return rows[0];});
