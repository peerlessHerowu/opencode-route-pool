import {randomBytes} from 'node:crypto';

export function outputText(response){return (response?.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');}

export function parseResponsesStream(raw){
 const events=[];
 for(const frame of raw.replaceAll('\r\n','\n').split('\n\n')){
  const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
  if(data&&data!=='[DONE]')events.push(JSON.parse(data));
 }
 const error=events.find(x=>x.type==='error'||x.type==='response.failed'||x.type==='response.incomplete');
 if(error)throw Error(error.error?.message||error.response?.error?.message||'流式响应失败或未完成');
 const completed=events.find(x=>x.type==='response.completed')?.response;
 if(completed?.status!=='completed')throw Error('缺少 response.completed 结束事件');
 return {response:completed,delta:events.filter(x=>x.type==='response.output_text.delta').map(x=>x.delta||'').join(''),events:events.length};
}

// Each stage validates an actual response. The local tool only echoes an
// unpredictable challenge; no model-generated command is executed here.
export async function verifyResponses(config,model){
 const stages=[];const started=Date.now();
 const request=async(body)=>{
  const r=await fetch('http://'+config.listen+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+config.server_keys[0],'Content-Type':'application/json'},body:JSON.stringify({model,...body}),signal:AbortSignal.timeout(90000)});
  const raw=await r.text();
  if(!r.ok){let d;try{d=JSON.parse(raw);}catch{};const e=Error(d?.error?.message||'HTTP '+r.status);e.http=r.status;throw e;}
  if(body.stream)return parseResponsesStream(raw);
  const d=JSON.parse(raw);if(d.status!=='completed')throw Error('响应未完成：'+d.status);return d;
 };
 const challenge='PROBE_'+randomBytes(6).toString('hex');
 let stage='text';
 try{
  let t=Date.now();let r=await request({input:'Reply exactly '+challenge+'. Do not use tools.',stream:false});
  if(outputText(r).trim()!==challenge)throw Error('普通生成未返回本次随机校验值');
  stages.push({stage,ok:true,ms:Date.now()-t});stage='stream';t=Date.now();
  r=await request({input:'Reply exactly '+challenge+'. Do not use tools.',stream:true});
  if(outputText(r.response).trim()!==challenge||r.delta.trim()!==challenge)throw Error('流式增量与完整响应未通过校验');
  stages.push({stage,ok:true,ms:Date.now()-t});stage='tool_call';t=Date.now();
  const tools=[{type:'function',name:'local_echo',description:'Returns a local verification receipt for the supplied value.',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},strict:true}];
  const input=[{role:'user',content:'Call local_echo with value '+challenge+'. Then reply with only the receipt from the tool result.'}];
  r=await request({input,tools,tool_choice:{type:'function',name:'local_echo'},stream:true});
  const calls=r.response.output.filter(x=>x.type==='function_call');
  if(calls.length!==1||calls[0].name!=='local_echo'||!calls[0].call_id||JSON.parse(calls[0].arguments).value!==challenge)throw Error('工具名、call_id 或参数未通过校验');
  stages.push({stage,ok:true,ms:Date.now()-t});stage='tool_result';t=Date.now();
  const receipt='RECEIPT_'+randomBytes(8).toString('hex');
  // The receipt is created after the tool call, so the model must read the
  // actual tool result to pass rather than copying the user's challenge.
  r=await request({input:[...input,...r.response.output,{type:'function_call_output',call_id:calls[0].call_id,output:JSON.stringify({receipt})}],tools,tool_choice:'none',stream:true});
  if(outputText(r.response).trim()!==receipt)throw Error('模型未正确读回实际工具结果');
  stages.push({stage,ok:true,ms:Date.now()-t});
  return {status:'available',http:200,message:'普通生成、流式响应、工具调用及结果回传全部通过',stages,ms:Date.now()-started};
 }catch(e){stages.push({stage,ok:false,message:e.message});return {status:e.http===429?'limited':e.http===403?'rejected':'failed',http:e.http||null,message:e.message,stages,ms:Date.now()-started};}
}
