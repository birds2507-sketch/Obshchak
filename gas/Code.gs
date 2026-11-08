/**
 * ОБЩАК v2 Android API — Google Apps Script + Google Sheets + Google Drive.
 * Власник запускає setupOwner_() в редакторі Apps Script ПЕРЕД публікацією.
 * Всі функції, крім doGet та api, приватні для викликів із HTML (суфікс _).
 */
var CFG_ = {
  TZ: 'Europe/Kyiv',
  MAX_USERS: 10,
  MAX_RECEIPT_BYTES: 2000000,
  MAX_MESSAGE: 1500,
  MAX_TXN: 99999999999, // у копійках
  SESSION_SECONDS: 21600,
  HEADERS: {
    Users: ['id','login','name','role','salt','hash','must_change','active','created_at','version'],
    Ledger: ['id','date','created_at','kind','amount','person_id','person_name','method','category','purpose','no_receipt_reason','correction_of','created_by'],
    Receipts: ['id','ledger_id','file_id','filename','mime','size','created_at','created_by'],
    Comments: ['id','ledger_id','author_id','message','created_at'],
    Elections: ['id','initiator','supporter','candidate_id','status','created_at','updated_at','book_balance','electorate','required_votes'],
    Ballots: ['id','election_id','voter_id','vote','created_at'],
    Events: ['id','type','summary','created_at','actor_id','ref_id'],
    Audit: ['id','created_at','actor_id','action','details'],
    Handovers: ['id','election_id','ledger_balance','actual_balance','difference','explanation','created_at','created_by'],
    DeviceTokens: ['id','user_id','device_id','token_hash','version','expires_ms','revoked','created_at']
  }
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ОБЩАК · Спільна каса')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Android-only JSON entry point. The existing web UI keeps using google.script.run. */
function doPost(e) {
  var output;
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 3000000)
      throw new Error('Неправильний запит або завелике повідомлення');
    var packet = JSON.parse(e.postData.contents);
    if (!packet || typeof packet.action !== 'string') throw new Error('Не вказана дія');
    // Login does not require token; all other calls pass through existing auth_ and role checks.
    var result;
    if(packet.action==='registerPush' || packet.action==='unregisterPush'){
      // Device-scoped authorization: a member may register only their own device.
      var pushUser=authDevice_(String(packet.token||''));
      result=withLock_(function(){return packet.action==='registerPush' ?
        registerPush_(pushUser,packet.data||{}):unregisterPush_(pushUser,packet.data||{});});
    } else if (packet.action==='deviceEvents') {
      // Device key is tied to an active member and expires automatically.
      // Return only event metadata; no private account or receipt files.
      authDevice_(String(packet.token||''));
      result={events:all_('Events').slice(-120).reverse()};
    } else if (packet.action==='syncTransaction' || packet.action==='syncReceipt' || packet.action==='syncComment') {
      var deviceUser=authDevice_(String(packet.token||''));
      result=withLock_(function(){
        if(packet.action==='syncTransaction')return addTransaction_(deviceUser,packet.data||{});
        if(packet.action==='syncReceipt')return addReceipt_(deviceUser,packet.data||{});
        return comment_(deviceUser,packet.data||{});
      });
    } else result=api(packet.action, packet.data || {}, packet.token || '');
    output = {ok:true, result:result};
  } catch(err) {
    output = {ok:false, error:String(err && err.message || 'Помилка обробки')};
  }
  return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}

/** Виконати один раз із редактора скриптів. НЕ публікувати без запуску цієї функції. */
function setupOwner_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHEET_ID')) throw new Error('ОБЩАК уже ініціалізовано. Повторний запуск заборонений.');
  var ss = SpreadsheetApp.create('ОБЩАК — база даних');
  var sheets = Object.keys(CFG_.HEADERS);
  sheets.forEach(function(name, i) {
    var sh = i === 0 ? ss.getSheets()[0] : ss.insertSheet(name);
    sh.setName(name);
    sh.appendRow(CFG_.HEADERS[name]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, CFG_.HEADERS[name].length).setFontWeight('bold').setBackground('#e2e8f0');
    sh.getRange(2, 1, Math.max(1, sh.getMaxRows()-1), CFG_.HEADERS[name].length).setNumberFormat('@');
  });
  var folder = DriveApp.createFolder('ОБЩАК — приватні чеки');
  props.setProperties({ SHEET_ID: ss.getId(), RECEIPT_FOLDER_ID: folder.getId(), PEPPER: Utilities.getUuid() + Utilities.getUuid() });
  var passwd = tempPassword_();
  var salt = Utilities.getUuid();
  append_('Users', [Utilities.getUuid(), 'kasyr', 'Касир', 'CASHIER', salt, hashPassword_(passwd,salt), '1', '1', now_(), '1']);
  logAudit_('SYSTEM','SETUP','Створено базу, папку чеків та першого касира');
  Logger.log('ОБЩАК: база %s', ss.getUrl());
  Logger.log('ОБЩАК: логін = kasyr');
  Logger.log('ОБЩАК: тимчасовий пароль = %s', passwd);
  Logger.log('Збережіть пароль. При першому вході його треба змінити. Не передавайте доступ до таблиці учасникам.');
}

/** Аварійне відновлення касира тільки власником у редакторі Apps Script. */
function recoverCashier_() {
  db_();
  var cashier = all_('Users').filter(function(u){return u.role==='CASHIER' && u.active==='1';})[0];
  if (!cashier) throw new Error('Касира не знайдено');
  var p = tempPassword_(), salt = Utilities.getUuid();
  updateUser_(cashier.id, {salt:salt,hash:hashPassword_(p,salt),must_change:'1',version:String(Number(cashier.version)+1)});
  logAudit_('SYSTEM','RECOVER','Аварійне скидання пароля касира');
  Logger.log('Новий тимчасовий пароль для %s: %s', cashier.login, p);
}

function api(action, data, token) {
  data = data || {};
  if (action === 'login') return login_(data);
  var user = auth_(token);
  if (action === 'logout') { CacheService.getScriptCache().remove('S_'+digest_(String(token))); return {ok:true}; }
  if (action === 'changePassword') return changePassword_(user, data);
  if (user.must_change === '1') throw new Error('Спочатку встановіть власний пароль.');
  switch (action) {
    case 'state': return state_(user);
    case 'registerDevice': return withLock_(function(){return registerDevice_(user,data);});
    case 'addTransaction': return withLock_(function(){return addTransaction_(user,data);});
    case 'openingBalance': return withLock_(function(){return openingBalance_(user,data);});
    case 'reverseTransaction': return withLock_(function(){return reverseTransaction_(user,data);});
    case 'addReceipt': return withLock_(function(){return addReceipt_(user,data);});
    case 'getReceipt': return getReceipt_(user,data);
    case 'comment': return withLock_(function(){return comment_(user,data);});
    case 'invite': return withLock_(function(){return invite_(user,data);});
    case 'resetPassword': return withLock_(function(){return resetPassword_(user,data);});
    case 'toggleUser': return withLock_(function(){return toggleUser_(user,data);});
    case 'setReserve': return withLock_(function(){return setReserve_(user,data);});
    case 'proposeElection': return withLock_(function(){return proposeElection_(user,data);});
    case 'supportElection': return withLock_(function(){return supportElection_(user,data);});
    case 'castVote': return withLock_(function(){return castVote_(user,data);});
    case 'acceptElection': return withLock_(function(){return acceptElection_(user,data);});
    case 'recordHandover': return withLock_(function(){return recordHandover_(user,data);});
    case 'pdf': return reportPdf_(user,data);
    default: throw new Error('Невідома команда');
  }
}

/** Long-lived upload-only token so receipts can sync after hours/days offline.
 * Tokens are hashed at rest; each is bound to user ID, active CASHIER role, user version,
 * a single device ID and a 30-day expiration. Not valid for reading data or browser use.
 */
function ensureDeviceSheet_() {
  var book=db_(), sh=book.getSheetByName('DeviceTokens');
  if(!sh){sh=book.insertSheet('DeviceTokens');sh.appendRow(CFG_.HEADERS.DeviceTokens);sh.setFrozenRows(1);
    sh.getRange(1,1,1,CFG_.HEADERS.DeviceTokens.length).setFontWeight('bold');}
  return sh;
}
function registerDevice_(user,data){
  // Any active member may upload only their own comments; ledger writes still require CASHIER.
  var deviceId=String(data.deviceId||'');
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(deviceId))throw new Error('Неправильний ID пристрою');
  ensureDeviceSheet_();
  var sh=sheet_('DeviceTokens'), rows=sh.getDataRange().getDisplayValues();
  for(var i=1;i<rows.length;i++)if(rows[i][1]===user.id && rows[i][2]===deviceId)
    sh.getRange(i+1,7).setValue('1'); // revoke old key before re-registering
  var secret=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
  var hash=digest_(secret+'|'+PropertiesService.getScriptProperties().getProperty('PEPPER'));
  var expires=Date.now()+30*24*60*60*1000;
  append_('DeviceTokens',[Utilities.getUuid(),user.id,deviceId,hash,user.version,String(expires),'0',now_()]);
  logAudit_(user.id,'DEVICE','Ключ фонової синхронізації оновлено для пристрою');
  return {deviceToken:secret,expiresMs:expires};
}
function authDevice_(token){
  if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))throw new Error('Потрібен повторний вхід: немає дозволу синхронізації');
  ensureDeviceSheet_();
  var hash=digest_(token+'|'+PropertiesService.getScriptProperties().getProperty('PEPPER'));
  var rec=all_('DeviceTokens').filter(function(x){return x.token_hash===hash && x.revoked==='0';})[0];
  if(!rec || Number(rec.expires_ms)<Date.now())throw new Error('Потрібен повторний вхід: ключ синхронізації закінчився');
  var user=findUser_(rec.user_id);
  if(!user || user.active!=='1' || user.version!==rec.version)
    throw new Error('Потрібен повторний вхід: права або доступ учасника змінилися');
  return user;
}

function db_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Спочатку виконайте setupOwner_() в редакторі Apps Script.');
  return SpreadsheetApp.openById(id);
}
function sheet_(name) { return db_().getSheetByName(name); }
function all_(name) {
  var sh=sheet_(name), rows=sh.getDataRange().getDisplayValues(), head=rows.shift();
  return rows.filter(function(r){return r[0]!=='';}).map(function(r){
    var o={}; head.forEach(function(h,i){o[h]=String(r[i]===undefined?'':r[i]);}); return o;
  });
}
function append_(name, values) {
  sheet_(name).appendRow(values.map(function(v){
    var s=String(v===null || v===undefined ? '' : v);
    return s.charAt(0)==='=' ? "'"+s : s;
  }));
}
function updateUser_(id, patch) {
  var sh=sheet_('Users'), all=sh.getDataRange().getDisplayValues(), head=all[0], row=-1;
  for(var i=1;i<all.length;i++){if(all[i][0]===id){row=i+1;break;}}
  if(row<0) throw new Error('Користувача не знайдено');
  Object.keys(patch).forEach(function(k){var idx=head.indexOf(k);if(idx<0)throw new Error('Невідоме поле');sh.getRange(row,idx+1).setValue(String(patch[k]));});
}
function now_() { return Utilities.formatDate(new Date(),CFG_.TZ,'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(),CFG_.TZ,'yyyy-MM-dd'); }
function text_(value,max) { return String(value===null || value===undefined?'':value).trim().slice(0,max||150); }
function needed_(value,label,max) { var s=text_(value,max);if(!s)throw new Error('Заповніть поле: '+label);return s; }
function digest_(str) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,str,Utilities.Charset.UTF_8)); }
function hashPassword_(pw,salt) {
  var pepper=PropertiesService.getScriptProperties().getProperty('PEPPER');
  if(!pepper) throw new Error('Не заданий секрет застосунку');
  var state=salt+'|'+String(pw);
  for(var i=0;i<1200;i++) state=Utilities.base64Encode(Utilities.computeHmacSha256Signature(state,pepper,Utilities.Charset.UTF_8));
  return state;
}
function tempPassword_() {return (Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'')).slice(0,20);}
function findUser_(id) {return all_('Users').filter(function(u){return u.id===String(id);})[0];}
function auth_(token) {
  if(typeof token!=='string' || !/^[\w-]{25,160}$/.test(token)) throw new Error('Потрібно увійти в обліковий запис');
  var cached=CacheService.getScriptCache().get('S_'+digest_(token));
  if(!cached)throw new Error('Сеанс завершився. Увійдіть повторно.');
  var session=JSON.parse(cached), u=findUser_(session.id);
  if(!u || u.active!=='1' || u.version!==String(session.version))throw new Error('Доступ до облікового запису змінено. Увійдіть повторно.');
  return u;
}
function login_(data) {
  var login=text_(data.login,60).toLowerCase(), pw=String(data.password||'');
  if(!/^[a-z0-9._-]{3,30}$/.test(login) || !pw)throw new Error('Невірний логін або пароль');
  var cache=CacheService.getScriptCache(), key='L_'+digest_(login), failures=Number(cache.get(key)||0);
  if(failures>=8)throw new Error('Забагато спроб входу. Спробуйте через 20 хвилин.');
  var u=all_('Users').filter(function(x){return x.login===login && x.active==='1';})[0];
  var expected=u?u.hash:'', incoming=hashPassword_(pw,u?u.salt:'not-a-user');
  if(!u || expected!==incoming){cache.put(key,String(failures+1),1200);throw new Error('Невірний логін або пароль');}
  cache.remove(key);
  var token=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
  cache.put('S_'+digest_(token),JSON.stringify({id:u.id,version:u.version}),CFG_.SESSION_SECONDS);
  return {token:token,user:publicUser_(u),mustChange:u.must_change==='1'};
}
function changePassword_(user,data) {
  var old=String(data.old||''), fresh=String(data.fresh||'');
  if(hashPassword_(old,user.salt)!==user.hash)throw new Error('Поточний пароль неправильний');
  if(fresh.length<12 || fresh.length>100 || !/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(fresh) || !/[0-9]/.test(fresh))throw new Error('Новий пароль: 12–100 символів, літери та цифри.');
  if(fresh===old)throw new Error('Новий пароль має відрізнятися');
  var salt=Utilities.getUuid();
  updateUser_(user.id,{salt:salt,hash:hashPassword_(fresh,salt),must_change:'0',version:String(Number(user.version)+1)});
  logAudit_(user.id,'PASSWORD','Пароль змінено');
  return {ok:true, relogin:true};
}
function requireRole_(user,roles){if(roles.indexOf(user.role)<0)throw new Error('Недостатньо прав для цієї дії');}
function withLock_(callback){var lock=LockService.getScriptLock();lock.waitLock(25000);try{return callback();}finally{lock.releaseLock();}}
function publicUser_(u){return {id:u.id,login:u.login,name:u.name,role:u.role,active:u.active==='1'};}
function logAudit_(by,action,details){append_('Audit',[Utilities.getUuid(),now_(),by,action,text_(details,1000)]);}
/** Push device tokens are credentials to receive alerts, never account authentication. */
function pushSheet_(){
  var book=db_(),sheet=book.getSheetByName('PushTokens');
  if(!sheet){
    sheet=book.insertSheet('PushTokens');
    sheet.appendRow(['id','user_id','device_id','fcm_token','active','created_at']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function registerPush_(user,data){
  var deviceId=String(data.deviceId||''),token=String(data.fcmToken||'');
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(deviceId))throw new Error('Невірний ID телефону');
  if(!/^[A-Za-z0-9_:.-]{30,4096}$/.test(token))throw new Error('Невірний токен Firebase');
  var sheet=pushSheet_(),rows=sheet.getDataRange().getDisplayValues();
  for(var i=1;i<rows.length;i++){
    if(rows[i][2]===deviceId && rows[i][1]===user.id &&
       rows[i][3]===token && rows[i][4]==='1')return {ok:true,alreadyRegistered:true};
    // Prevent messages for another account or an outdated FCM registration.
    if((rows[i][2]===deviceId || rows[i][3]===token) && rows[i][4]==='1')
      sheet.getRange(i+1,5).setValue('0');
  }
  append_('PushTokens',[Utilities.getUuid(),user.id,deviceId,token,'1',now_()]);
  return {ok:true};
}
function unregisterPush_(user,data){
  var deviceId=String(data.deviceId||'');
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(deviceId))throw new Error('Невірний ID телефону');
  var sheet=db_().getSheetByName('PushTokens');
  if(!sheet)return {ok:true};
  var rows=sheet.getDataRange().getDisplayValues();
  for(var i=1;i<rows.length;i++)
    if(rows[i][1]===user.id && rows[i][2]===deviceId && rows[i][4]==='1')
      sheet.getRange(i+1,5).setValue('0');
  return {ok:true};
}

/** A service-account JSON belongs in Script Properties as FCM_SERVICE_ACCOUNT_JSON.
 * Do not put it into GitHub, Android, HTML or client-visible APIs.
 */
function fcmServiceAccount_(){
  var raw=PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON');
  if(!raw)return null;
  var sa=JSON.parse(raw);
  if(!sa.client_email||!sa.private_key||!sa.project_id)
    throw new Error('Incomplete FCM_SERVICE_ACCOUNT_JSON in Script Properties');
  return sa;
}
function fcmBase64Url_(value){
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(value).getBytes()).replace(/=+$/,'');
}
function fcmAccessToken_(sa){
  var cache=CacheService.getScriptCache();
  var previous=cache.get('OBSHCHAK_FCM_OAUTH');
  if(previous)return previous;
  var seconds=Math.floor(Date.now()/1000);
  var head=fcmBase64Url_(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var claim=fcmBase64Url_(JSON.stringify({
    iss:sa.client_email,
    scope:'https://www.googleapis.com/auth/firebase.messaging',
    aud:'https://oauth2.googleapis.com/token',
    iat:seconds,
    exp:seconds+3500
  }));
  var unsigned=head+'.'+claim;
  var signature=Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned,sa.private_key)).replace(/=+$/,'');
  var response=UrlFetchApp.fetch('https://oauth2.googleapis.com/token',{
    method:'post',
    payload:{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature},
    muteHttpExceptions:true
  });
  if(response.getResponseCode()!==200)
    throw new Error('FCM OAuth authorization failed (HTTP '+response.getResponseCode()+')');
  var answer=JSON.parse(response.getContentText());
  if(!answer.access_token)throw new Error('No FCM OAuth access token');
  cache.put('OBSHCHAK_FCM_OAUTH',answer.access_token,3300);
  return answer.access_token;
}

/** A safe diagnostic which doesn't send messages or modify the accounting database. */
function checkFirebasePush_(){
  var sa=fcmServiceAccount_();
  if(!sa){Logger.log('Firebase not configured: set FCM_SERVICE_ACCOUNT_JSON');return;}
  var token=fcmAccessToken_(sa);
  Logger.log('Firebase service account authorized: '+sa.client_email+'; token ready: '+Boolean(token));
}

/** A notification failure may never roll back or duplicate a ledger operation. */
function sendFirebaseEvent_(eventId,type,summary,actorId){
  if(['TRANSACTION','CORRECTION','RECEIPT','COMMENT','ELECTION','HANDOVER'].indexOf(type)<0)return;
  var sa=fcmServiceAccount_();
  if(!sa)return; // The old 15-minute notification polling remains available.
  var sheet=db_().getSheetByName('PushTokens');
  if(!sheet)return;
  var rows=sheet.getDataRange().getDisplayValues();
  if(rows.length<2)return;
  var recipients={},active={};
  all_('Users').forEach(function(u){if(u.active==='1')active[u.id]=true;});
  rows.slice(1).forEach(function(row){
    if(row[4]==='1'&&active[row[1]]&&row[1]!==actorId)
      recipients[row[3]]={user_id:row[1],token:row[3]};
  });
  var tokens=Object.keys(recipients);
  if(!tokens.length)return;
  var oauth=fcmAccessToken_(sa);
  var endpoint='https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(sa.project_id)+'/messages:send';
  // Data-only messages always invoke the Android FirebaseMessagingService.
  // No check/photo/user credentials are ever embedded in a push.
  var requests=tokens.map(function(key){
    var row=recipients[key];
    return {
      url:endpoint,
      method:'post',
      contentType:'application/json',
      headers:{Authorization:'Bearer '+oauth},
      muteHttpExceptions:true,
      payload:JSON.stringify({message:{
        token:row.token,
        data:{
          event_id:eventId,
          user_id:row.user_id,
          type:type,
          summary:text_(summary,160)
        },
        android:{priority:'HIGH',ttl:'3600s'}
      }})
    };
  });
  var responses=UrlFetchApp.fetchAll(requests);
  responses.forEach(function(r){
    if(r.getResponseCode()>=300)
      console.warn('FCM send response HTTP '+r.getResponseCode());
  });
}
function event_(type,summary,by,ref){
  var id=Utilities.getUuid();
  append_('Events',[id,type,text_(summary,450),now_(),by,ref||'']);
  try{sendFirebaseEvent_(id,type,summary,by);}catch(error){
    console.warn('Non-fatal FCM delivery problem: '+String(error));
  }
}


function state_(user) {
  var ledger=all_('Ledger'), receipts=all_('Receipts'), elections=all_('Elections'), ballots=all_('Ballots');
  var report=calc_(ledger);
  // Ledger sheet rows are append-only, so this order is the authoritative posting order,
  // including corrections and transactions with backdated business dates.
  var runningBalance=0;
  ledger.forEach(function(entry,index){
    runningBalance+=Number(entry.amount)||0;
    entry.balance_after=runningBalance;
    entry.posting_order=index;
  });
  return {
    me:publicUser_(user),today:today_(),
    users:all_('Users').map(publicUser_),
    ledger:ledger.sort(function(a,b){return b.created_at.localeCompare(a.created_at);}),
    receipts:receipts,
    comments:all_('Comments').sort(function(a,b){return a.created_at.localeCompare(b.created_at);}),
    elections:elections.sort(function(a,b){return b.created_at.localeCompare(a.created_at);}),
    ballots:ballots,handovers:all_('Handovers'),
    events:all_('Events').slice(-80).reverse(),
    audit:all_('Audit').slice(-80).reverse(),
    totals:report
  };
}
function calc_(ledger, lookupRows){
  var byId={}, income=0, expense=0, balance=0;
  (lookupRows||ledger).forEach(function(x){byId[x.id]=x;});
  ledger.forEach(function(x){
    var a=Number(x.amount);if(!isFinite(a))return;
    balance+=a;
    var orig=x.kind==='REVERSAL'?byId[x.correction_of]:x;
    if(!orig)return;
    if(orig.kind==='IN')income+=a;
    if(orig.kind==='OUT')expense-=a;
  });
  return {income:income,expense:expense,balance:balance};
}
function amount_(raw) {
  var s=String(raw).trim().replace(',','.');
  if(!/^\d{1,9}(\.\d{1,2})?$/.test(s))throw new Error('Сума має бути додатним числом із максимум 2 знаками після коми');
  var parts=s.split('.'), cents=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
  if(cents<=0 || cents>CFG_.MAX_TXN)throw new Error('Недопустима сума');
  return cents;
}
function amountZero_(raw){var t=String(raw).trim().replace(',','.');if(/^0(?:\.0{1,2})?$/.test(t))return 0;return amount_(raw);}
function date_(s){s=String(s||'');if(!/^20\d\d-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(s))throw new Error('Неправильна дата');var d=new Date(s+'T12:00:00Z');if(isNaN(d.getTime())||d.toISOString().slice(0,10)!==s)throw new Error('Неіснуюча дата');return s;}
function validReceipt_(r){
  if(!r)return null;
  var mime=String(r.mime||''), allowed=['image/jpeg','image/png','image/webp','application/pdf'];
  if(allowed.indexOf(mime)<0)throw new Error('Дозволені JPG, PNG, WebP або PDF');
  if(!r.data || typeof r.data!=='string' || r.data.length>2800000)throw new Error('Файл відсутній або завеликий (до 2 МБ)');
  var bytes=Utilities.base64Decode(r.data);
  if(bytes.length>CFG_.MAX_RECEIPT_BYTES || bytes.length<10)throw new Error('Максимальний розмір чека — 2 МБ');
  var prefix=bytes.slice(0,5).map(function(b){return (b+256)%256;});
  var ok=mime==='application/pdf' ? prefix[0]===37 && prefix[1]===80 && prefix[2]===68 && prefix[3]===70 :
    mime==='image/png' ? prefix[0]===137 && prefix[1]===80 && prefix[2]===78 && prefix[3]===71 :
    mime==='image/jpeg' ? prefix[0]===255 && prefix[1]===216 :
    prefix[0]===82 && prefix[1]===73 && prefix[2]===70 && prefix[3]===70;
  if(!ok)throw new Error('Формат файлу не відповідає його вмісту');
  return {mime:mime,bytes:bytes,name:text_(r.name||'check',100).replace(/[\/\\<>:*?"|]/g,'_')};
}
function saveReceipt_(r, ledgerId,user,clientId) {
  var folder=DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('RECEIPT_FOLDER_ID'));
  var blob=Utilities.newBlob(r.bytes,r.mime,r.name),file=folder.createFile(blob);
  try{
    var row=[clientId||Utilities.getUuid(),ledgerId,file.getId(),r.name,r.mime,String(r.bytes.length),now_(),user.id];
    append_('Receipts',row);
    return {id:row[0],ledger_id:ledgerId,filename:r.name};
  }catch(err){file.setTrashed(true);throw err;}
}
function openingBalance_(user,data){
  requireRole_(user,['CASHIER']);
  if(all_('Ledger').length)throw new Error('Початковий залишок можна внести лише до першої операції');
  var cents=amountZero_(data.amount), id=Utilities.getUuid();
  append_('Ledger',[id,today_(),now_(),'OPENING',cents,'','Початковий залишок','','','Залишок на початок обліку','','',user.id]);
  event_('TRANSACTION','Внесено початковий залишок: '+money_(cents)+' грн',user.id,id);
  logAudit_(user.id,'OPENING','Початковий залишок: '+cents+' коп.');
  return {ok:true};
}
function addTransaction_(user,data){
  requireRole_(user,['CASHIER']);
  // Android repeats requests after network loss. Stable client ID prevents double spending entries.
  var clientId=String(data.clientId||'');
  if (clientId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      throw new Error('Некоректний ID операції');
    var previous=all_('Ledger').filter(function(x){return x.id===clientId;})[0];
    if (previous) {
      if (previous.created_by!==user.id)throw new Error('Операція з таким ID уже існує');
      var expectedKind=String(data.kind||'');
      var expectedSigned=(expectedKind==='OUT'?-1:1)*amount_(data.amount);
      if (previous.kind!==expectedKind || Number(previous.amount)!==expectedSigned || previous.date!==String(data.date||'') || previous.purpose!==String(data.purpose||'').trim())
        throw new Error('Повторний ID з іншими реквізитами. Операцію не дубльовано.');
      return {ok:true,id:previous.id,alreadyExists:true};
    }
  }

  var kind=String(data.kind||''), cents=amount_(data.amount), d=date_(data.date), personId='',personName='',method='',category='',purpose=needed_(data.purpose,'Призначення',300),noReason='';
  if(kind==='IN') {
    method=String(data.method||'');if(['CASH','BANK'].indexOf(method)<0)throw new Error('Вкажіть: готівка або картка');
    personId=String(data.personId||'');
    if(personId){var person=findUser_(personId);if(!person)throw new Error('Учасника не знайдено');personName=person.name;}
    else personName=needed_(data.personName,'Хто вніс гроші',100);
  } else if(kind==='OUT'){
    category=needed_(data.category,'Категорія витрати',80);
    noReason=text_(data.noReceiptReason,500);
  } else throw new Error('Виберіть прихід або розхід');
  var r=kind==='OUT'?validReceipt_(data.receipt):null;
  if(kind==='OUT'&&!r&&!noReason)throw new Error('Додайте чек або поясніть, чому його немає');
  var id=clientId||Utilities.getUuid();
  // Спочатку додаємо запис до книги. При збої збереження чека витрата залишається з поясненням.
  // Тому чек створюється першим і запис витрати — тільки після успішної перевірки файлу.
  var file=null;
  if(r){var folder=DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('RECEIPT_FOLDER_ID'));file=folder.createFile(Utilities.newBlob(r.bytes,r.mime,r.name));}
  try {
    append_('Ledger',[id,d,now_(),kind,kind==='IN'?cents:-cents,personId,personName,method,category,purpose,noReason,'',user.id]);
    if(file)append_('Receipts',[Utilities.getUuid(),id,file.getId(),r.name,r.mime,String(r.bytes.length),now_(),user.id]);
  }catch(err){if(file)file.setTrashed(true);throw err;}
  var label=kind==='IN'?'Прихід':'Розхід';
  event_('TRANSACTION',label+': '+(cents/100).toFixed(2)+' грн — '+purpose,user.id,id);
  logAudit_(user.id,kind,'Операція '+id+' на '+cents+' коп.');
  return {ok:true,id:id};
}
function reverseTransaction_(user,data){
  requireRole_(user,['CASHIER']);
  var id=String(data.id||''), reason=needed_(data.reason,'Причина коригування',500);
  if(reason.length<5)throw new Error('Поясніть причину коригування (не менше 5 символів)');
  var ledger=all_('Ledger'), orig=ledger.filter(function(r){return r.id===id;})[0];
  if(!orig || ['IN','OUT'].indexOf(orig.kind)<0)throw new Error('Можна скасувати тільки первинну операцію');
  if(ledger.some(function(r){return r.kind==='REVERSAL'&&r.correction_of===id;}))throw new Error('Ця операція вже скасована');
  var revId=Utilities.getUuid();
  append_('Ledger',[revId,today_(),now_(),'REVERSAL',String(-Number(orig.amount)),orig.person_id,orig.person_name,orig.method,orig.category,'Сторно: '+reason,'',id,user.id]);
  event_('CORRECTION','Коригування операції: '+orig.purpose,user.id,id);
  logAudit_(user.id,'REVERSE','Сторновано '+id+' через '+revId+': '+reason);
  return {ok:true,id:revId};
}
function addReceipt_(user,data) {
  requireRole_(user,['CASHIER']);
  var clientId=String(data.receiptId||'');
  if (clientId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
      throw new Error('Некоректний ID чека');
    var existing=all_('Receipts').filter(function(r){return r.id===clientId;})[0];
    if (existing) {
      if (existing.ledger_id!==String(data.ledgerId||'') || existing.created_by!==user.id)
        throw new Error('Чек із цим ID уже належить іншій операції');
      return {ok:true,item:{id:existing.id,ledger_id:existing.ledger_id,filename:existing.filename},alreadyExists:true};
    }
  }

  var id=String(data.ledgerId||''), orig=all_('Ledger').filter(function(r){return r.id===id;})[0];
  if(!orig||orig.kind!=='OUT')throw new Error('Чек можна додати тільки до витрати');
  var r=validReceipt_(data.receipt);if(!r)throw new Error('Оберіть файл');
  var item=saveReceipt_(r,id,user,clientId);
  event_('RECEIPT','Додано чек до витрати: '+orig.purpose,user.id,id);
  logAudit_(user.id,'RECEIPT','Файл до операції '+id);
  return {ok:true,item:item};
}
function getReceipt_(user,data){
  var id=String(data.id||''), item=all_('Receipts').filter(function(r){return r.id===id;})[0];
  if(!item)throw new Error('Чек не знайдено');
  var bytes=DriveApp.getFileById(item.file_id).getBlob().getBytes();
  if(bytes.length>CFG_.MAX_RECEIPT_BYTES)throw new Error('Завеликий файл');
  return {name:item.filename,mime:item.mime,data:Utilities.base64Encode(bytes)};
}
function comment_(user,data){
  var id=String(data.ledgerId||''),msg=needed_(data.message,'Запитання або відповідь',CFG_.MAX_MESSAGE);
  var clientId=String(data.clientId||'');
  if(clientId && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(clientId))throw new Error('Невірний ID повідомлення');
  // Stable ID makes retries after ambiguous network failures safe.
  if(clientId){
    var duplicate=all_('Comments').filter(function(c){return c.id===clientId;})[0];
    if(duplicate){
      if(duplicate.ledger_id!==id || duplicate.author_id!==user.id || duplicate.message!==msg)
        throw new Error('Повторний ID повідомлення з іншими даними');
      return {ok:true,id:clientId,alreadyExists:true};
    }
  }
  if(!all_('Ledger').some(function(r){return r.id===id&&r.kind==='OUT';}))throw new Error('Витрату не знайдено');
  var newId=clientId||Utilities.getUuid();
  append_('Comments',[newId,id,user.id,msg,now_()]);
  event_('COMMENT',user.name+' залишив(ла) коментар щодо витрати',user.id,id);
  return {ok:true,id:newId};
}
function invite_(user,data){
  requireRole_(user,['CASHIER','RESERVE']);
  var users=all_('Users');if(users.filter(function(u){return u.active==='1';}).length>=CFG_.MAX_USERS)throw new Error('Дозволено максимум 10 активних учасників');
  var login=text_(data.login,40).toLowerCase(),name=needed_(data.name,'Ім’я учасника',80);
  if(!/^[a-z0-9._-]{3,30}$/.test(login))throw new Error('Логін: 3–30 символів, латинські літери, цифри, крапка, дефіс або _');
  if(users.some(function(u){return u.login===login;}))throw new Error('Цей логін уже зайнятий');
  var pwd=tempPassword_(),salt=Utilities.getUuid(),uid=Utilities.getUuid();
  append_('Users',[uid,login,name,'MEMBER',salt,hashPassword_(pwd,salt),'1','1',now_(),'1']);
  logAudit_(user.id,'INVITE','Додано учасника '+name+' ('+login+')');
  event_('USER','Додано учасника '+name,user.id,uid);
  return {ok:true,login:login,password:pwd};
}
function resetPassword_(user,data){
  requireRole_(user,['CASHIER','RESERVE']);
  var other=findUser_(data.id);if(!other)throw new Error('Учасника не знайдено');
  if(user.role==='RESERVE' && other.role==='CASHIER')throw new Error('Резервний адміністратор не може скидати пароль касира');
  if(other.id===user.id)throw new Error('Свій пароль змінюйте в особистих налаштуваннях');
  var pwd=tempPassword_(),salt=Utilities.getUuid();
  updateUser_(other.id,{salt:salt,hash:hashPassword_(pwd,salt),must_change:'1',version:String(Number(other.version)+1)});
  logAudit_(user.id,'RESET','Скинуто пароль користувача '+other.login);
  return {ok:true,login:other.login,password:pwd};
}
function toggleUser_(user,data){
  requireRole_(user,['CASHIER','RESERVE']);
  var other=findUser_(data.id);if(!other||other.role==='CASHIER'||other.id===user.id)throw new Error('Не можна змінити доступ до цього облікового запису');
  var newActive=other.active==='1'?'0':'1';
  if(newActive==='0'){
    var election=activeElection_(),electors=election&&electionElectorate_(election);
    if(election && (!electors || electors.indexOf(other.id)>=0))
      throw new Error('Не можна заблокувати виборця під час незавершених виборів касира');
  }
  if(newActive==='1'&&activeParticipants_().length>=CFG_.MAX_USERS)throw new Error('Максимум 10 активних учасників');
  if(user.role==='RESERVE' && other.role==='RESERVE')throw new Error('Не можна вимкнути резервного адміністратора');
  updateUser_(other.id,{active:newActive,version:String(Number(other.version)+1)});
  logAudit_(user.id,'ACCESS',(newActive==='1'?'Активовано ':'Вимкнено ')+other.login);
  return {ok:true};
}
function setReserve_(user,data){
  requireRole_(user,['CASHIER']);
  var candidate=findUser_(data.id);
  if(!candidate || candidate.active!=='1' || candidate.id===user.id)throw new Error('Виберіть іншого активного учасника');
  all_('Users').filter(function(u){return u.role==='RESERVE'&&u.id!==candidate.id;}).forEach(function(u){updateUser_(u.id,{role:'MEMBER',version:String(Number(u.version)+1)});});
  updateUser_(candidate.id,{role:'RESERVE',version:String(Number(candidate.version)+1)});
  logAudit_(user.id,'RESERVE','Призначено резервного адміністратора '+candidate.name);
  event_('USER','Резервний адміністратор: '+candidate.name,user.id,candidate.id);
  return {ok:true};
}
// Ліміт — максимум 10 одночасно активних осіб, але мінімуму для обліку немає.
function activeParticipants_(){return all_('Users').filter(function(u){return u.active==='1';});}
function voteThreshold_(count){return Math.floor(count/2)+1;}
// Кожні вибори мають фіксований список виборців на момент ініціативи.
// Для старої бази v1.0 відсутні два поля: додаємо їх без видалення старих записів.
function ensureElectionColumns_(){
  var sh=sheet_('Elections'), heads=sh.getDataRange().getDisplayValues()[0]||[];
  ['electorate','required_votes'].forEach(function(h){
    if(heads.indexOf(h)<0){sh.getRange(1,heads.length+1).setValue(h);heads.push(h);}
  });
}
function electionElectorate_(e){
  // Незавершені голосування зі старої версії зберігають старі правила (6 із 10).
  if(!e.electorate)return null;
  try{var ids=JSON.parse(e.electorate);return Array.isArray(ids)?ids:null;}catch(err){throw new Error('Пошкоджено список виборців: '+e.id);}
}
function electionSize_(e){var a=electionElectorate_(e);return a?a.length:10;}
function electionRequired_(e){return e.required_votes?Number(e.required_votes):6;}
function activeElection_(){return all_('Elections').filter(function(e){return ['PROPOSED','VOTING','APPROVED'].indexOf(e.status)>=0;})[0];}
function updateElection_(id,patch){var sh=sheet_('Elections'),rows=sh.getDataRange().getDisplayValues(),head=rows[0],row=-1;for(var i=1;i<rows.length;i++){if(rows[i][0]===id){row=i+1;break;}}if(row<0)throw new Error('Голосування не знайдено');Object.keys(patch).forEach(function(k){sh.getRange(row,head.indexOf(k)+1).setValue(String(patch[k]));});}
function proposeElection_(user,data){
  var voters=activeParticipants_();
  if(voters.length<3)throw new Error('Вибори касира доступні лише від 3 активних учасників. Зараз: '+voters.length+'.');
  var candidate=findUser_(data.candidateId);
  if(!candidate||candidate.active!=='1'||candidate.role==='CASHIER')throw new Error('Виберіть активного кандидата, який не є касиром');
  if(activeElection_())throw new Error('Уже є незавершене голосування');
  ensureElectionColumns_();
  var threshold=voteThreshold_(voters.length),id=Utilities.getUuid();
  append_('Elections',[id,user.id,'',candidate.id,'PROPOSED',now_(),now_(),'',JSON.stringify(voters.map(function(x){return x.id;})),threshold]);
  event_('ELECTION','Ініціатива виборів нового касира: '+candidate.name+' (поріг '+threshold+' із '+voters.length+')',user.id,id);
  logAudit_(user.id,'ELECTION_PROPOSE','Кандидат '+candidate.name+', учасників '+voters.length+', поріг '+threshold);
  return {ok:true};
}
function supportElection_(user,data){
  var e=activeElection_();if(!e||e.id!==String(data.id)||e.status!=='PROPOSED')throw new Error('Ініціативу вже не можна підтримати');
  if(e.initiator===user.id)throw new Error('Другим ініціатором має бути інший учасник');
  var electors=electionElectorate_(e);
  if(electors && electors.indexOf(user.id)<0)throw new Error('Підтримати ініціативу можуть учасники, які були в общаку на початку виборів');
  if(findUser_(e.candidate_id).active!=='1')throw new Error('Кандидат більше не має доступу');
  updateElection_(e.id,{supporter:user.id,status:'VOTING',updated_at:now_()});
  event_('ELECTION','Відкрито голосування за нового касира',user.id,e.id);
  logAudit_(user.id,'ELECTION_SUPPORT','Підтримано '+e.id);
  return {ok:true};
}
function castVote_(user,data){
  var e=activeElection_();if(!e||e.id!==String(data.id)||e.status!=='VOTING')throw new Error('Немає активного голосування');
  var electors=electionElectorate_(e);
  if(electors && electors.indexOf(user.id)<0)throw new Error('У цьому голосуванні беруть участь лише учасники, які були активні при його початку');
  if(all_('Ballots').some(function(b){return b.election_id===e.id && b.voter_id===user.id;}))throw new Error('Ви вже проголосували');
  var choice=String(data.vote||'');if(['YES','NO'].indexOf(choice)<0)throw new Error('Неприпустимий вибір');
  append_('Ballots',[Utilities.getUuid(),e.id,user.id,choice,now_()]);
  var votes=all_('Ballots').filter(function(b){return b.election_id===e.id;});
  var yes=votes.filter(function(b){return b.vote==='YES';}).length, no=votes.filter(function(b){return b.vote==='NO';}).length;
  var total=electionSize_(e),needed=electionRequired_(e);
  if(yes>=needed) {
    updateElection_(e.id,{status:'APPROVED',updated_at:now_()});
    event_('ELECTION','Кандидат набрав '+yes+' голосів «За» (потрібно '+needed+' із '+total+'). Очікується його згода',user.id,e.id);
  } else if(no>total-needed || votes.length>=total){
    updateElection_(e.id,{status:'FAILED',updated_at:now_()});
    event_('ELECTION','Голосування завершено без обрання касира',user.id,e.id);
  }
  logAudit_(user.id,'VOTE','Голосування '+e.id+' — '+choice);
  return {ok:true,yes:yes,no:no};
}
function acceptElection_(user,data){
  var e=activeElection_();if(!e||e.id!==String(data.id)||e.status!=='APPROVED'||e.candidate_id!==user.id)throw new Error('Підтвердити призначення може тільки обраний кандидат');
  var old=all_('Users').filter(function(u){return u.role==='CASHIER'&&u.active==='1';})[0];
  if(!old)throw new Error('Не знайдено попереднього касира');
  var balance=calc_(all_('Ledger')).balance;
  updateUser_(old.id,{role:'MEMBER',version:String(Number(old.version)+1)});
  updateUser_(user.id,{role:'CASHIER',version:String(Number(user.version)+1)});
  updateElection_(e.id,{status:'COMPLETED',updated_at:now_(),book_balance:String(balance)});
  event_('ELECTION','Новий касир: '+user.name+'. Обліковий залишок при зміні: '+(balance/100).toFixed(2)+' грн',user.id,e.id);
  logAudit_(user.id,'CASHIER_HANDOVER','Роль передана від '+old.name+' до '+user.name+'; обліковий залишок '+balance+' коп. Фактичну передачу коштів необхідно підтвердити окремо.');
  return {ok:true};
}
function recordHandover_(user,data){
  requireRole_(user,['CASHIER']);
  var id=String(data.id||''),e=all_('Elections').filter(function(x){return x.id===id&&x.status==='COMPLETED';})[0];
  if(!e || e.candidate_id!==user.id)throw new Error('Акт може оформити тільки обраний касир');
  if(all_('Handovers').some(function(h){return h.election_id===id;}))throw new Error('Передачу вже зафіксовано');
  var actual=amountZero_(data.actual), book=Number(e.book_balance), diff=actual-book;
  if(!isFinite(book))throw new Error('Не збережено обліковий залишок на момент передачі');
  var explanation=text_(data.explanation,700);
  if(diff!==0 && explanation.length<5)throw new Error('Поясніть розбіжність не менше 5 символів');
  var hid=Utilities.getUuid();
  append_('Handovers',[hid,id,book,actual,diff,explanation,now_(),user.id]);
  event_('HANDOVER','Передача каси: фактично '+money_(actual)+' грн; розбіжність '+money_(diff)+' грн',user.id,id);
  logAudit_(user.id,'HANDOVER','Каса: за обліком '+book+' коп., фактично '+actual+' коп., різниця '+diff+' коп.; '+explanation);
  return {ok:true,book:book,actual:actual,difference:diff};
}
function reportPdf_(user,data){
  var from=date_(data.from),to=date_(data.to);if(from>to)throw new Error('Неправильний період');
  var ledger=all_('Ledger'), byId={};ledger.forEach(function(t){byId[t.id]=t;});
  var before=ledger.filter(function(t){return t.date<from;}), filtered=ledger.filter(function(t){return t.date>=from&&t.date<=to;}).sort(function(a,b){return a.date.localeCompare(b.date);});
  if(filtered.length>500)throw new Error('Для PDF оберіть коротший період (до 500 записів)');
  var begin=calc_(before,ledger).balance, net=calc_(filtered,ledger), end=begin+net.balance;
  var users={};all_('Users').forEach(function(u){users[u.id]=u.name;});
  var receipts=all_('Receipts'), receiptIds={};receipts.forEach(function(r){receiptIds[r.ledger_id]=true;});
  var doc=DocumentApp.create('ОБЩАК — тимчасовий звіт');
  try {
    var body=doc.getBody();
    body.appendParagraph('ОБЩАК — ЗВІТ КАСИ').setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph('Період: '+from+' — '+to);
    body.appendParagraph('Залишок на початок: '+money_(begin)+' грн');
    body.appendParagraph('Прихід (з урахуванням коригувань): '+money_(net.income)+' грн');
    body.appendParagraph('Розхід (з урахуванням коригувань): '+money_(net.expense)+' грн');
    body.appendParagraph('Залишок на кінець: '+money_(end)+' грн').editAsText().setBold(true);
    body.appendParagraph('Деталізація операцій').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var rows=[['Дата','Тип','Сума, грн','Опис / учасник','Чек']];
    filtered.forEach(function(t){
      var typ=t.kind==='IN'?'Прихід':t.kind==='OUT'?'Розхід':'Коригування';
      var desc=(t.person_name?t.person_name+' · ':'')+t.purpose;
      if(t.kind==='REVERSAL') desc+=' (до № '+t.correction_of.slice(0,8)+')';
      var r=t.kind==='OUT'?(receiptIds[t.id]?'Є чек':'Немає: '+(t.no_receipt_reason||'причина не вказана')):'—';
      rows.push([t.date,typ,money_(Number(t.amount)),desc.slice(0,300),r.slice(0,130)]);
    });
    body.appendTable(rows);
    body.appendParagraph('Фотографії чеків у PDF не включаються. Вони доступні в застосунку.');
    body.appendParagraph('Звіт сформовано: '+now_()+' · '+user.name);
    doc.saveAndClose();
    var file=DriveApp.getFileById(doc.getId()), pdf=file.getAs(MimeType.PDF);
    var ret={name:'OBSHCHAK_'+from+'_'+to+'.pdf',mime:'application/pdf',data:Utilities.base64Encode(pdf.getBytes())};
    file.setTrashed(true);
    return ret;
  }catch(err){try{doc.saveAndClose();DriveApp.getFileById(doc.getId()).setTrashed(true);}catch(ignore){}throw err;}
}
function money_(c){var n=Number(c)/100;return n.toFixed(2).replace('.',',');}


/** Запустити один раз, щоб створити початкову базу та касира. */
function initializeObshchak() {
  setupOwner_();
}