/**
 * OBSHCHAK -> MED_PRO: protected read-only tokens.
 * Tokens NEVER grant money editing, voting, or administrative privileges.
 * The single shared Google Sheets finance database remains authoritative.
 */
var MEDPRO_READ_DAYS_ = 90;
function medproReadSheet_(){
  var book=db_(), sh=book.getSheetByName('MedproReadTokens');
  if (!sh){
    sh=book.insertSheet('MedproReadTokens');
    sh.appendRow(['id','user_id','token_hash','user_version','expires_ms','revoked','created_at']);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,7).setFontWeight('bold').setBackground('#e2e8f0');
    sh.getRange(2,1,Math.max(1,sh.getMaxRows()-1),7).setNumberFormat('@');
  }
  return sh;
}
function medproReadHash_(secret){
  var pepper=PropertiesService.getScriptProperties().getProperty('PEPPER');
  if(!pepper)throw new Error('ОБЩАК не ініціалізовано');
  return digest_('MEDPRO_ONLY_VIEW|'+secret+'|'+pepper);
}
function medproGrantRead_(user){
  if(!user || user.active!=='1' || user.must_change==='1')
    throw new Error('Спочатку змініть тимчасовий пароль у ОБЩАКУ');
  var secret=(Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').toLowerCase();
  var sh=medproReadSheet_(), rows=sh.getDataRange().getDisplayValues(), active=[];
  for(var i=1;i<rows.length;i++){
    if(rows[i][1]===user.id && rows[i][5]==='0' && Number(rows[i][4])>Date.now())active.push(i+1);
  }
  while(active.length>=3)sh.getRange(active.shift(),6).setValue('1');
  var expires=Date.now()+MEDPRO_READ_DAYS_*86400000;
  sh.appendRow([Utilities.getUuid(),user.id,medproReadHash_(secret),String(user.version),String(expires),'0',now_()]);
  logAudit_(user.id,'MEDPRO_READ_GRANT','Створено токен перегляду з MED_PRO; без прав зміни каси');
  return {readToken:secret,expiresMs:expires};
}
function medproReadAuth_(secret){
  secret=String(secret||'');
  if(!/^[a-f0-9]{64}$/.test(secret))
    throw new Error('Повторно увійдіть у ОБЩАК: немає ключа читання');
  var sh=medproReadSheet_(), rows=sh.getDataRange().getDisplayValues(), hashed=medproReadHash_(secret);
  for(var i=1;i<rows.length;i++){
    var row=rows[i];
    if(row[2]!==hashed || row[5]!=='0')continue;
    var u=findUser_(row[1]);
    if(Number(row[4])<Date.now() || !u || u.active!=='1' ||
       String(u.version)!==row[3] || u.must_change==='1')
      throw new Error('Повторно увійдіть у ОБЩАК: термін чи права доступу змінилися');
    if(Number(row[4])-Date.now()<45*86400000){
      sh.getRange(i+1,5).setValue(String(Date.now()+MEDPRO_READ_DAYS_*86400000));
    }
    return u;
  }
  throw new Error('Повторно увійдіть у ОБЩАК: ключ читання відкликаний');
}
function medproReadState_(token){
  var user=medproReadAuth_(token), s=state_(user);
  function pick(row,allowed){
    var x={};allowed.forEach(function(key){if(row[key]!==undefined)x[key]=row[key];});return x;
  }
  return {
    me:pick(s.me,['id','name','role']),
    today:s.today,
    totals:s.totals,
    users:s.users.map(function(x){return pick(x,['id','name']);}),
    myContributions:s.myContributions.map(function(x){return pick(x,
      ['id','date','amount','status','purpose','category','reversal_reason']);}),
    ledger:s.ledger.map(function(x){return pick(x,
      ['id','date','kind','amount','person_name','category','purpose','correction_of','created_at']);}),
    reimbursements:s.reimbursements.map(function(x){return pick(x,
      ['id','created_at','requester_id','amount','status','purpose','category','expense_target']);}),
    receipts:s.receipts.map(function(x){return pick(x,
      ['id','ledger_id','filename','mime','size','created_at']);}),
    events:s.events.map(function(x){return pick(x,['created_at','type','summary']);}),
    elections:s.elections.map(function(x){return pick(x,
      ['id','created_at','status','candidate_id','updated_at','required_votes']);}),
    electionsEnabled:s.electionsEnabled
  };
}
function medproReadReceipt_(token,data){
  var user=medproReadAuth_(token);
  return getReceipt_(user,{id:String((data||{}).id||'')});
}
function medproReadRevoke_(token){
  var user=medproReadAuth_(token);
  var sh=medproReadSheet_(), rows=sh.getDataRange().getDisplayValues(), hashed=medproReadHash_(token);
  for(var i=1;i<rows.length;i++){
    if(rows[i][2]===hashed && rows[i][1]===user.id){sh.getRange(i+1,6).setValue('1');break;}
  }
  logAudit_(user.id,'MEDPRO_READ_REVOKE','Користувач закрив збережений вхід MED_PRO');
  return {ok:true};
}
