import {AppError,responseSchema,validatePlan,requireThat} from './core.mjs';
import {remote,db} from './server.mjs';
export async function askAI(userId,provider,messages) {
  requireThat(['openai','gemini'].includes(provider),400,'모델 제공자 오류');
  const model=process.env[provider==='openai'?'OPENAI_CHAT_MODEL':'GEMINI_CHAT_MODEL'];
  const key=process.env[provider==='openai'?'OPENAI_API_KEY':'GEMINI_API_KEY'];
  requireThat(model && key,503,'선택한 AI의 서버 키와 모델 ID를 설정하세요.');
  const limit=Math.min(10000,Math.max(1,Number(process.env.AI_DAILY_CALL_LIMIT)||100));
  await db('rpc/reserve_ai_call',{method:'POST',data:{p_user:userId,p_limit:limit}});
  const system=`너는 개인용 USDT 선물 전략 설계 도우미다. 한국어로 답하라. 실제 주문 권한은 없다. 계좌와 실시간 시세는 제공되지 않았다. 현재 가격·수익·연결 상태를 꾸미지 마라. 사용자의 수치 지시는 정확히 유지하고, 정보가 부족하면 질문하고 plan은 null로 반환하라. AI는 증거금·레버리지·손실 한도를 제안할 수 있으나 사용자 승인 전 효력이 없다. plan은 완전한 새 버전이다. 현재 실행기가 지원하는 것은 단일 종목·단일 진입·격리·단방향·고정 진입/손절/익절 가격뿐이다. 분할 진입·분할 익절·지표 조건 등 미지원 조건이 있거나 가격이 없으면 executable=false로 설정하고 설명에 명시하라. 자유로운 설명만으로 실행 가능한 것처럼 표현하지 마라. capital은 USDT 운용 자본, margin은 1회 증거금, dailyLoss는 한국시간 하루 손실 한도, validMinutes는 승인 유효분이다. 승인·실행·거래 사실을 주장하지 마라. 출력 JSON 스키마를 지켜라.`;
  let text,usage;
  if(provider==='openai') {
    const r=await remote('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,store:false,instructions:system,input:messages.map(m=>({role:m.role,content:m.content})),max_output_tokens:4000,text:{format:{type:'json_schema',name:'strategy_proposal',strict:true,schema:responseSchema}}})},'OpenAI');
    requireThat(r.status==='completed',502,'AI 응답이 완료되지 않았습니다.');
    text=(r.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');usage=r.usage;
  }else {
    const r=await remote(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:4000,responseMimeType:'application/json',responseJsonSchema:responseSchema}})},'Gemini');
    requireThat(r.candidates?.[0]?.finishReason==='STOP',502,'AI 응답이 완료되지 않았습니다.');
    text=r.candidates[0].content.parts.filter(p=>!p.thought).map(p=>p.text||'').join('');usage=r.usageMetadata;
  }
  let answer;try{answer=JSON.parse(text)}catch{throw new AppError(502,'AI 응답 형식 오류')}
  requireThat(typeof answer.reply==='string' && answer.reply.length<=16000,502,'AI 응답 형식 오류');
  if(answer.plan!==null)answer.plan=validatePlan(answer.plan);
  return {...answer,model,provider,usage:usage||{}};
}
