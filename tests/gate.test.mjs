import {test,beforeEach} from 'node:test';import assert from 'node:assert/strict';
import middleware from '../middleware.js';import {issueSession,verifySession,getSessionCookie,SESSION_SECONDS} from '../lib/session.mjs';import {verifyPassword} from '../lib/gate.mjs';
beforeEach(()=>{Object.assign(process.env,{APP_ORIGIN:'https://private.example.test',APP_PASSWORD:'test-private-password-only',APP_SESSION_SECRET:'a'.repeat(43)});});
test('password verifies server-side and empty/incorrect values fail',()=>{assert.equal(verifyPassword('test-private-password-only'),true);assert.equal(verifyPassword('wrong'),false);assert.equal(verifyPassword(''),false);});
test('signed sessions reject tampering, expiry, wrong secret and password rotation',async()=>{const now=Date.now(),token=await issueSession(now);assert.equal(await verifySession(token,now),true);assert.equal(await verifySession(token+'x',now),false);assert.equal(await verifySession('9999999999.'+token.split('.').slice(1).join('.'),now),false);assert.equal(await verifySession(token,now+(SESSION_SECONDS+1)*1000),false);process.env.APP_PASSWORD='changed-private-password';assert.equal(await verifySession(token,now),false);});
test('password gate protects HTML, assets and APIs; login assets remain public',async()=>{
 for(const path of ['/','/index.html','/app.js','/cloud.js','/style.css','/anything']){const r=await middleware(new Request('https://private.example.test'+path));assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login.html');assert.equal(r.headers.get('cache-control'),'no-store');}
 const api=await middleware(new Request('https://private.example.test/api/workspace'));assert.equal(api.status,401);
 for(const path of ['/login.html','/login.css','/login.js','/api/auth','/api/runner'])assert.equal((await middleware(new Request('https://private.example.test'+path))).headers.get('x-middleware-next'),'1');
 const token=await issueSession();const r=await middleware(new Request('https://private.example.test/',{headers:{cookie:`__Host-tc_session=${token}`}}));assert.equal(r.headers.get('x-middleware-next'),'1');
 const forged=await middleware(new Request('https://private.example.test/',{headers:{cookie:'tc_access=old-supabase-token; __Host-tc_session=forged','x-middleware-subrequest':'middleware'}}));assert.equal(forged.status,303);
});
test('missing config never exposes application',async()=>{delete process.env.APP_PASSWORD;const r=await middleware(new Request('https://private.example.test/'));assert.equal(r.status,303);assert.equal(await verifySession('anything'),false);});
