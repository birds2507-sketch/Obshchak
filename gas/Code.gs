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
    Users: ['id','login','name','role','salt','hash','must_change','active','created_at','version','deleted_at'],
    Ledger: ['id','date','created_at','kind','amount','person_id','person_name','method','category','purpose','no_receipt_reason','correction_of','created_by','expense_target','reimbursement_id'],
    Reimbursements: ['id','created_at','requester_id','amount','purpose','category','expense_target','receipt_id','status','approved_by','approved_at','paid_by','paid_at','ledger_id','confirmed_by','confirmed_at','rejected_by','rejected_at','rejection_reason','disputed_at','dispute_reason','appeal_by','appeal_at','appeal_reason','appeal_decision','appeal_decided_by','appeal_decided_at','appeal_decision_reason'],
    ReimbursementComments: ['id','claim_id','author_id','message','created_at'],
    Receipts: ['id','ledger_id','file_id','filename','mime','size','created_at','created_by'],
    Comments: ['id','ledger_id','author_id','message','created_at'],
    Elections: ['id','initiator','supporter','candidate_id','status','created_at','updated_at','book_balance','electorate','required_votes'],
    Ballots: ['id','election_id','voter_id','vote','created_at'],
    Events: ['id','type','summary','created_at','actor_id','ref_id'],
    Audit: ['id','created_at','actor_id','action','details'],
    ReversalRequests: ['id','original_id','requested_by','reason','status','created_at','decided_at','decided_by','reversal_id','objected_by','objection','objected_at','acknowledged_by','acknowledged_at'],
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
    } else if (packet.action==='syncTransaction' || packet.action==='syncReceipt' || packet.action==='syncComment' || packet.action==='syncReimbursement') {
      var deviceUser=authDevice_(String(packet.token||''));
      result=withLock_(function(){
        if(packet.action==='syncTransaction')return addTransaction_(deviceUser,packet.data||{});
        if(packet.action==='syncReceipt')return addReceipt_(deviceUser,packet.data||{});
        if(packet.action==='syncReimbursement')return createReimbursement_(deviceUser,packet.data||{});
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
/** An empty database always starts with an administrator, NOT an automatic cashier.
 * Owner-only functions below are executed in the Apps Script editor, never via api().
 * A previous database and receipt folder remain intact as an offline archive.
 */
function createEmptyObshchakDb_(){
  var book=SpreadsheetApp.create('ОБЩАК — чиста база '+now_());
  Object.keys(CFG_.HEADERS).forEach(function(name,index){
    var sh=index===0?book.getSheets()[0]:book.insertSheet(name);
    sh.setName(name);
    var head=CFG_.HEADERS[name];
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,head.length).setFontWeight('bold').setBackground('#e2e8f0');
    sh.getRange(2,1,Math.max(1,sh.getMaxRows()-1),head.length).setNumberFormat('@');
  });
  var receiptFolder=DriveApp.createFolder('ОБЩАК — чеки від '+now_());
  return {book:book,folder:receiptFolder};
}
function issueFirstAdminCode_(props){
  // Do not store plaintext registration code. Only the owner sees the code
  // in the Apps Script editor's execution log; registration is one-time.
  var secret=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
  props.setProperty('FIRST_ADMIN_CODE_HASH',digest_(secret+'|'+props.getProperty('PEPPER')));
  props.setProperty('FIRST_ADMIN_CODE_UNTIL',String(Date.now()+7*24*60*60*1000));
  Logger.log('ОБЩАК: КОД ПЕРШОГО АДМІНІСТРАТОРА (діє 7 днів): %s',secret);
  Logger.log('Зареєструйте адміністратора у застосунку/вебверсії. НІКОМУ не передавайте код.');
  return secret;
}
/** Execute ONCE when creating a brand-new script deployment. */
function setupOwner_(){
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty('SHEET_ID'))throw new Error('Базу вже налаштовано. Для тестового перезапуску використайте resetObshchakForCleanStart_().');
  var fresh=createEmptyObshchakDb_();
  props.setProperties({SHEET_ID:fresh.book.getId(),RECEIPT_FOLDER_ID:fresh.folder.getId(),
    PEPPER:Utilities.getUuid()+Utilities.getUuid(),DB_GENERATION:Utilities.getUuid()});
  Logger.log('НОВА ЧИСТА БАЗА: %s',fresh.book.getUrl());
  issueFirstAdminCode_(props);
}
/**
 * Explicit OWNER action from the Apps Script editor ONLY.
 * This creates a new live database, preserves the old one and old receipts
 * as an archive in Drive, and issues a one-time first administrator code.
 * Running it a second time will archive the currently live database again.
 * Do not invoke with unsynced entries on participants' phones.
 */
function resetObshchakForCleanStart_(){
  return withLock_(function(){
    var props=PropertiesService.getScriptProperties();
    var oldId=props.getProperty('SHEET_ID');
    if(!oldId)throw new Error('Бази ще немає. Запустіть setupOwner_().');
    var old=SpreadsheetApp.openById(oldId);
    var oldFolder=props.getProperty('RECEIPT_FOLDER_ID');
    // Create all new resources BEFORE switching any live pointer.
    var next=createEmptyObshchakDb_();
    var newPepper=Utilities.getUuid()+Utilities.getUuid();
    props.setProperties({
      SHEET_ID:next.book.getId(),RECEIPT_FOLDER_ID:next.folder.getId(),
      PEPPER:newPepper,DB_GENERATION:Utilities.getUuid()
    });
    issueFirstAdminCode_(props);
    Logger.log('НОВА БАЗА ОБЩАК: %s',next.book.getUrl());
    Logger.log('АРХІВ ПОПЕРЕДНЬОЇ БАЗИ (НЕ ВИДАЛЕНО): %s',old.getUrl());
    Logger.log('ID АРХІВУ ЧЕКІВ (НЕ ВИДАЛЕНО): %s',oldFolder);
    Logger.log('Після цього очистіть локальні дані на телефонах тестувальників, щоб старі черги не заважали.');
    return {ok:true,newDatabaseUrl:next.book.getUrl(),oldArchiveUrl:old.getUrl()};
  });
}
/** Reissue the code if seven days elapsed; permitted only from the editor. */
function renewFirstAdminCode_(){
  return withLock_(function(){
    var props=PropertiesService.getScriptProperties();
    if(!props.getProperty('SHEET_ID'))throw new Error('Спочатку створіть базу');
    if(all_('Users').length)throw new Error('Перший адміністратор уже зареєстрований');
    issueFirstAdminCode_(props);
  });
}
function firstAdminRegistrationState_(){
  var props=PropertiesService.getScriptProperties();
  if(!props.getProperty('SHEET_ID'))return {needsSetup:true,needsAdmin:false};
  return {needsSetup:false,needsAdmin:all_('Users').length===0};
}
function registerFirstAdmin_(data){
  var props=PropertiesService.getScriptProperties();
  if(!props.getProperty('SHEET_ID')||all_('Users').length)
    throw new Error('Перша реєстрація вже завершена або база не створена');
  var code=String(data.code||'').trim();
  var known=props.getProperty('FIRST_ADMIN_CODE_HASH');
  var expires=Number(props.getProperty('FIRST_ADMIN_CODE_UNTIL')||0);
  if(!known||!code||Date.now()>expires||code.length!==64||
     digest_(code+'|'+props.getProperty('PEPPER'))!==known)
    throw new Error('Невірний або прострочений код першого адміністратора');
  var name=needed_(data.name,'Ім’я адміністратора',80);
  var login=checkNewLogin_([],data);
  var password=validPersonalPassword_(data.password);
  var salt=Utilities.getUuid(),id=Utilities.getUuid();
  append_('Users',[id,login,name,'ADMIN',salt,hashPassword_(password,salt),
    '0','1',now_(),'1','']);
  props.deleteProperty('FIRST_ADMIN_CODE_HASH');
  props.deleteProperty('FIRST_ADMIN_CODE_UNTIL');
  logAudit_(id,'FIRST_ADMIN','Зареєстровано першого адміністратора '+login);
  event_('USER','Створено першого адміністратора '+name,id,id);
  return {ok:true,login:login};
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
  if (action === 'registrationState') return firstAdminRegistrationState_();
  if (action === 'registerFirstAdmin') return withLock_(function(){return registerFirstAdmin_(data);});
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
    // Backward-compatible action: now creates an approval request, never money movement.
    case 'reverseTransaction': return withLock_(function(){return reverseTransaction_(user,data);});
    case 'decideReversal': return withLock_(function(){return decideReversal_(user,data);});
    case 'disputeReversal': return withLock_(function(){return disputeReversal_(user,data);});
    case 'ackReversal': return withLock_(function(){return acknowledgeReversal_(user,data);});
    case 'createReimbursement': return withLock_(function(){return createReimbursement_(user,data);});
    case 'decideReimbursement': return withLock_(function(){return decideReimbursement_(user,data);});
    case 'payReimbursement': return withLock_(function(){return payReimbursement_(user,data);});
    case 'confirmReimbursement': return withLock_(function(){return confirmReimbursement_(user,data);});
    case 'appealReimbursement': return withLock_(function(){return appealReimbursement_(user,data);});
    case 'decideReimbursementAppeal': return withLock_(function(){return decideReimbursementAppeal_(user,data);});
    case 'commentReimbursement': return withLock_(function(){return commentReimbursement_(user,data);});
    case 'addReceipt': return withLock_(function(){return addReceipt_(user,data);});
    case 'getReceipt': return getReceipt_(user,data);
    case 'comment': return withLock_(function(){return comment_(user,data);});
    case 'invite': return withLock_(function(){return invite_(user,data);});
    case 'bootstrapAdmin': return withLock_(function(){return bootstrapAdmin_(user,data);});
    case 'resetPassword': return withLock_(function(){return resetPassword_(user,data);});
    case 'toggleUser': return withLock_(function(){return toggleUser_(user,data);});
    case 'setReserve': return withLock_(function(){return setReserve_(user,data);});
    case 'changeLogin': return withLock_(function(){return changeLogin_(user,data);});
    case 'assignCashier': return withLock_(function(){return assignCashier_(user,data);});
    case 'removeUser': return withLock_(function(){return removeUser_(user,data);});
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
function ensureExpenseTargetColumn_(){
  // Existing Google Sheets keep their rows and current first 13 columns unchanged.
  var sheet=sheet_('Ledger'),header=sheet.getRange(1,1,1,Math.max(13,sheet.getLastColumn())).getDisplayValues()[0];
  if(header[13]==='expense_target')return;
  if(header.indexOf('expense_target')>=0)
    throw new Error('Колонку expense_target розміщено не на позиції 14; потрібна перевірка структури');
  // Add at the end of the old core schema without overwriting manually added columns.
  sheet.insertColumnAfter(13);
  sheet.getRange(1,14).setValue('expense_target');
  sheet.getRange(1,14).setFontWeight('bold').setBackground('#e2e8f0');
}
function ensureReimbursementLedgerColumn_(){
  ensureExpenseTargetColumn_();
  var sh=sheet_('Ledger');
  var header=sh.getRange(1,1,1,Math.max(14,sh.getLastColumn())).getDisplayValues()[0];
  if(header[14]==='reimbursement_id')return;
  if(header.indexOf('reimbursement_id')>=0)
    throw new Error('Неправильне розташування reimbursement_id у журналі');
  sh.insertColumnAfter(14);
  sh.getRange(1,15).setValue('reimbursement_id');
  sh.getRange(1,15).setFontWeight('bold').setBackground('#e2e8f0');
}
function append_(name, values) {
  if(name==='Users'){
    ensureUserArchiveColumn_();
    if(values.length===10)values=values.concat(['']);
  }
  if(name==='Ledger'){
    ensureReimbursementLedgerColumn_();
    if(values.length===13)values=values.concat(['','']);
    if(values.length===14)values=values.concat(['']);
    if(values.length!==15)throw new Error('Неправильна довжина запису журналу');
  }
  sheet_(name).appendRow(values.map(function(v){
    var s=String(v===null || v===undefined ? '' : v);
    return s.charAt(0)==='=' ? "'"+s : s;
  }));
}
function ensureUserArchiveColumn_(){
  var sh=sheet_('Users');
  var head=sh.getRange(1,1,1,Math.max(10,sh.getLastColumn())).getDisplayValues()[0];
  if(head[10]==='deleted_at')return;
  if(head.indexOf('deleted_at')>=0)
    throw new Error('Архівна колонка Users не на позиції 11');
  sh.insertColumnAfter(10);
  sh.getRange(1,11).setValue('deleted_at');
  sh.getRange(1,11).setFontWeight('bold').setBackground('#e2e8f0');
}
function updateUser_(id, patch) {
  ensureUserArchiveColumn_();
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
function validPersonalPassword_(password){
  // Four digits are allowed on request; longer alphanumeric passwords remain supported.
  // Refuse the most guessable PINs, including the separate settings PIN.
  var value=String(password||'');
  if(/^[0-9]{4}$/.test(value)){
    if(/^([0-9])\1{3}$/.test(value) ||
       ['0123','1234','2345','3456','4567','5678','6789','9876','8765','7654',
        '6543','5432','4321','3210','2580','0852','5618'].indexOf(value)>=0)
      throw new Error('Надто простий PIN. Оберіть інші чотири цифри.');
    return value;
  }
  if(value.length<12 || value.length>100 ||
     !/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(value) || !/[0-9]/.test(value))
    throw new Error('Пароль: чотири різні/несистемні цифри або 12–100 символів (літери й цифри).');
  return value;
}

function login_(data) {
  var login=text_(data.login,60).toLowerCase(),pw=String(data.password||'');
  if(!/^[a-z0-9._-]{3,30}$/.test(login) || !pw)
    throw new Error('Невірний логін або пароль');
  return withLock_(function(){
    var u=all_('Users').filter(function(x){return x.login===login && x.active==='1';})[0];
    var cache=CacheService.getScriptCache();
    // A persistent per-account lock makes online guessing of a 4-digit PIN impractical.
    var key='AUTH_TRIES_'+digest_(login).slice(0,28);
    var props=PropertiesService.getScriptProperties();
    var record={count:0,until:0,started:0};
    if(u){
      try{record=JSON.parse(props.getProperty(key)||'{}');}catch(ignore){}
    }else{
      var old=Number(cache.get(key)||0);
      if(old>=5)throw new Error('Забагато спроб входу. Спробуйте пізніше.');
    }
    var now=Date.now();
    if(Number(record.until||0)>now)
      throw new Error('Забагато спроб входу. Спробуйте через 60 хвилин або зверніться до адміністратора.');
    var expected=u?u.hash:'',incoming=hashPassword_(pw,u?u.salt:'not-a-user');
    if(!u||expected!==incoming){
      if(u){
        var count=Number(record.count||0);
        if(now-Number(record.started||0)>60*60*1000){count=0;record.started=now;}
        count++;
        record.count=count;
        if(count>=5){record.until=now+60*60*1000;record.count=0;}
        props.setProperty(key,JSON.stringify(record));
      }else{
        cache.put(key,String(Number(cache.get(key)||0)+1),3600);
      }
      throw new Error('Невірний логін або пароль');
    }
    if(u)props.deleteProperty(key);
    cache.remove(key);
    var token=Utilities.getUuid().replace(/-/g,'')+Utilities.getUuid().replace(/-/g,'');
    cache.put('S_'+digest_(token),JSON.stringify({id:u.id,version:u.version}),CFG_.SESSION_SECONDS);
    return {token:token,user:publicUser_(u),mustChange:u.must_change==='1'};
  });
}
function changePassword_(user,data) {
  var old=String(data.old||''),fresh=validPersonalPassword_(data.fresh);
  if(hashPassword_(old,user.salt)!==user.hash)
    throw new Error('Поточний пароль неправильний');
  if(fresh===old)throw new Error('Новий пароль має відрізнятися');
  var salt=Utilities.getUuid();
  updateUser_(user.id,{salt:salt,hash:hashPassword_(fresh,salt),must_change:'0',
    version:String(Number(user.version)+1)});
  PropertiesService.getScriptProperties().deleteProperty('AUTH_TRIES_'+digest_(user.login).slice(0,28));
  logAudit_(user.id,'PASSWORD','Особистий пароль або PIN змінено');
  return {ok:true,relogin:true};
}
function requireRole_(user,roles){if(roles.indexOf(user.role)<0)throw new Error('Недостатньо прав для цієї дії');}
function withLock_(callback){var lock=LockService.getScriptLock();lock.waitLock(25000);try{return callback();}finally{lock.releaseLock();}}
function publicUser_(u){return {id:u.id,login:u.login,name:u.name,role:u.role,active:u.active==='1',deleted:!!u.deleted_at};}
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
  if(['TRANSACTION','CORRECTION','RECEIPT','COMMENT','ELECTION','HANDOVER','REIMBURSEMENT'].indexOf(type)<0)return;
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
  ensureReversalRequests_();
  return {
    me:publicUser_(user),today:today_(),
    users:all_('Users').map(publicUser_),
    reversalRequests:all_('ReversalRequests').reverse(),
    reimbursements:reimbursements_().reverse(),
    reimbursementComments:all_('ReimbursementComments').reverse(),
    // Stable authoritative insertion order; multiple entries in one second stay ordered.
    ledger:ledger.sort(function(a,b){return Number(b.posting_order)-Number(a.posting_order);}),
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

  var kind=String(data.kind||''), cents=amount_(data.amount), d=date_(data.date), personId='',personName='',method='',category='',expenseTarget='',purpose=needed_(data.purpose,'Призначення',300),noReason='';
  if(kind==='IN') {
    // A single common balance: physical storage is the cashier's responsibility.
    method='';
    personId=String(data.personId||'');
    if(personId){var person=findUser_(personId);if(!person)throw new Error('Учасника не знайдено');personName=person.name;}
    else personName=needed_(data.personName,'Хто вніс гроші',100);
  } else if(kind==='OUT'){
    category=needed_(data.category,'Категорія витрати',80);
    // Optional while earlier versions of the APK are still in use.
    // A blank value is displayed as "Без напряму" in statistics.
    expenseTarget=String(data.expenseTarget||data.expense_target||'').trim();
    if(expenseTarget && ['МП','ГМЕ 1','ГМЕ 2'].indexOf(expenseTarget)<0)
      throw new Error('Оберіть напрям витрати: МП, ГМЕ 1 або ГМЕ 2');
    // Ignore legacy card/cash details; all new expenses use one shared balance.
    method='';
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
    append_('Ledger',[id,d,now_(),kind,kind==='IN'?cents:-cents,personId,personName,method,category,purpose,noReason,'',user.id,expenseTarget]);
    if(file)append_('Receipts',[Utilities.getUuid(),id,file.getId(),r.name,r.mime,String(r.bytes.length),now_(),user.id]);
  }catch(err){if(file)file.setTrashed(true);throw err;}
  var label=kind==='IN'?'Прихід':'Розхід';
  event_('TRANSACTION',label+': '+(cents/100).toFixed(2)+' грн — '+purpose,user.id,id);
  logAudit_(user.id,kind,'Операція '+id+' на '+cents+' коп.');
  return {ok:true,id:id};
}
function ensureReversalRequests_(){
  var db=db_(),sh=db.getSheetByName('ReversalRequests');
  if(!sh){
    sh=db.insertSheet('ReversalRequests');
    sh.appendRow(CFG_.HEADERS.ReversalRequests);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,CFG_.HEADERS.ReversalRequests.length)
      .setFontWeight('bold').setBackground('#e2e8f0');
    sh.getRange(2,1,Math.max(1,sh.getMaxRows()-1),CFG_.HEADERS.ReversalRequests.length)
      .setNumberFormat('@');
  }
  return sh;
}
function reversalRequests_(){ensureReversalRequests_();return all_('ReversalRequests');}
function reversalOriginal_(id){
  var original=all_('Ledger').filter(function(x){return x.id===id;})[0];
  if(!original||['IN','OUT'].indexOf(original.kind)<0)
    throw new Error('Сторнувати можна тільки первинний прихід або витрату');
  return original;
}
function isReversed_(id,ledger){
  return (ledger||all_('Ledger')).some(function(x){
    return x.kind==='REVERSAL'&&x.correction_of===id;
  });
}
function reversalRequest_(id){
  var found=reversalRequests_().filter(function(r){return r.id===id;})[0];
  if(!found)throw new Error('Заявку на сторнування не знайдено');
  return found;
}
function updateReversal_(id,fields){
  var sh=ensureReversalRequests_(),rows=sh.getDataRange().getDisplayValues();
  var index=rows.findIndex(function(row,i){return i>0&&row[0]===id;});
  if(index<0)throw new Error('Заявку не знайдено для оновлення');
  Object.keys(fields).forEach(function(key){
    var column=CFG_.HEADERS.ReversalRequests.indexOf(key);
    if(column<0)throw new Error('Невідоме поле заявки');
    sh.getRange(index+1,column+1).setValue(String(fields[key]));
  });
}
function reverseTransaction_(user,data){
  requireRole_(user,['CASHIER']);
  var id=String(data.id||'');
  var reason=needed_(data.reason,'Причина сторнування',500);
  if(reason.length<5)throw new Error('Причина сторнування — щонайменше 5 символів');
  var orig=reversalOriginal_(id);
  if(isReversed_(id))throw new Error('Ця операція вже сторнована');
  var requests=reversalRequests_();
  if(requests.some(function(r){return r.original_id===id &&
      (r.status==='PENDING'||r.status==='DISPUTED'||r.status==='APPROVED');}))
    throw new Error('Для цієї операції вже є активне або підтверджене сторнування');
  var admins=activeAdministrators_();
  if(!admins.length)
    throw new Error('Перед сторнуванням створіть незалежного адміністратора в «Учасники»');
  var reqId=Utilities.getUuid();
  append_('ReversalRequests',[reqId,id,user.id,reason,'PENDING',now_(),'','','','','','','','']);
  logAudit_(user.id,'REVERSE_REQUEST','Запит на сторнування '+id+': '+reason);
  event_('CORRECTION','⚠ Запит на сторнування '+orig.kind+' '+orig.person_name+
    ' — '+orig.purpose+' (очікує адміністратора)',user.id,reqId);
  return {ok:true,id:reqId,status:'PENDING',balanceChanged:false};
}
function decideReversal_(user,data){
  requireRole_(user,['ADMIN','RESERVE']);
  var id=String(data.id||''),decision=String(data.decision||'');
  if(['APPROVE','REJECT'].indexOf(decision)<0)
    throw new Error('Оберіть підтвердити або відхилити');
  var r=reversalRequest_(id);
  if(r.status!=='PENDING' && r.status!=='DISPUTED')
    throw new Error('Це сторнування вже розглянуто');
  if(user.id===r.requested_by)
    throw new Error('Заявник не може підтверджувати власне сторнування');
  if(decision==='APPROVE'&&r.status==='DISPUTED')
    throw new Error('Сторнування оскаржено учасником. Спочатку відхиліть заявку й розберіться в розбіжності.');
  var reason=needed_(data.reason,'Коментар адміністратора',300);
  if(decision==='REJECT'){
    updateReversal_(id,{status:'REJECTED',decided_at:now_(),decided_by:user.id});
    logAudit_(user.id,'REVERSE_REJECT','Відхилено сторнування '+r.original_id+': '+reason);
    event_('CORRECTION','Сторнування відхилено адміністратором: '+reason,user.id,id);
    return {ok:true,status:'REJECTED',balanceChanged:false};
  }
  var original=reversalOriginal_(r.original_id);
  var ledger=all_('Ledger');
  var existing=ledger.filter(function(x){
    return x.kind==='REVERSAL'&&x.correction_of===r.original_id;
  })[0];
  var revId=existing?existing.id:Utilities.getUuid();
  if(!existing){
    // Only the approving ADMIN may execute a reversal on the ledger.
    append_('Ledger',[revId,today_(),now_(),'REVERSAL',String(-Number(original.amount)),
      original.person_id,original.person_name,original.method,original.category,
      'Сторно (схвалено адміністратором): '+r.reason,'',r.original_id,user.id,
      original.expense_target||'']);
  }
  updateReversal_(id,{status:'APPROVED',decided_at:now_(),
    decided_by:user.id,reversal_id:revId});
  logAudit_(user.id,'REVERSE_APPROVE','Погоджено '+r.original_id+
    ' → '+revId+'; причина: '+r.reason+'; адміністратора: '+reason);
  event_('CORRECTION','Сторнування підтверджено адміністратором: '+
    original.purpose,user.id,r.original_id);
  return {ok:true,status:'APPROVED',id:revId,balanceChanged:true};
}
function disputeReversal_(user,data){
  var id=String(data.id||''),reason=needed_(data.reason,'Пояснення заперечення',300);
  if(reason.length<5)throw new Error('Поясніть заперечення (мінімум 5 символів)');
  var r=reversalRequest_(id);
  if(r.status!=='PENDING')throw new Error('Заперечити можна лише заявку, що очікує розгляду');
  if(user.id===r.requested_by)throw new Error('Касир не може оскаржувати власну заявку');
  updateReversal_(id,{status:'DISPUTED',objected_by:user.id,objection:reason,
    objected_at:now_()});
  logAudit_(user.id,'REVERSE_DISPUTE','Заперечення сторнування '+r.original_id+': '+reason);
  event_('CORRECTION','⚠ Учасник оскаржив сторнування. Адміністратор не може його схвалити.',
    user.id,id);
  return {ok:true,status:'DISPUTED'};
}
function acknowledgeReversal_(user,data){
  var r=reversalRequest_(String(data.id||''));
  if(r.status!=='PENDING')throw new Error('Заявка більше не очікує розгляду');
  var original=reversalOriginal_(r.original_id);
  // Only the confirmed person_id is authoritative; names are free text
  // and must not be treated as account identity.
  if(original.kind!=='IN'||!original.person_id||original.person_id!==user.id)
    throw new Error('Цей внесок не прив’язаний до вашого облікового запису. Ви можете написати заперечення.');
  updateReversal_(r.id,{acknowledged_by:user.id,acknowledged_at:now_()});
  logAudit_(user.id,'REVERSE_ACK','Учасник підтвердив ознайомлення зі сторнуванням '+r.original_id);
  event_('CORRECTION','Учасник підтвердив отримання запиту на сторнування',
    user.id,r.id);
  return {ok:true,status:'PENDING'};
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
/** Reimbursements are separate liabilities; only PAY creates one OUT row. */
function ensureReimbursements_(){
  var book=db_();
  ['Reimbursements','ReimbursementComments'].forEach(function(name){
    var sh=book.getSheetByName(name),head=CFG_.HEADERS[name];
    if(!sh){
      sh=book.insertSheet(name);
      sh.appendRow(head);
      sh.setFrozenRows(1);
      sh.getRange(1,1,1,head.length).setFontWeight('bold').setBackground('#e2e8f0');
      sh.getRange(2,1,Math.max(1,sh.getMaxRows()-1),head.length).setNumberFormat('@');
      return;
    }
    if(name==='Reimbursements'){
      // Append appeal columns without changing or deleting any prior claim or payment.
      var priorHeader=sh.getRange(1,1,1,Math.max(21,sh.getLastColumn())).getDisplayValues()[0];
      var base=head.slice(0,21);
      if(base.some(function(field,i){return priorHeader[i]!==field;}))
        throw new Error('Структура реєстру боргів відрізняється. Зупинено без зміни даних.');
      var newFields=head.slice(21);
      if(newFields.every(function(field,i){return priorHeader[21+i]===field;}))return;
      if(newFields.some(function(field){return priorHeader.indexOf(field)>=0;}))
        throw new Error('Колонки апеляцій змішані. Потрібна перевірка без втрати даних.');
      sh.insertColumnsAfter(21,newFields.length);
      newFields.forEach(function(field,i){
        sh.getRange(1,22+i).setValue(field).setFontWeight('bold').setBackground('#e2e8f0');
      });
      sh.getRange(2,22,Math.max(1,sh.getMaxRows()-1),newFields.length).setNumberFormat('@');
    }
  });
}

function reimbursements_(){ensureReimbursements_();return all_('Reimbursements');}
function reimbursement_(id){
  var item=reimbursements_().filter(function(x){return x.id===String(id||'');})[0];
  if(!item)throw new Error('Заявку на відшкодування не знайдено');
  return item;
}
function updateReimbursement_(id,fields){
  var sh=sheet_('Reimbursements'),rows=sh.getDataRange().getDisplayValues();
  var pos=rows.findIndex(function(row,i){return i>0&&row[0]===id;});
  if(pos<0)throw new Error('Заявку не знайдено');
  Object.keys(fields).forEach(function(name){
    var col=CFG_.HEADERS.Reimbursements.indexOf(name);
    if(col<0)throw new Error('Невідомий реквізит відшкодування');
    sh.getRange(pos+1,col+1).setValue(String(fields[name]));
  });
}
function createReimbursement_(user,data){
  // Any active member (including cashier/admin) may buy for the group.
  var id=String(data.clientId||''),amount=amount_(data.amount);
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))throw new Error('Некоректний ID заявки');
  var description=needed_(data.purpose,'Що придбано',300);
  var direction=String(data.expenseTarget||'').trim();
  if(['МП','ГМЕ 1','ГМЕ 2'].indexOf(direction)<0)
    throw new Error('Оберіть напрям МП, ГМЕ 1 або ГМЕ 2');
  var category=needed_(data.category,'Категорія покупки',80);
  var prior=reimbursements_().filter(function(x){return x.id===id;})[0];
  if(prior){
    if(prior.requester_id!==user.id||Number(prior.amount)!==amount||
       prior.purpose!==description||prior.category!==category||prior.expense_target!==direction)
      throw new Error('Повторна заявка з тим самим ID, але іншими даними');
    return {ok:true,id:id,status:prior.status,alreadyExists:true};
  }
  var receipt=validReceipt_(data.receipt);
  if(!receipt)throw new Error('Для відшкодування обов’язково прикріпіть чек');
  // Idempotent upload: the file's receipt ID equals the claim ID, in another sheet.
  var receiptId=id,receiptMarker='CLAIM:'+id;
  var old=all_('Receipts').filter(function(x){return x.id===receiptId;})[0];
  if(old){
    if(old.created_by!==user.id||old.ledger_id!==receiptMarker)
      throw new Error('Чек із цим ID уже належить іншій операції');
  }else saveReceipt_(receipt,receiptMarker,user,receiptId);
  append_('Reimbursements',[id,now_(),user.id,String(amount),description,category,direction,
    receiptId,'REQUESTED','','','','','','','','','','','','']);
  logAudit_(user.id,'REIMBURSEMENT_REQUEST','Заявка '+id+' на '+amount+' коп.');
  event_('REIMBURSEMENT','Нова заявка на відшкодування від '+user.name+': '+
    (amount/100).toFixed(2)+' ₴ — '+description,user.id,id);
  return {ok:true,id:id,status:'REQUESTED'};
}
function decideReimbursement_(user,data){
  requireRole_(user,['CASHIER']);
  var r=reimbursement_(data.id);
  if(r.status!=='REQUESTED')throw new Error('Заявку вже розглянуто');
  if(r.requester_id===user.id)
    throw new Error('Касир не може сам собі погодити відшкодування');
  var decision=String(data.decision||'');
  if(decision!=='APPROVE'&&decision!=='REJECT')throw new Error('Оберіть рішення');
  if(decision==='REJECT'){
    var reason=needed_(data.reason,'Причина відмови',300);
    updateReimbursement_(r.id,{status:'REJECTED',rejected_by:user.id,
      rejected_at:now_(),rejection_reason:reason});
    logAudit_(user.id,'REIMBURSEMENT_REJECT','Заявку '+r.id+' відхилено: '+reason);
    event_('REIMBURSEMENT','Відшкодування відхилено: '+r.purpose,user.id,r.id);
    return {ok:true,status:'REJECTED'};
  }
  if(!all_('Receipts').some(function(x){
    return x.id===r.receipt_id&&x.ledger_id==='CLAIM:'+r.id;
  }))throw new Error('Чек заявки відсутній');
  updateReimbursement_(r.id,{status:'APPROVED',approved_by:user.id,approved_at:now_()});
  logAudit_(user.id,'REIMBURSEMENT_APPROVE','Погоджено борг '+r.id);
  event_('REIMBURSEMENT','Касир погодив відшкодування: '+r.purpose,user.id,r.id);
  return {ok:true,status:'APPROVED'};
}
function payReimbursement_(user,data){
  requireRole_(user,['CASHIER']);
  var r=reimbursement_(data.id);
  if(!['APPROVED','PAID_PENDING_CONFIRMATION','PAYMENT_DISPUTED'].includes(r.status))
    throw new Error('Спочатку погодьте заявку');
  if(r.requester_id===user.id)throw new Error('Касир не може сам собі виплатити відшкодування');
  var found=all_('Ledger').filter(function(x){return x.reimbursement_id===r.id;})[0];
  var hadLedger=!!found;
  if(!found){
    if(r.status!=='APPROVED')throw new Error('Немає фінансового запису відшкодування: потрібна перевірка');
    var ledgerId=Utilities.getUuid();
    append_('Ledger',[ledgerId,today_(),now_(),'OUT',String(-Number(r.amount)),
      r.requester_id,nameForUser_(r.requester_id),'','Борги / Відшкодування',
      'Відшкодування '+r.purpose+' — '+nameForUser_(r.requester_id),
      '', '',user.id,r.expense_target,r.id]);
    found={id:ledgerId};
  }
  // Reuse the original Drive file in the public expense register. Never copy
  // or charge for the receipt twice, including after a network retry.
  var proof=all_('Receipts').filter(function(x){
    return x.id===r.receipt_id&&x.ledger_id==='CLAIM:'+r.id;
  })[0];
  if(proof&&!all_('Receipts').some(function(x){
    return x.ledger_id===found.id&&x.file_id===proof.file_id;
  })){
    append_('Receipts',[Utilities.getUuid(),found.id,proof.file_id,proof.filename,
      proof.mime,proof.size,now_(),r.requester_id]);
  }
  if(r.status==='APPROVED'){
    updateReimbursement_(r.id,{status:'PAID_PENDING_CONFIRMATION',
      paid_by:user.id,paid_at:now_(),ledger_id:found.id});
    logAudit_(user.id,'REIMBURSEMENT_PAID','Виплачено '+r.id+'; фінансовий запис '+found.id);
    event_('REIMBURSEMENT','Касир позначив виплату: '+r.purpose+
      '. Очікується підтвердження отримувача',user.id,r.id);
  }
  return {ok:true,status:r.status==='APPROVED'?'PAID_PENDING_CONFIRMATION':r.status,
    ledgerId:found.id,alreadyExists:hadLedger};
}
function nameForUser_(id){
  var person=findUser_(id);
  return person?person.name:'Учасник';
}
function confirmReimbursement_(user,data){
  var r=reimbursement_(data.id);
  if(r.requester_id!==user.id)throw new Error('Підтвердити гроші може лише отримувач');
  if(r.status==='CONFIRMED')return {ok:true,status:'CONFIRMED',alreadyExists:true};
  if(r.status!=='PAID_PENDING_CONFIRMATION'&&r.status!=='PAYMENT_DISPUTED'&&r.status!=='APPEALED')
    throw new Error('Касир ще не позначив виплату');
  if(String(data.received||'')==='NO'){
    if(r.status==='APPEALED')
      throw new Error('Заперечення вже подано, апеляцію розглядає адміністратор');
    var explanation=needed_(data.reason,'Поясніть, чому гроші не отримано',300);
    updateReimbursement_(r.id,{status:'PAYMENT_DISPUTED',
      dispute_reason:explanation,disputed_at:now_()});
    logAudit_(user.id,'REIMBURSEMENT_DISPUTE','Отримувач не підтвердив виплату '+r.id);
    event_('REIMBURSEMENT','⚠ Отримувач заперечує виплату: '+r.purpose,
      user.id,r.id);
    return {ok:true,status:'PAYMENT_DISPUTED'};
  }
  if(String(data.received||'')!=='YES')throw new Error('Підтвердіть або заперечте отримання');
  var fields={status:'CONFIRMED',confirmed_by:user.id,confirmed_at:now_()};
  if(r.status==='APPEALED'){
    fields.appeal_decision='RECIPIENT_CONFIRMED';
    fields.appeal_decided_by=user.id;
    fields.appeal_decided_at=now_();
    fields.appeal_decision_reason='Отримувач сам підтвердив отримання після апеляції касира';
  }
  updateReimbursement_(r.id,fields);
  logAudit_(user.id,'REIMBURSEMENT_CONFIRMED','Отримувач підтвердив виплату '+r.id);
  event_('REIMBURSEMENT','Отримувач підтвердив отримання грошей: '+r.purpose,user.id,r.id);
  return {ok:true,status:'CONFIRMED'};
}
/**
 * A disagreement about money received is not the same as a cash correction.
 * An appeal never creates, updates or deletes a Ledger transaction.
 */
function appealReimbursement_(user,data){
  requireRole_(user,['CASHIER']);
  var r=reimbursement_(data.id);
  if(r.status!=='PAYMENT_DISPUTED')
    throw new Error('Апеляцію можна подати лише на заперечену виплату');
  if(r.paid_by!==user.id)
    throw new Error('Апеляцію може подати тільки касир, який зазначив виплату');
  if(r.appeal_at||r.appeal_decision)
    throw new Error('Апеляція цієї виплати вже подавалася або розглядалася');
  var reason=needed_(data.reason,'Пояснення касира',1000);
  if(reason.length<10)
    throw new Error('Опишіть обставини передачі грошей щонайменше 10 символами');
  if(!activeAdministrators_().some(function(a){return a.id!==user.id&&a.id!==r.requester_id;}))
    throw new Error('Для апеляції потрібен незалежний адміністратор');
  updateReimbursement_(r.id,{status:'APPEALED',
    appeal_by:user.id,appeal_at:now_(),appeal_reason:reason});
  logAudit_(user.id,'REIMBURSEMENT_APPEAL','Апеляція касира щодо '+r.id+': '+reason);
  event_('REIMBURSEMENT','⚠ Касир оскаржив заперечення виплати: '+r.purpose+
    '. Очікує рішення адміністратора',user.id,r.id);
  return {ok:true,status:'APPEALED',balanceChanged:false};
}
function decideReimbursementAppeal_(user,data){
  requireRole_(user,['ADMIN','RESERVE']);
  var r=reimbursement_(data.id);
  if(r.status!=='APPEALED'||r.appeal_decision)
    throw new Error('Немає активної апеляції, що очікує рішення');
  if(user.id===r.appeal_by||user.id===r.paid_by||user.id===r.requester_id)
    throw new Error('Рішення приймає лише незалежний адміністратор');
  var decision=String(data.decision||'');
  if(['UPHOLD_CASHIER','REJECT_APPEAL'].indexOf(decision)<0)
    throw new Error('Оберіть підтримати касира або відхилити апеляцію');
  var reason=needed_(data.reason,'Мотиви рішення адміністратора',1000);
  if(reason.length<10)
    throw new Error('Опишіть рішення щонайменше 10 символами');
  var newStatus=decision==='UPHOLD_CASHIER'?'ADMIN_CONFIRMED_PAYMENT':'PAYMENT_DISPUTED';
  updateReimbursement_(r.id,{status:newStatus,appeal_decision:decision,
    appeal_decided_by:user.id,appeal_decided_at:now_(),appeal_decision_reason:reason});
  // Do NOT fill confirmed_by: the member never confirmed receipt.
  logAudit_(user.id,'REIMBURSEMENT_APPEAL_DECISION',
    (decision==='UPHOLD_CASHIER'?'Підтримано касира':'Апеляцію відхилено')+
    ' по '+r.id+': '+reason);
  event_('REIMBURSEMENT',
    (decision==='UPHOLD_CASHIER'?'Адміністратор підтвердив виплату':'Адміністратор відхилив апеляцію')+
    ' за заявкою '+r.purpose+'. Рішення видно всім.',user.id,r.id);
  return {ok:true,status:newStatus,decision:decision,balanceChanged:false};
}
function commentReimbursement_(user,data){
  var r=reimbursement_(data.id);
  var msg=needed_(data.message,'Коментар',1500);
  var id=String(data.clientId||'');
  if(id&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))
    throw new Error('Невірний ID коментаря');
  var previous=id?all_('ReimbursementComments').filter(function(x){return x.id===id;})[0]:null;
  if(previous){
    if(previous.claim_id!==r.id||previous.author_id!==user.id||previous.message!==msg)
      throw new Error('Інший коментар із тим самим ID');
    return {ok:true,alreadyExists:true};
  }
  append_('ReimbursementComments',[id||Utilities.getUuid(),r.id,user.id,msg,now_()]);
  event_('REIMBURSEMENT','Коментар до відшкодування: '+r.purpose,user.id,r.id);
  return {ok:true};
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
function isAdmin_(user){
  return !!user&&['ADMIN','RESERVE'].indexOf(user.role)>=0;
}
function activeAdministrators_(){
  return all_('Users').filter(function(u){
    return u.active==='1' && (u.role==='ADMIN'||u.role==='RESERVE');
  });
}
function assertAdmin_(user){
  if(!isAdmin_(user))throw new Error('Тільки адміністратор керує обліковими записами');
}
function checkNewLogin_(users,data){
  var login=text_(data.login,40).toLowerCase();
  if(!/^[a-z0-9._-]{3,30}$/.test(login))
    throw new Error('Логін: 3–30 латинських літер, цифр або . _ -');
  if(users.some(function(u){return u.login===login;}))
    throw new Error('Такий логін уже існує');
  return login;
}
function startingPassword_(data){
  // The administrator may type a four-digit temporary PIN or let the system
  // generate a strong one-time secret. Both require the recipient to change it.
  var requested=String(data.pin||'').trim();
  return requested?validPersonalPassword_(requested):tempPassword_();
}
function bootstrapAdmin_(user,data){
  requireRole_(user,['CASHIER']);
  // Existing owners retain cashier rights. The first administrator is added
  // once and independently. Do NOT mutate existing cashier or ledger records.
  if(all_('Users').some(function(u){return u.role==='ADMIN'||u.role==='RESERVE';}))
    throw new Error('Адміністратор вже існує. Керування користувачами доступне йому.');
  var users=all_('Users');
  if(users.filter(function(u){return u.active==='1';}).length>=CFG_.MAX_USERS)
    throw new Error('Ліміт 10 активних учасників');
  var login=checkNewLogin_(users,data),name=needed_(data.name,'Ім’я адміністратора',80);
  var pwd=startingPassword_(data),salt=Utilities.getUuid(),id=Utilities.getUuid();
  append_('Users',[id,login,name,'ADMIN',salt,hashPassword_(pwd,salt),'1','1',now_(),'1']);
  logAudit_(user.id,'ADMIN_BOOTSTRAP','Створено окремого адміністратора '+login);
  event_('USER','Адміністратора обліку призначено',user.id,id);
  return {ok:true,login:login,password:pwd};
}
function invite_(user,data){
  assertAdmin_(user);
  var users=all_('Users');
  if(users.filter(function(u){return u.active==='1';}).length>=CFG_.MAX_USERS)
    throw new Error('Дозволено максимум 10 активних учасників');
  var login=checkNewLogin_(users,data),name=needed_(data.name,'Ім’я учасника',80);
  var desired=String(data.role||'MEMBER');
  if(['MEMBER','CASHIER'].indexOf(desired)<0)throw new Error('Невірна роль');
  if(desired==='CASHIER'&&users.some(function(u){return u.active==='1'&&u.role==='CASHIER';}))
    throw new Error('Касир уже призначений. Щоб змінити касира, використайте «Призначити касиром».');
  var pwd=startingPassword_(data),salt=Utilities.getUuid(),uid=Utilities.getUuid();
  append_('Users',[uid,login,name,desired,salt,hashPassword_(pwd,salt),'1','1',now_(),'1','']);
  logAudit_(user.id,'INVITE','Створено '+desired+' '+name+' ('+login+')');
  event_('USER',(desired==='CASHIER'?'Призначено першого касира ':'Додано учасника ')+name,user.id,uid);
  return {ok:true,login:login,password:pwd,role:desired};
}

function resetPassword_(user,data){
  assertAdmin_(user);
  var other=findUser_(data.id);
  if(!other)throw new Error('Учасника не знайдено');
  if(other.id===user.id)
    throw new Error('Свій пароль змінюйте в особистих налаштуваннях');
  if(other.role==='ADMIN'||other.role==='RESERVE')
    throw new Error('Пароль адміністратора змінюється лише самим адміністратором');
  var pwd=startingPassword_(data),salt=Utilities.getUuid();
  updateUser_(other.id,{salt:salt,hash:hashPassword_(pwd,salt),
    must_change:'1',version:String(Number(other.version)+1)});
  PropertiesService.getScriptProperties().deleteProperty('AUTH_TRIES_'+digest_(other.login).slice(0,28));
  logAudit_(user.id,'RESET','Адміністратор змінив тимчасовий пароль для '+other.login);
  return {ok:true,login:other.login,password:pwd};
}
function toggleUser_(user,data){
  assertAdmin_(user);
  var other=findUser_(data.id);
  if(!other||other.deleted_at||other.role==='CASHIER'||other.role==='ADMIN'||
     other.role==='RESERVE'||other.id===user.id)
    throw new Error('Неможливо змінити доступ касира або адміністратора');
  var newActive=other.active==='1'?'0':'1';
  if(newActive==='0'){
    var election=activeElection_(),electors=election&&electionElectorate_(election);
    if(election && (!electors||electors.indexOf(other.id)>=0))
      throw new Error('Не можна заблокувати виборця під час активних виборів');
  }
  if(newActive==='1'&&activeParticipants_().length>=CFG_.MAX_USERS)
    throw new Error('Максимум 10 активних учасників');
  updateUser_(other.id,{active:newActive,version:String(Number(other.version)+1)});
  logAudit_(user.id,'ACCESS',(newActive==='1'?'Увімкнено ':'Заблоковано ')+other.login);
  return {ok:true};
}
/** Dedicated admin controls. Person/user IDs remain immutable for audit. */
function changeLogin_(admin,data){
  assertAdmin_(admin);
  var other=findUser_(data.id);
  if(!other||other.active!=='1'||other.deleted_at)
    throw new Error('Активного користувача не знайдено');
  var newLogin=text_(data.login,40).toLowerCase();
  if(!/^[a-z0-9._-]{3,30}$/.test(newLogin))
    throw new Error('Логін має містити 3–30 латинських символів, цифр або . _ -');
  if(other.login===newLogin)return {ok:true,login:newLogin,alreadyExists:true};
  if(all_('Users').some(function(u){return u.login===newLogin;}))
    throw new Error('Такий логін уже існує або збережений в архіві');
  var oldLogin=other.login;
  updateUser_(other.id,{login:newLogin,version:String(Number(other.version||1)+1)});
  logAudit_(admin.id,'LOGIN_CHANGE','Змінено логін '+oldLogin+' → '+newLogin+
    ' для '+other.id);
  event_('USER','Адміністратор змінив логін '+other.name,admin.id,other.id);
  return {ok:true,login:newLogin,relogin:other.id===admin.id};
}
function assignCashier_(admin,data){
  assertAdmin_(admin);
  var selected=findUser_(data.id);
  if(!selected||selected.active!=='1'||selected.deleted_at||selected.role!=='MEMBER')
    throw new Error('Оберіть активного учасника на посаду касира');
  if(activeElection_())throw new Error('Спочатку завершіть поточні вибори касира');
  var why=needed_(data.reason,'Причина зміни касира',300);
  if(why.length<5)throw new Error('Поясніть причину зміни');
  var previous=all_('Users').filter(function(u){
    return u.role==='CASHIER'&&u.active==='1';
  })[0];
  if(previous){
    updateUser_(previous.id,{role:'MEMBER',version:String(Number(previous.version||1)+1)});
  }
  updateUser_(selected.id,{role:'CASHIER',version:String(Number(selected.version||1)+1)});
  var balance=calc_(all_('Ledger')).balance;
  logAudit_(admin.id,'ADMIN_ASSIGN_CASHIER','Призначено '+selected.id+
    ', попередній '+(previous?previous.id:'відсутній')+
    ', залишок '+balance+' коп.; причина: '+why);
  event_('USER','Адміністратор призначив касира '+selected.name+
    '. Фактичні кошти передаються окремим актом.',admin.id,selected.id);
  return {ok:true,cashier:selected.id,previous:previous?previous.id:'',
    bookBalance:balance};
}
function removeUser_(admin,data){
  assertAdmin_(admin);
  var other=findUser_(data.id);
  if(!other||other.deleted_at||other.active!=='1')
    throw new Error('Учасника вже вилучено або його доступ заблокований');
  if(other.id===admin.id||other.role==='ADMIN'||other.role==='RESERVE')
    throw new Error('Адміністратора не можна видалити: передайте роль окремо');
  if(other.role==='CASHIER')
    throw new Error('Спочатку призначте іншого касира, потім видаліть колишнього');
  if(other.role!=='MEMBER')throw new Error('Можна вилучити лише звичайного учасника');
  if(String(data.confirmLogin||'')!==other.login)
    throw new Error('Введіть точний логін учасника для підтвердження вилучення');
  var election=activeElection_();
  if(election)throw new Error('Не вилучайте учасників під час незавершених виборів');
  var liveDebts=reimbursements_().some(function(r){
    return r.requester_id===other.id&&
      ['REQUESTED','APPROVED','PAID_PENDING_CONFIRMATION',
       'PAYMENT_DISPUTED','APPEALED'].indexOf(r.status)>=0;
  });
  if(liveDebts)throw new Error('Є незакриті заявки/борги цього учасника');
  var liveReversals=reversalRequests_().some(function(r){
    if(['PENDING','DISPUTED'].indexOf(r.status)<0)return false;
    return all_('Ledger').some(function(l){return l.id===r.original_id&&l.person_id===other.id;});
  });
  if(liveReversals)throw new Error('Є незакриті сторнування внесків учасника');
  // Soft deletion: preserve immutable user ID and name for receipts, transactions,
  // reimbursement confirmations and audit. Login stays reserved and cannot be recycled.
  updateUser_(other.id,{active:'0',deleted_at:now_(),
    version:String(Number(other.version||1)+1)});
  logAudit_(admin.id,'USER_ARCHIVE','Адміністратор вилучив '+other.login+
    '; архівну ідентичність збережено');
  event_('USER','Учасника '+other.name+' вилучено з активного складу',admin.id,other.id);
  return {ok:true,deleted:true};
}
function setReserve_(user,data){
  assertAdmin_(user);
  var candidate=findUser_(data.id);
  if(!candidate||candidate.active!=='1'||candidate.role!=='MEMBER')
    throw new Error('Оберіть активного звичайного учасника');
  var admins=activeAdministrators_();
  if(admins.length!==1||admins[0].id!==user.id)
    throw new Error('Передати роль може тільки єдиний активний адміністратор');
  updateUser_(candidate.id,{role:'ADMIN',version:String(Number(candidate.version)+1)});
  updateUser_(user.id,{role:'MEMBER',version:String(Number(user.version)+1)});
  logAudit_(user.id,'ADMIN_TRANSFER','Адміністратор передав права '+candidate.name);
  event_('USER','Права адміністратора передано іншому учаснику',user.id,candidate.id);
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
  if(!candidate||candidate.active!=='1'||candidate.role!=='MEMBER')throw new Error('Кандидатом на касира може бути лише активний звичайний учасник');
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