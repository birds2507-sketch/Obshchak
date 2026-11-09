const fs=require('fs'),crypto=require('crypto'),vm=require('vm');
const log=[];const props=new Map(),cache=new Map(),dbs=new Map(),drives=new Map();
class Range{
  constructor(sh,r,c,rows=1,cols=1){Object.assign(this,{sh,r,c,rows,cols});}
  setFontWeight(){return this;} setBackground(){return this;}setNumberFormat(){return this;}
  getDisplayValues(){return this.sh.cells.slice(this.r-1,this.r-1+this.rows).map(row=>Array.from({length:this.cols},(_,i)=>String(row[this.c-1+i]??'')));}
  setValue(v){while(this.sh.cells.length<this.r)this.sh.cells.push([]);this.sh.cells[this.r-1][this.c-1]=String(v);return this;}
}
class Sheet{constructor(name){this.name=name;this.cells=[];}
setName(n){this.name=n;}appendRow(vals){this.cells.push(vals.map(String));}setFrozenRows(){}getRange(...args){return new Range(this,...args);}getDataRange(){return new Range(this,1,1,Math.max(1,this.cells.length),this.cells[0]?.length||1);}getMaxRows(){return 1000;}}
class Spreadsheet{constructor(id){this.id=id;this.sheets=[new Sheet('Sheet1')];}getSheets(){return this.sheets;}insertSheet(n){let sh=new Sheet(n);this.sheets.push(sh);return sh;}getSheetByName(n){return this.sheets.find(s=>s.name===n);}getId(){return this.id;}getUrl(){return 'http://example.com/'+this.id;}}
let next=1;const uuid=()=>('00000000-0000-0000-0000-'+String(next++).padStart(12,'0'));
const driveFolder={createFile(b){let id=uuid(),f={getId:()=>id,setTrashed:()=>{},getBlob:()=>b,getAs:()=>({getBytes:()=>Array.from(Buffer.from('fake-pdf'))})};drives.set(id,f);return f;},getId:()=> 'F-1'};
const google={Utilities:{
  getUuid:uuid,Charset:{UTF_8:'utf8'},DigestAlgorithm:{SHA_256:'sha256'},
  base64Encode:(a)=>Buffer.from(a).toString('base64'),base64Decode:(s)=>Array.from(Buffer.from(s,'base64')),
  base64EncodeWebSafe:(a)=>Buffer.from(a).toString('base64url'),
  computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),
  computeHmacSha256Signature:(s,key)=>Array.from(crypto.createHmac('sha256',key).update(s).digest()),
  formatDate:(date,tz,format)=>{let parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);let obj=Object.fromEntries(parts.map(p=>[p.type,p.value]));return format==='yyyy-MM-dd'?`${obj.year}-${obj.month}-${obj.day}`:`${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute}:${obj.second}`;},
  newBlob:(bytes,mime,name)=>({bytes,mime,name,getBytes:()=>bytes})
},
  SpreadsheetApp:{create:()=>{let id=uuid(),s=new Spreadsheet(id);dbs.set(id,s);return s;},openById:id=>dbs.get(id)},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperties:o=>Object.entries(o).forEach(([k,v])=>props.set(k,v))})},
  CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  DriveApp:{createFolder:()=>driveFolder,getFolderById:()=>driveFolder,getFileById:id=>drives.get(id)||({getAs:()=>({getBytes:()=>Array.from(Buffer.from('fake-pdf'))}),setTrashed(){}})},
  Logger:{log:(...items)=>log.push(items)},
  DocumentApp:{ParagraphHeading:{HEADING1:1,HEADING2:2},create:()=>({getId:()=>uuid(),getBody:()=>({appendParagraph:()=>({setHeading(){return this},editAsText(){return {setBold(){}}}}),appendTable(){}}),saveAndClose(){}})},
  MimeType:{PDF:'application/pdf'},
  HtmlService:{createHtmlOutputFromFile:()=>({setTitle(){return this;},addMetaTag(){return this;}})},
  ContentService:{MimeType:{JSON:'application/json'},createTextOutput:(value)=>({getContent(){return value;},setMimeType(){return this;}})}
};
const context=vm.createContext({console,...google});vm.runInContext(fs.readFileSync(require('path').join(__dirname,'..','gas','Code.gs'),'utf8'),context);
function call(fn,...p){return context[fn](...p)}
function assert(test,msg){if(!test)throw Error('FAIL: '+msg);}
function fail(fn,msg){let failed=false;try{fn();}catch(e){failed=true;}assert(failed,msg);}


// Simulate Apps Script doPost with Google Sheets/Drive mocks.
call('setupOwner_');
const password=log.find(x=>x[0].includes('тимчасовий пароль'))[1];
function post(action,data,token='') {
 const out=call('doPost',{postData:{contents:JSON.stringify({action,data,token})}});
 return JSON.parse(out.getContent());
}
let first=post('login',{login:'kasyr',password});assert(first.ok,'Android login');
let token=first.result.token;
assert(post('changePassword',{old:password,fresh:'VeryStrongPass2026!'},token).ok,'password change');
token=post('login',{login:'kasyr',password:'VeryStrongPass2026!'}).result.token;
const deviceId='8dd626ad-8c3e-43ef-b138-bd451d640f7b';
const device=post('registerDevice',{deviceId},token);
assert(device.ok&&device.result.deviceToken.length===64,'persistent device upload key');
const uploadToken=device.result.deviceToken;
const clientId='af48a278-24ca-40ed-947c-83f06b25f2d5';
const receiptId='9a1f52c9-ec98-400d-a3d1-4bc18a310e75';
const today=call('today_');
const expense={kind:'OUT',date:today,amount:'250.00',category:'Покупка',purpose:'Продукти',noReceiptReason:'Чек очікує синхронізації',clientId};
let result=post('syncTransaction',expense,uploadToken);
assert(result.ok&&result.result.id===clientId,'create expense with stable client ID');
assert(post('syncTransaction',expense,uploadToken).result.alreadyExists===true,'duplicate request idempotent');
assert(!post('syncTransaction',{...expense,amount:'300.00'},uploadToken).ok,'same ID with changed amount rejected');
const jpg=Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
const packet={ledgerId:clientId,receiptId,receipt:{name:'receipt.jpg',mime:'image/jpeg',data:jpg.toString('base64')}};
result=post('syncReceipt',packet,uploadToken);
assert(result.ok,'receipt uploaded to private Drive mock');
result=post('syncReceipt',packet,uploadToken);
assert(result.ok&&result.result.alreadyExists===true,'receipt upload idempotent on retry');
const state=post('state',{},token).result;
assert(state.ledger.filter(x=>x.id===clientId).length===1,'one expense only');
assert(state.receipts.filter(x=>x.id===receiptId).length===1,'one Drive receipt only');
const balance=state.totals.balance;
assert(balance===-25000,'balance reflects one 250 UAH expense');
// Only cashier can upload receipts or write financial operations.
let invited=post('invite',{name:'Учасник',login:'mymember'},token).result;
let otherToken=post('login',{login:invited.login,password:invited.password}).result.token;
assert(!post('addTransaction',{...expense,clientId:'ee4e8420-b512-4bc9-9e45-1fd8e6c52231'},otherToken).ok,'member cannot create expense');
console.log('PASS: Android HTTPS JSON bridge, ledger idempotency, receipt idempotency, access roles, balance');

// Backward-compatible general discussion: older Android action names and state keys stay intact.
const legacyState=post('state',{},otherToken).result;
assert(Array.isArray(legacyState.generalQuestions),'optional generalQuestions collection returned');
const baseCommentCount=legacyState.comments.length;
const baseLedgerCount=legacyState.ledger.length;
const baseBalance=legacyState.totals.balance;
const questionClientId='b147b5c0-3762-482c-b3c5-4d6576fe3b20';
const answerClientId='9e699850-a69c-4930-9f5b-076d3b28d64c';
const generalQuestion={clientId:questionClientId,message:'Коли планується наступний внесок?'};
const ask=post('askGeneralQuestion',generalQuestion,otherToken);
assert(ask.ok&&ask.result.threadId===questionClientId,'member may ask a new question');
assert(post('askGeneralQuestion',generalQuestion,otherToken).result.alreadyExists,'question upload is idempotent');
assert(!post('askGeneralQuestion',{clientId:questionClientId,message:'Змінив текст'},otherToken).ok,'same ID with changed question rejected');
const reply={clientId:answerClientId,threadId:ask.result.threadId,message:'Дата буде оголошена окремо.'};
const answer=post('replyGeneralQuestion',reply,token);
assert(answer.ok,'cashier may reply');
assert(post('replyGeneralQuestion',reply,token).result.alreadyExists,'reply upload is idempotent');
assert(!post('replyGeneralQuestion',{clientId:'6086727f-3d20-438e-a70e-62929363f738',threadId:'unknown',message:'???'},otherToken).ok,'reject unknown threads');
assert(!post('askGeneralQuestion',{message:'Неавторизований'},'').ok,'reject anonymous posting');
const newerState=post('state',{},otherToken).result;
assert(newerState.generalQuestions.length===2&&newerState.generalQuestions[0].kind==='REPLY','state includes the new thread in stable order');
assert(newerState.comments.length===baseCommentCount,'legacy expense comments unchanged');
assert(newerState.ledger.length===baseLedgerCount&&newerState.totals.balance===baseBalance,'financial ledger and balance unchanged');
assert(Array.isArray(newerState.reimbursementComments)&&Array.isArray(newerState.receipts),'legacy JSON response fields unchanged');
console.log('PASS: legacy Android state/actions unaffected, independent general Q&A, no financial mutations');
// Compile the embedded web JavaScript, including new questions UI, without a browser.
const html=fs.readFileSync(require('path').join(__dirname,'..','gas','Index.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length===1,'one embedded web script');
for(const script of scripts)new vm.Script(script[1],{filename:'Index.html'});
assert(html.includes('generalQuestionsPage')&&html.includes("f.id==='general-question'"),'web Q&A page exposed');
console.log('PASS: web UI JavaScript syntax, question and reply routes');

// Password change invalidates old device credential via user.version.
const change=post('changePassword',{old:'VeryStrongPass2026!',fresh:'EvenStrongerPass2027!'},token);
assert(change.ok,'password change allowed');
assert(!post('syncTransaction',{...expense,clientId:'acbd6d4d-1614-4071-a21e-44ac1bf8610d'},uploadToken).ok,'old long-lived token invalidated by password change');
console.log('PASS: 30-day device token and revocation tied to cashier account version');