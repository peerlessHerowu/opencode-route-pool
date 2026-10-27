import http from 'node:http';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {verifyResponses} from './verify.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const csrf=randomBytes(24).toString('hex');
const socket=process.env.CLASH_SOCKET||'/tmp/verge/verge-mihomo.sock';
const origin='http://127.0.0.1:8791';
let busy=false;
let history=[];try{history=JSON.parse(readFileSync(join(root,'pool-history.json'),'utf8'));}catch{}
function clash(path,method='GET',body){return new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path,method,headers:body?{'Content-Type':'application/json'}:{}},r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>{if(r.statusCode>=400)return reject(new Error('Clash HTTP '+r.statusCode));try{resolve(s?JSON.parse(s):{});}catch{reject(new Error('Clash 返回无效内容'));}});});req.setTimeout(6000,()=>req.destroy(new Error('Clash 控制接口超时')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});}
function config(){return JSON.parse(readFileSync(join(root,'config.json'),'utf8'));}
async function networkChanged(){const c=config();const r=await fetch('http://'+c.listen+'/local/network-changed',{method:'POST',headers:{Authorization:'Bearer '+c.server_keys[0],'Content-Type':'application/json'},body:JSON.stringify({proxy:c.proxies?.[0]}),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('线路已切换，但清除旧线路状态失败（HTTP '+r.status+'），请重启服务');return r.json();}
// Existing CONNECT tunnels keep the exit they were opened on. Clash selector
// changes do not migrate them, so the desktop app, CLI and gateway all need
// their OpenCode connections closed before a new request can use the new node.
function isOpenCodeTunnel(x){const m=x.metadata||{};const process=m.process||'';const host=m.host||'';const isOpenCodeProcess=/^(opencode2api|opencode-cli|OpenCode(?: Helper)?)$/.test(process);const isOpenCodeHost=host==='opencode.ai'||host.endsWith('.opencode.ai');return isOpenCodeProcess&&isOpenCodeHost;}
async function openCodeTunnels(){return ((await clash('/connections')).connections||[]).filter(isOpenCodeTunnel).map(x=>({process:x.metadata.process,host:x.metadata.host,chains:x.chains||[],sourcePort:x.metadata.sourcePort||''}));}
async function closeOpenCodeTunnels(){let closed=0;for(const x of (await clash('/connections')).connections||[]){if(isOpenCodeTunnel(x)){await clash('/connections/'+encodeURIComponent(x.id),'DELETE');closed++;}}return closed;}
async function fullVerification(model){const routes=new Map();const sample=async()=>{try{for(const x of (await clash('/connections')).connections||[]){if(x.metadata?.process==='opencode2api'&&x.metadata?.host==='opencode.ai')routes.set(x.id,{id:x.id,chains:x.chains,host:x.metadata.host,sourcePort:x.metadata.sourcePort});}}catch{}};await sample();const timer=setInterval(sample,120);try{return {...await verifyResponses(config(),model),routes:[...routes.values()]};}finally{clearInterval(timer);}}
async function models(){const c=config();const r=await fetch('http://'+c.listen+'/v1/models',{headers:{Authorization:'Bearer '+c.server_keys[0]},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('反代 HTTP '+r.status);return (await r.json()).data.map(x=>x.id);}
function traceOnce(proxy){return new Promise((resolve,reject)=>{const child=spawn(join(root,'exit-check'),['--trace',proxy]);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{if(code)return reject(new Error(err.trim()||'出口检测失败'));let diagnostic;try{diagnostic=JSON.parse(out)[0];}catch{return reject(new Error('出口检测返回无效内容'));}if(diagnostic.error||diagnostic.http!==200)return reject(new Error(diagnostic.error||'出口查询 HTTP '+diagnostic.http));const d=Object.fromEntries(diagnostic.body.trim().split('\n').map(l=>{let i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));if(!d.ip)return reject(new Error('出口检测未返回 IP'));resolve({ip:d.ip,location:d.loc,edge:d.colo});});});}
async function trace(){const c=config();const proxy=c.proxies?.[0];if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy||''))throw new Error('当前检测仅支持本机 HTTP 代理，请检查 config.json 的 proxies');let last;for(let attempt=1;attempt<=3;attempt++){try{return await traceOnce(proxy);}catch(e){last=e;if(attempt<3)await new Promise(r=>setTimeout(r,600));}}throw last;}
async function generate(model){const c=config();const started=Date.now();const routes=new Map();const sample=async()=>{try{for(const x of (await clash('/connections')).connections||[]){if(x.metadata?.process==='opencode2api'&&x.metadata?.host==='opencode.ai')routes.set(x.id,{id:x.id,chains:x.chains,host:x.metadata.host,sourcePort:x.metadata.sourcePort});}}catch{}};await sample();const timer=setInterval(sample,120);try{const r=await fetch('http://'+c.listen+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+c.server_keys[0],'Content-Type':'application/json'},body:JSON.stringify({model,input:'Reply exactly OK. Do not use tools.',stream:false}),signal:AbortSignal.timeout(90000)});const raw=await r.text();let d;try{d=JSON.parse(raw);}catch{}const text=(d?.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');const ok=r.ok&&d?.status==='completed'&&text.trim()==='OK';return {status:ok?'available':r.status===429?'limited':r.status===403?'rejected':'failed',http:r.status,text:text.slice(0,200),message:ok?'实际生成 OK':String(d?.error?.message||d?.status||'响应未通过验收').slice(0,400),ms:Date.now()-started,routes:[...routes.values()]};}catch(e){return {status:'network_error',message:e.message,ms:Date.now()-started,routes:[...routes.values()]};}finally{clearInterval(timer);}}
function send(r,code,data){r.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});r.end(JSON.stringify(data));}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>8192)throw new Error('请求过大');}return JSON.parse(s||'{}');}
const server=http.createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:8791')return send(res,403,{error:'请使用 127.0.0.1:8791 打开'});
 if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'nonce-"+csrf+"'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(readFileSync(join(root,'pool.html'),'utf8').replaceAll('__TOKEN__',csrf));}
 if(req.method==='GET'&&req.url==='/api/state'){const p=(await clash('/proxies')).proxies;const groups=Object.entries(p).filter(([k,v])=>v.type==='Selector'&&k!=='GLOBAL').map(([name,v])=>({name,now:v.now,nodes:v.all}));let m=[],error='',tunnels=[],tunnelError='';try{m=await models();}catch(e){error=e.message;}try{tunnels=await openCodeTunnels();}catch(e){tunnelError=e.message;}return send(res,200,{groups,models:m,proxyError:error,tunnels,tunnelError,history:history.slice(0,30),busy});}
 if(req.method!=='POST')return send(res,404,{error:'未找到接口'});
 if(req.headers.origin!==origin||req.headers['x-pool-token']!==csrf)return send(res,403,{error:'无效页面请求，请刷新'});
 if(busy)return send(res,409,{error:'正在操作，请等待完成'});
 if(!['/api/check','/api/switch','/api/reset'].includes(req.url))return send(res,404,{error:'未找到接口'});
 const b=await body(req);busy=true;
 try{if(req.url==='/api/reset'){const closed=await closeOpenCodeTunnels();await networkChanged();return send(res,200,{message:'已清除本地旧连接、封禁缓存和熔断状态；关闭 OpenCode 旧连接 '+closed+' 条；上游额度不受影响。'});}const p=(await clash('/proxies')).proxies;const g=p[b.group];if(!g||g.type!=='Selector')throw new Error('请选择有效代理组');
 if(req.url==='/api/switch'){if(!g.all.includes(b.node))throw new Error('节点不属于此组');await clash('/proxies/'+encodeURIComponent(b.group),'PUT',{name:b.node});
 // Existing CONNECT tunnels retain their original exit after group selection changes.
 await closeOpenCodeTunnels();
 await networkChanged();
 }
 const actual=(await clash('/proxies')).proxies[b.group].now;
 const record={time:new Date().toISOString(),group:b.group,node:actual,model:b.model};
 try{record.exit=await trace();}catch(e){record.networkError=e.message;}
 if(b.generate){const allowed=await models();if(!allowed.includes(b.model))throw new Error('模型不在当前目录中');record.result=b.full?await fullVerification(b.model):await generate(b.model);record.verification=b.full?'full':'text';}
 history.unshift(record);history=history.slice(0,100);writeFileSync(join(root,'pool-history.json'),JSON.stringify(history,null,2),{mode:0o600});send(res,200,record);
 }finally{busy=false;}
 }catch(e){send(res,500,{error:e.message});}});
server.listen(8791,'127.0.0.1',()=>console.log('线路池：'+origin));
