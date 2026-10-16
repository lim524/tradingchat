import { createHash } from 'node:crypto';
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const requireThat = (ok, status, message) => { if (!ok) throw new AppError(status, message); };
export const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export const canonical = v => JSON.stringify(sort(v));
function sort(v) { return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k,sort(v[k])])) : v; }
export const hash = v => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');
export function validatePlan(p) {
  requireThat(p && typeof p === 'object' && !Array.isArray(p), 422, '운용안 형식 오류');
  requireThat(typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 120, 422, '전략 제목 오류');
  requireThat(/^[A-Z0-9]{2,20}USDT$/.test(p.symbol), 422, 'USDT 선물 종목을 지정하세요.');
  requireThat(['LONG','SHORT'].includes(p.direction), 422, '방향 오류');
  for (const k of ['margin','dailyLoss','capital']) requireThat(typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] > 0 && p[k] <= 1e7,422, `${k} 값 오류`);
  requireThat(Number.isInteger(p.leverage) && p.leverage >= 1 && p.leverage <= 125,422,'레버리지 오류');
  requireThat(Number.isInteger(p.maxTrades) && p.maxTrades >= 1 && p.maxTrades <= 1000,422,'거래 횟수 오류');
  requireThat(p.margin <= p.capital && p.dailyLoss <= p.capital,422,'증거금·손실 한도가 운용 자본을 초과합니다.');
  requireThat(Number.isInteger(p.validMinutes) && p.validMinutes >= 1 && p.validMinutes <= 1440,422,'승인 유효시간 오류');
  for(const k of ['entryPrice','stopPrice','takeProfitPrice']) requireThat(p[k] === null || (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] > 0 && p[k] <= 1e12),422,`${k} 값 오류`);
  requireThat(typeof p.instructions === 'string' && p.instructions.length <= 6000,422,'전략 설명 오류');
  requireThat(typeof p.executable === 'boolean',422,'실행 가능 여부 오류');
  if (p.executable) {
    requireThat([p.entryPrice,p.stopPrice,p.takeProfitPrice].every(v=>v!==null),422,'실행 운용안에 진입·손절·익절 가격이 필요합니다.');
    requireThat(p.direction==='LONG' ? p.stopPrice < p.entryPrice && p.entryPrice < p.takeProfitPrice : p.takeProfitPrice < p.entryPrice && p.entryPrice < p.stopPrice,422,'진입·손절·익절 가격 순서를 확인하세요.');
  }
  return Object.fromEntries(Object.keys(planProperties).map(k=>[k,p[k]]));
}
const num = {type:'number'}, nullableNum = {type:['number','null']};
export const planProperties = {title:{type:'string'},symbol:{type:'string'},direction:{type:'string',enum:['LONG','SHORT']},capital:num,margin:num,leverage:{type:'integer'},dailyLoss:num,maxTrades:{type:'integer'},validMinutes:{type:'integer'},entryPrice:nullableNum,stopPrice:nullableNum,takeProfitPrice:nullableNum,executable:{type:'boolean'},instructions:{type:'string'}};
export const responseSchema = {type:'object',additionalProperties:false,required:['reply','plan'],properties:{reply:{type:'string'},plan:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:Object.keys(planProperties),properties:planProperties}]}}};
export function aggregate(trades) {
  const result = new Map();
  for (const t of trades) {
    const key = `${t.strategy_version_id || 'unattributed'}:${t.mode}`;
    const row = result.get(key) || {strategy_version_id:t.strategy_version_id,mode:t.mode,trades:0,wins:0,net:0,fees:0,funding:0,grossProfit:0,grossLoss:0};
    const net=Number(t.net_pnl);row.trades++;row.wins+=net>0?1:0;row.net+=net;row.fees+=Number(t.fees);row.funding+=Number(t.funding);
    if(net>0)row.grossProfit+=net;else row.grossLoss-=net;
    result.set(key,row);
  }
  return [...result.values()].map(r=>({...r,winRate:r.wins/r.trades*100,profitFactor:r.grossLoss>0?r.grossProfit/r.grossLoss:null}));
}
