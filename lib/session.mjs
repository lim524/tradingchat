// Web Crypto only: shared by routing middleware and server APIs.
export const SESSION_SECONDS=8*60*60;
const enc=new TextEncoder();
const to64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const from64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export const gateConfigured=()=>!!(process.env.APP_ORIGIN&&process.env.APP_PASSWORD?.length>=10&&process.env.APP_SESSION_SECRET?.length>=32);
export const sessionCookieName=()=>process.env.APP_ORIGIN?.startsWith('https:')?'__Host-tc_session':'tc_session';
async function sessionKey(){
 const fingerprint=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(process.env.APP_PASSWORD)));
 return crypto.subtle.importKey('raw',enc.encode(process.env.APP_SESSION_SECRET+':'+to64(fingerprint)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export function getSessionCookie(header=''){const name=sessionCookieName();return header.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';}
export async function issueSession(now=Date.now()){
 if(!gateConfigured())throw Error('Password gate is not configured');
 const nonce=to64(crypto.getRandomValues(new Uint8Array(16)));
 const payload=`${Math.floor(now/1000)+SESSION_SECONDS}.${nonce}`;
 return payload+'.'+to64(new Uint8Array(await crypto.subtle.sign('HMAC',await sessionKey(),enc.encode(payload))));
}
export async function verifySession(token,now=Date.now()){
 if(!gateConfigured()||typeof token!=='string'||token.length>160)return false;
 const m=token.match(/^(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/);
 if(!m)return false;const exp=Number(m[1]),seconds=Math.floor(now/1000);
 if(exp<=seconds||exp>seconds+SESSION_SECONDS+60)return false;
 try{return await crypto.subtle.verify('HMAC',await sessionKey(),from64(m[3]),enc.encode(m[1]+'.'+m[2]));}catch{return false;}
}
