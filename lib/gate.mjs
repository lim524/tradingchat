import {createHash,timingSafeEqual} from 'node:crypto';
import {gateConfigured} from './session.mjs';
export function verifyPassword(password){
 if(!gateConfigured()||typeof password!=='string'||password.length<1||password.length>200)return false;
 const digest=s=>createHash('sha256').update(s).digest();
 // Environment secrets are never sent to the browser or stored in the repository.
 return timingSafeEqual(digest(password),digest(process.env.APP_PASSWORD));
}
