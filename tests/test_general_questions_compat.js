// Isolated verification of additive general questions and legacy API shape.
// No live Google Sheets / Google Apps Script credentials or deployment involved.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../gas/Code.gs'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../gas/Index.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1);
new vm.Script(scripts[0][1],{filename:'Index.html'});
assert(html.includes('generalQuestionsPage'), 'web UI includes optional general Q&A');

let seq=10,sheet=null;
const items=[],audit=[],events=[];
const users=[
 {id:'u1',name:'Учасник',role:'MEMBER',active:'1',must_change:'0'},
 {id:'u2',name:'Касир',role:'CASHIER',active:'1',must_change:'0'},
 {id:'u3',name:'Адміністратор',role:'ADMIN',active:'1',must_change:'0'}
];
const legacyComments=[{id:'c1',ledger_id:'l1',author_id:'u1',message:'Де чек?',created_at:'2026-11-08 10:00:00'}];
const ledger=[{id:'l1',kind:'IN',amount:'1000',date:'2026-11-08',purpose:'Внесок',person_id:'u1'}];
const fakeSheet={
  appendRow(v){ if(!this.header)this.header=v; },
  setFrozenRows(){},
  getRange(){return {setFontWeight(){return this;},setBackground(){return this;},setNumberFormat(){return this;}};},
  getMaxRows(){return 1000;}
};
const book={
 getSheetByName(n){return n==='GeneralQuestions'?sheet:null;},
 insertSheet(n){assert.equal(n,'GeneralQuestions');sheet=fakeSheet;return sheet;}
};
const ctx=vm.createContext({console,Date,Math,JSON,Utilities:{getUuid(){
  return '00000000-0000-4000-8000-'+String(seq++).padStart(12,'0');
}}});
vm.runInContext(code,ctx,{filename:'Code.gs'});
const existingRows={
 Ledger:ledger,Users:users,Comments:legacyComments,Receipts:[],Elections:[],Ballots:[],
 Events:events,Audit:audit,ReversalRequests:[],Handovers:[],ReimbursementComments:[]
};
ctx.db_=()=>book;
ctx.all_=name=>name==='GeneralQuestions'?items:(existingRows[name]||[]);
ctx.append_=(name,values)=>{
 assert.equal(name,'GeneralQuestions');
 assert(sheet,'only new sheet should be used');
 const obj=Object.fromEntries(ctx.CFG_.HEADERS.GeneralQuestions.map((key,i)=>[key,String(values[i])]));
 items.push(obj);
};
ctx.auth_=t=>{const u=users.find(x=>x.id===t);if(!u)throw Error('Потрібно увійти');return u;};
ctx.withLock_=fn=>fn();
ctx.ensureReversalRequests_=()=>{};
ctx.contributionsFor_=()=>[];
ctx.reimbursements_=()=>[];
ctx.electionsEnabled_=()=>true;
ctx.publicUser_=u=>({id:u.id,name:u.name,role:u.role,active:true});
ctx.now_=()=> '2026-11-09 12:00:00';
ctx.today_=()=> '2026-11-09';
ctx.event_=(type,summary,user,ref)=>events.push({type,summary,actor_id:user,ref_id:ref,created_at:ctx.now_()});
ctx.logAudit_=(user,action,details)=>audit.push({actor_id:user,action,details,created_at:ctx.now_()});
ctx.comment_=(user,data)=>({legacyComment:true});
const api=(action,data={},token='u1')=>ctx.api(action,data,token);
const initial=api('state');
assert.equal(initial.generalQuestions.length,0);
assert.equal(sheet,null,'reading state must not mutate existing database');
assert.equal(initial.totals.balance,1000);
assert.equal(initial.comments.length,1);
assert.equal(api('comment',{}).legacyComment,true,'old comment API still dispatches');

const questionClientId='14d72a18-9471-42bd-892d-d8c4bd93ea0f';
const replyClientId='b0a8bd17-52c8-4f75-9b44-ebcc9b2138f7';
const question={clientId:questionClientId,message:'Коли плануються наступні внески?'};
const newQuestion=api('askGeneralQuestion',question,'u1');
assert.equal(newQuestion.id,questionClientId);
assert.equal(newQuestion.threadId,questionClientId);
assert.equal(items.length,1);
assert.equal(items[0].kind,'QUESTION');
assert.equal(api('askGeneralQuestion',question,'u1').alreadyExists,true);
assert.equal(items.length,1,'same question not duplicated');
assert.throws(()=>api('askGeneralQuestion',{...question,message:'Інше'},'u1'));
assert.throws(()=>api('askGeneralQuestion',question,'no-token'));
const answer={clientId:replyClientId,threadId:questionClientId,message:'Повідомимо на початку місяця.'};
assert.equal(api('replyGeneralQuestion',answer,'u2').id,replyClientId);
assert.equal(api('replyGeneralQuestion',answer,'u2').alreadyExists,true);
assert.throws(()=>api('replyGeneralQuestion',{...answer,threadId:'wrong'},'u2'));
assert.equal(items.length,2);
const newer=api('state',{},'u3');
assert.equal(newer.generalQuestions.length,2);
assert.equal(newer.generalQuestions[0].kind,'REPLY');
assert.equal(newer.generalQuestions[1].kind,'QUESTION');
assert.equal(newer.totals.balance,initial.totals.balance);
assert.equal(newer.comments.length,initial.comments.length);
assert.equal(newer.ledger.length,initial.ledger.length);
assert.equal(newer.receipts.length,initial.receipts.length);
assert.equal(newer.reimbursements.length,0);
assert.equal(newer.reimbursementComments.length,0);
assert.equal(events.length,2);
assert.equal(audit.length,2);
console.log('PASS: web syntax, member/cashier roles, legacy API shape, idempotency, no ledger writes');
