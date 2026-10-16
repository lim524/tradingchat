import {next} from '@vercel/functions';
import {getSessionCookie,verifySession} from './lib/session.mjs';
export const config={matcher:'/:path*',runtime:'nodejs'};
export default async function middleware(request){
 const path=new URL(request.url).pathname;
 // The machine API has its own expiring, scoped Bearer token validation.
 if(['/login.html','/login.js','/login.css','/api/auth','/api/runner'].includes(path))return next({headers:{'Cache-Control':'no-store'}});
 const valid=await verifySession(getSessionCookie(request.headers.get('cookie')||''));
 if(valid)return next({headers:{'Cache-Control':'no-store'}});
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(path.startsWith('/api/'))return Response.json({error:'사이트 비밀번호를 입력하세요.'},{status:401,headers});
 return new Response(null,{status:303,headers:{...headers,Location:'/login.html'}});
}
