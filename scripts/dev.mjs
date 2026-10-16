import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const routes=Object.fromEntries(await Promise.all(['auth','workspace','chat','runner'].map(async n=>[n,(await import('../api/'+n+'.js')).default])));
http.createServer(async(req,res)=>{
 try {
  const pathname=new URL(req.url,'http://localhost').pathname;
  const endpoint=pathname.match(/^\/api\/(auth|workspace|chat|runner)$/)?.[1];
  if(endpoint){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>24000){res.writeHead(413);res.end();return;}}req.body=raw||undefined;await routes[endpoint](req,res);return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const relative=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1));
  const target=path.resolve(root,'dist',relative);if(!target.startsWith(path.join(root,'dist')+path.sep)){res.writeHead(403);res.end();return;}
  const bytes=await readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(3000,'127.0.0.1',()=>console.log('Local preview: http://localhost:3000'));
