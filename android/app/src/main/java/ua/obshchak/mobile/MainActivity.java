package ua.obshchak.mobile;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native Android UX, durable drafts & offline outbox. Google Sheets/Drive remain the server-side source of truth. */
public class MainActivity extends ComponentActivity {
  private static final int TEAL=0xff0b756d, NAVY=0xff18323a, MUTED=0xff617984, BG=0xfff4f7f8;
  private Settings settings;private SecurePrefs secure;private LocalStore outbox;private final ExecutorService pool=Executors.newSingleThreadExecutor();
  private LinearLayout screen, content;private JSONObject state=new JSONObject();private String page="home";
  private String formKind="OUT";private final Map<String,EditText> fields=new HashMap<>();
  private Spinner methodSpinner;private TextView filesLabel;private String receiptForLedger="";
  private String cameraTempPath="";
  private ActivityResultLauncher<Uri> cameraLauncher;
  private ActivityResultLauncher<String[]> pickerLauncher;
  private boolean doingRequest=false;
  private long lastSuccessfulRefresh=0L;
  private int endpointPinFailures=0;
  private long endpointPinBlockedUntil=0L;
  private final Handler pollHandler=new Handler(Looper.getMainLooper());
  private final Runnable pollTask=new Runnable(){@Override public void run(){
    if(!secure.token().isEmpty()&&!doingRequest&&page.equals("home") && android.os.SystemClock.elapsedRealtime()-lastSuccessfulRefresh>=60000)refresh();
    pollHandler.postDelayed(this,60000);
  }};

  @Override protected void onCreate(Bundle b){
    super.onCreate(b);settings=new Settings(this);secure=new SecurePrefs(this);outbox=new LocalStore(this);
    cameraLauncher=registerForActivityResult(new ActivityResultContracts.TakePicture(),ok->{
      if(ok){try{Uri u=FileProvider.getUriForFile(this,getPackageName()+".files",new File(cameraTempPath));savedReceipt(u,"image/jpeg");}
      catch(Exception e){message(e.getMessage());}}
      else {receiptForLedger="";rememberPhoto();message("Фото не зроблено. Чернетка збережена.");}
    });
    pickerLauncher=registerForActivityResult(new ActivityResultContracts.OpenDocument(),u->{if(u!=null){
      try{savedReceipt(u,getContentResolver().getType(u));}catch(Exception e){message(e.getMessage());}
    }else{receiptForLedger="";rememberPhoto();}});
    cameraTempPath=getPreferences(MODE_PRIVATE).getString("camera_path","");
    receiptForLedger=getPreferences(MODE_PRIVATE).getString("photo_target","");
    String cache=getPreferences(MODE_PRIVATE).getString("last_state","");
    try{state=new JSONObject(cache);}catch(Exception ignored){}
    if(b!=null){page=b.getString("page","home");formKind=b.getString("formKind","OUT");}
    if(settings.userId().isEmpty()||secure.token().isEmpty())page="login";
    else {if(!secure.deviceToken().isEmpty()){
        outbox.resumeAuth(settings.userId());QueueSyncWorker.schedule(this);
      }}
    draw();if(!page.equals("login"))refresh();
  }
  @Override protected void onResume(){super.onResume();pollHandler.postDelayed(pollTask,60000);}
  @Override protected void onPause(){pollHandler.removeCallbacks(pollTask);super.onPause();}
  @Override protected void onSaveInstanceState(Bundle b){saveDraft();b.putString("page",page);b.putString("formKind",formKind);super.onSaveInstanceState(b);}
  @Override protected void onDestroy(){pool.shutdown();super.onDestroy();}

  private void draw(){
    LinearLayout root=new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(BG);
    setContentView(root);

    if(!page.equals("login")&&!page.equals("password"))topBar(root);
    ScrollView scroll=new ScrollView(this);
    scroll.setFillViewport(true);
    root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1f));
    screen=new LinearLayout(this);
    screen.setOrientation(LinearLayout.VERTICAL);
    screen.setPadding(dp(16),dp(15),dp(16),dp(24));
    scroll.addView(screen);

    if(page.equals("login")||page.equals("password")){
      LinearLayout loginHeader=row();screen.addView(loginHeader);
      TextView loginLogo=text("₴  ОБЩАК ver."+BuildConfig.VERSION_NAME,21,TEAL,true);
      loginHeader.addView(loginLogo,new LinearLayout.LayoutParams(0,-2,1f));
      TextView loginGear=text("⚙",27,TEAL,true);
      loginGear.setGravity(Gravity.RIGHT);loginGear.setContentDescription("Налаштування підключення");
      loginHeader.addView(loginGear,new LinearLayout.LayoutParams(dp(56),dp(48)));
      loginGear.setOnClickListener(v->askEndpointPin());
      textInto(screen,"Облік спільної каси «Тупіка»",13,MUTED,false);
      spacer(screen,18);
      if(page.equals("login"))drawLogin();else drawChangePassword();
      return;
    }

    if(page.equals("home"))drawHome();
    else if(page.equals("form"))drawForm();
    else if(page.equals("queue"))drawQueue();
    else if(page.equals("history"))drawHistory();
    else if(page.equals("receipts"))drawReceipts();
    else if(page.equals("questions"))drawQuestions();
    else if(page.equals("users"))drawUsers();
    else if(page.equals("votes"))drawVotes();
    else if(page.equals("reports"))drawReports();
    else if(page.equals("activity"))drawActivity();
    else if(page.equals("settings"))drawSettings();
    bottomBar(root);
  }

  private void topBar(LinearLayout root){
    LinearLayout bar=row();bar.setPadding(dp(12),dp(7),dp(12),dp(9));
    bar.setBackgroundColor(Color.WHITE);root.addView(bar,new LinearLayout.LayoutParams(-1,dp(78)));
    TextView menu=text("☰",26,NAVY,true);
    menu.setGravity(Gravity.CENTER);bar.addView(menu,new LinearLayout.LayoutParams(dp(45),-1));
    menu.setOnClickListener(v->showMenu());
    LinearLayout title=new LinearLayout(this);title.setOrientation(LinearLayout.VERTICAL);
    bar.addView(title,new LinearLayout.LayoutParams(0,-2,1f));
    textInto(title,"ОБЩАК ver."+BuildConfig.VERSION_NAME,19,NAVY,true);
    textInto(title,"Облік спільної каси «Тупіка»",11,MUTED,false);
    title.setContentDescription("Повернутися на головну");
    title.setOnClickListener(v->go("home"));
    TextView bell=text("♧",24,TEAL,true);bell.setGravity(Gravity.CENTER);
    bar.addView(bell,new LinearLayout.LayoutParams(dp(43),-1));
    bell.setText("♧");bell.setContentDescription("Події та сповіщення");
    bell.setOnClickListener(v->go("activity"));
  }

  private void bottomBar(LinearLayout root){
    LinearLayout nav=row();nav.setBackgroundColor(Color.WHITE);
    nav.setPadding(dp(5),dp(5),dp(5),dp(5));root.addView(nav,new LinearLayout.LayoutParams(-1,dp(69)));
    tab(nav,"⌂","Головна","home");
    tab(nav,"⇄","Операції","history");
    tab(nav,"♙","Учасники","users");
    tab(nav,"▥","Звіти","reports");
  }

  private void tab(LinearLayout nav,String symbol,String label,String target){
    boolean selected=page.equals(target);
    LinearLayout tile=new LinearLayout(this);tile.setOrientation(LinearLayout.VERTICAL);
    tile.setGravity(Gravity.CENTER);
    if(selected)tile.setBackground(background(0xffe8f4f2,12));
    nav.addView(tile,new LinearLayout.LayoutParams(0,-1,1f));
    TextView ic=text(symbol,21,selected?TEAL:MUTED,true);ic.setGravity(Gravity.CENTER);tile.addView(ic);
    TextView caption=text(label,11,selected?TEAL:MUTED,selected);caption.setGravity(Gravity.CENTER);tile.addView(caption);
    tile.setOnClickListener(v->{if(!page.equals(target))go(target);});
  }

  private void showMenu(){
    final String[] labels={"Головна","Операції","Учасники","Звіти","Чеки витрат","Запитання","Черга синхронізації","Вибори касира","Події та сповіщення","Оновити дані","Налаштування","Відкрити вебверсію","Вихід"};
    final String[] targets={"home","history","users","reports","receipts","questions","queue","votes","activity","refresh","settings","web","logout"};
    new AlertDialog.Builder(this).setTitle("ОБЩАК · Меню")
      .setItems(labels,(dialog,which)->{
        String target=targets[which];
        if(target.equals("logout")){logout();return;}
        if(target.equals("refresh")){refresh();return;}
        if(target.equals("web")){
          try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(settings.url())));}
          catch(Exception ex){message(ex.getMessage());}
          return;
        }
        go(target);
      }).show();
  }

  private void drawSettings(){
    textInto(screen,"Налаштування",23,NAVY,true);
    LinearLayout c=card(screen);
    textInto(c,"Обліковий запис",15,NAVY,true);
    textInto(c,settings.username()+" · "+roleName(settings.role()),13,MUTED,false);
    textInto(c,"Підключення до Google: "+(settings.url().isEmpty()?"не налаштовано":"налаштовано"),12,MUTED,false);
    button(screen,"⚙ Змінити адресу Google (PIN)",this::askEndpointPin,false);
    button(screen,"⟳ Оновити дані",this::refresh,false);
    button(screen,"☁ Черга синхронізації",()->go("queue"),false);
    button(screen,"⇥ Вийти з облікового запису",this::logout,false);
  }

  private void drawLogin(){
    textInto(screen,"Вхід у закриту касу",23,NAVY,true);spacer(screen,12);
    if(settings.url().isEmpty()){
      LinearLayout info=card(screen);
      textInto(info,"Щоб підключити касу, натисніть ⚙ угорі праворуч.",14,TEAL,true);
    }
    EditText user=input(screen,"Логін",getPreferences(MODE_PRIVATE).getString("last_login","kasyr"),false);
    EditText pass=input(screen,"Пароль","",true);
    button(screen,"Увійти",()->{
      if(!settings.url().matches("https://script\\.google\\.com/macros/s/[^/?#]+/exec")){
        message("Потрібно налаштувати Google. Натисніть ⚙ і введіть PIN.");return;}
      String login=user.getText().toString().trim();String password=pass.getText().toString();
      JSONObject d=new JSONObject();try{d.put("login",login);d.put("password",password);}catch(Exception ignored){}
      remote("login",d,"",r->{
        try {
          String oldUser=settings.userId(),newUser=r.getJSONObject("user").optString("id");
          if(!oldUser.equals(newUser))secure.clearDeviceToken();
          secure.setToken(r.getString("token"));settings.user(r.getJSONObject("user"));
          state=new JSONObject();
          getPreferences(MODE_PRIVATE).edit().putString("last_login",login).remove("last_state").apply();
          if(r.optBoolean("mustChange")){page="password";draw();}
          else {page="home";draw();refresh();}
        }catch(Exception ex){message("Не вдалося зберегти сеанс: "+ex.getMessage());}
      });
    },true);
    textInto(screen,"Облікові записи створює касир. Пароль не зберігається на телефоні: лише тимчасовий токен у захищеному сховищі Android.",12,MUTED,false);
  }
  /** Local settings gate. This PIN is not server authorization; actual access is protected by account login. */
  private void askEndpointPin(){
    long now=android.os.SystemClock.elapsedRealtime();
    if(endpointPinBlockedUntil>now){
      long seconds=(endpointPinBlockedUntil-now+999)/1000;
      message("Зачекайте "+seconds+" с перед наступною спробою");return;
    }
    EditText pin=new EditText(this);
    pin.setHint("PIN налаштувань");
    pin.setSingleLine(true);
    pin.setInputType(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD);
    LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);
    body.setPadding(dp(22),dp(5),dp(22),0);
    body.addView(pin,new LinearLayout.LayoutParams(-1,dp(60)));
    new AlertDialog.Builder(this).setTitle("Захист налаштувань")
      .setMessage("Введіть PIN, щоб змінити адресу сервера. Це не пароль входу в касу.")
      .setView(body).setNegativeButton("Скасувати",null)
      .setPositiveButton("Продовжити",(dialog,which)->{
        if(!"5618".equals(pin.getText().toString().trim())){
          endpointPinFailures++;
          if(endpointPinFailures>=5){
            endpointPinBlockedUntil=android.os.SystemClock.elapsedRealtime()+60000;
            endpointPinFailures=0;
            message("Забагато спроб. Налаштування заблоковано на 1 хвилину.");
          }else message("Неправильний PIN");
          return;
        }
        endpointPinFailures=0;showEndpointEditor();
      }).show();
  }

  private void showEndpointEditor(){
    EditText endpoint=new EditText(this);
    endpoint.setSingleLine(false);
    endpoint.setText(settings.url());
    endpoint.setHint("https://script.google.com/macros/s/.../exec");
    endpoint.setSelectAllOnFocus(true);
    endpoint.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);
    LinearLayout content=new LinearLayout(this);content.setPadding(dp(18),dp(4),dp(18),dp(4));
    content.addView(endpoint,new LinearLayout.LayoutParams(-1,-2));
    AlertDialog dialog=new AlertDialog.Builder(this)
      .setTitle("Адреса Google Apps Script")
      .setMessage("Змінюйте тільки після створення нового розгортання. Стара адреса збережеться, якщо натиснути «Скасувати».")
      .setView(content)
      .setNegativeButton("Скасувати",null)
      .setPositiveButton("Зберегти",null).create();
    dialog.setOnShowListener(unused->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
      String url=endpoint.getText().toString().trim();
      if(!url.matches("https://script\\.google\\.com/macros/s/[^/?#]+/exec")){
        endpoint.setError("Потрібне повне посилання HTTPS з /exec");
        return;
      }
      String previous=settings.url();
      if(previous.equals(url)){dialog.dismiss();return;}
      if(outbox.list(settings.userId(),false).size()>0 && !settings.userId().isEmpty()){
        new AlertDialog.Builder(this)
          .setTitle("Є записи, що не синхронізувалися")
          .setMessage("Перш ніж змінювати сервер, синхронізуйте локальні операції й чеки. Адресу зараз не змінено.")
          .setPositiveButton("Зрозуміло",null).show();
        return;
      }
      settings.url(url);
      if(!previous.isEmpty()){
        secure.clear();
        settings.clearUser();
        state=new JSONObject();
        page="login";
      }
      dialog.dismiss();draw();message("Адресу підключення збережено");
    }));
    dialog.show();
  }

  private void registerDeviceKey(){
    if(secure.token().isEmpty())return;
    JSONObject d=new JSONObject();try{d.put("deviceId",settings.deviceId());}catch(Exception ignored){}
    remote("registerDevice",d,secure.token(),r->{try{
      secure.setDeviceToken(r.getString("deviceToken"));
      outbox.resumeAuth(settings.userId());outbox.resumeCommentAuth(settings.userId());
      QueueSyncWorker.schedule(this);
      message("Синхронізацію підключено на 30 днів");
    }catch(Exception e){message("Помилка ключа синхронізації: "+e.getMessage());}});
  }
  private void drawChangePassword(){
    textInto(screen,"Перший вхід: змініть пароль",21,NAVY,true);
    EditText old=input(screen,"Тимчасовий пароль","",true);
    EditText fresh=input(screen,"Новий пароль (12+ символів, літери й цифри)","",true);
    button(screen,"Змінити пароль",()->{
      JSONObject d=new JSONObject();try{d.put("old",old.getText().toString());d.put("fresh",fresh.getText().toString());}catch(Exception ignored){}
      remote("changePassword",d,secure.token(),r->{secure.clear();settings.clearUser();page="login";draw();message("Пароль змінено. Увійдіть ще раз.");});
    },true);
  }
  private void drawHome(){
    JSONObject totals=state.optJSONObject("totals");
    if(totals==null)totals=new JSONObject();

    LinearLayout balance=card(screen);
    balance.setBackground(background(0xff2165c6,20));
    balance.setPadding(dp(20),dp(18),dp(18),dp(18));
    textInto(balance,"Загальний залишок",15,0xffdce9ff,true);
    textInto(balance,money(totals.optLong("balance"))+" ₴",33,Color.WHITE,true);
    textInto(balance,"Готівка + картка · обліковий баланс",12,0xffe7f1ff,false);

    LinearLayout split=row();
    screen.addView(split,new LinearLayout.LayoutParams(-1,-2));
    summary(split,"↓  Прихід","+"+money(totals.optLong("income"))+" ₴",0xffe7f6ef,0xff168255);
    summary(split,"↑  Розхід","−"+money(totals.optLong("expense"))+" ₴",0xffffecee,0xffb63f4c);
    spacer(screen,8);

    if(isCashier()){
      LinearLayout actions=row();
      screen.addView(actions,new LinearLayout.LayoutParams(-1,-2));
      button(actions,"＋ Прихід",()->{formKind="IN";go("form");},true);
      button(actions,"− Витрата",()->{formKind="OUT";go("form");},true);
    }

    LinearLayout title=row();screen.addView(title);
    TextView heading=text("Останні операції",19,NAVY,true);
    title.addView(heading,new LinearLayout.LayoutParams(0,-2,1f));
    TextView all=text("Усі  ›",13,TEAL,true);title.addView(all);
    all.setOnClickListener(v->go("history"));
    spacer(screen,7);

    JSONArray ledger=state.optJSONArray("ledger");
    Map<String,Integer> receiptCounts=receiptCounts();
    Map<String,Long> balances=balancesAfterOperations();
    LinearLayout recent=card(screen);
    if(ledger==null||ledger.length()==0){
      textInto(recent,"Операцій поки немає",14,MUTED,false);
    }else{
      int n=0;
      for(int i=0;i<ledger.length()&&n<5;i++){
        JSONObject x=ledger.optJSONObject(i);if(x==null)continue;
        String kind=x.optString("kind");
        if(!kind.equals("IN")&&!kind.equals("OUT")&&!kind.equals("REVERSAL")&&!kind.equals("OPENING"))continue;
        if(n++>0)separator(recent);
        LinearLayout item=row();item.setPadding(dp(2),dp(8),dp(2),dp(8));recent.addView(item);
        TextView symbol=text(kind.equals("IN")?"+":kind.equals("OUT")?"−":"↶",22,kind.equals("IN")?0xff168255:0xffb63f4c,true);
        symbol.setGravity(Gravity.CENTER);
        symbol.setBackground(background(kind.equals("IN")?0xffe5f5ec:0xffffeded,22));
        item.addView(symbol,new LinearLayout.LayoutParams(dp(37),dp(37)));
        LinearLayout detail=new LinearLayout(this);detail.setPadding(dp(10),0,0,0);detail.setOrientation(LinearLayout.VERTICAL);
        item.addView(detail,new LinearLayout.LayoutParams(0,-2,1f));
        textInto(detail,x.optString("purpose").isEmpty()?(kind.equals("IN")?"Внесок":"Витрата"):x.optString("purpose"),14,NAVY,true);
        String extra=x.optString("person_name");
        if(extra.isEmpty())extra=x.optString("category");
        textInto(detail,displayDate(x.optString("date")),13,NAVY,true);
        if(!extra.isEmpty())textInto(detail,extra,11,MUTED,false);
        if(kind.equals("OUT"))receiptTag(detail,receiptCounts.getOrDefault(x.optString("id"),0),x.optString("no_receipt_reason"));
        Long after=balances.get(x.optString("id"));
        if(after!=null)textInto(detail,"Залишок: "+money(after)+" ₴",12,TEAL,true);
        TextView amount=text((x.optLong("amount")>=0?"+":"−")+money(Math.abs(x.optLong("amount")))+" ₴",15,x.optLong("amount")>=0?0xff168255:0xffb63f4c,true);
        amount.setGravity(Gravity.RIGHT);item.addView(amount);
        item.setOnClickListener(v->showDetail(x));
      }
    }

    LinearLayout shortcuts=row();screen.addView(shortcuts);
    quickTile(shortcuts,"▤","Чеки витрат",countReceipts()+" файлів",()->go("receipts"));
    quickTile(shortcuts,"☏","Запитання",countComments()+" коментарів",()->go("questions"));
    quickTile(shortcuts,"☁","Синхронізація",outbox.list(settings.userId(),false).size()+" у черзі",()->go("queue"));
    spacer(screen,6);
    textInto(screen,"Записи, не передані в Google, поки не входять до загального залишку.",12,MUTED,false);
  }

  private void summary(LinearLayout row,String label,String amount,int bg,int ink){
    LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);
    box.setPadding(dp(12),dp(11),dp(8),dp(11));box.setBackground(background(bg,16));
    LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,-2,1f);
    lp.setMargins(dp(2),0,dp(2),dp(4));row.addView(box,lp);
    textInto(box,label,13,NAVY,true);textInto(box,amount,19,ink,true);
    textInto(box,"За весь час",11,MUTED,false);
  }

  private void quickTile(LinearLayout row,String symbol,String label,String note,Runnable action){
    LinearLayout tile=new LinearLayout(this);tile.setOrientation(LinearLayout.VERTICAL);
    tile.setPadding(dp(8),dp(12),dp(5),dp(11));
    tile.setBackground(background(Color.WHITE,14));
    LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,dp(112),1f);
    lp.setMargins(dp(2),dp(3),dp(2),dp(3));row.addView(tile,lp);
    textInto(tile,symbol,22,TEAL,true);
    textInto(tile,label,12,NAVY,true);
    textInto(tile,note,10,MUTED,false);
    tile.setOnClickListener(v->action.run());
  }

  private void separator(LinearLayout parent){
    View line=new View(this);line.setBackgroundColor(0xffedf0f2);
    parent.addView(line,new LinearLayout.LayoutParams(-1,dp(1)));
  }
  private int countReceipts(){JSONArray a=state.optJSONArray("receipts");return a==null?0:a.length();}
  private int countComments(){JSONArray a=state.optJSONArray("comments");return a==null?0:a.length();}

  private void drawReceipts(){
    textInto(screen,"Чеки витрат",23,NAVY,true);
    JSONArray ledger=state.optJSONArray("ledger");
    Map<String,Integer> receiptCounts=receiptCounts();
    if(ledger==null||ledger.length()==0){textInto(screen,"Витрат поки немає",14,MUTED,false);return;}
    for(int i=0;i<ledger.length();i++){
      JSONObject tx=ledger.optJSONObject(i);if(tx==null||!tx.optString("kind").equals("OUT"))continue;
      int count=receiptCounts.getOrDefault(tx.optString("id"),0);
      LinearLayout c=card(screen);
      textInto(c,tx.optString("purpose")+" · "+money(Math.abs(tx.optLong("amount")))+" ₴",15,NAVY,true);
      textInto(c,displayDate(tx.optString("date")),14,NAVY,true);
      receiptTag(c,count,tx.optString("no_receipt_reason"));
      button(c,"Відкрити витрату й чеки",()->showDetail(tx),false);
    }
  }

  private static String displayDate(String original){
    if(original!=null && original.matches("20[0-9]{2}-[0-9]{2}-[0-9]{2}"))
      return original.substring(8,10)+"."+original.substring(5,7)+"."+original.substring(0,4);
    return original==null?"":original;
  }

  private Map<String,Long> balancesAfterOperations(){
    Map<String,Long> result=new HashMap<>();
    JSONArray ledger=state.optJSONArray("ledger");
    if(ledger==null)return result;
    // Preferred: balance calculated by Apps Script in append-only spreadsheet order.
    for(int i=0;i<ledger.length();i++){
      JSONObject record=ledger.optJSONObject(i);if(record==null)continue;
      if(record.has("balance_after") && !record.isNull("balance_after"))
        result.put(record.optString("id"),record.optLong("balance_after"));
    }
    if(result.size()==ledger.length())return result;
    // For an older deployment, derive from the displayed reverse-chronological ledger.
    // Deploy updated gas/Code.gs for authoritative ordering when entries share a timestamp.
    long current=state.optJSONObject("totals")!=null?state.optJSONObject("totals").optLong("balance"):0L;
    for(int i=0;i<ledger.length();i++){
      JSONObject record=ledger.optJSONObject(i);if(record==null)continue;
      String id=record.optString("id");
      if(!result.containsKey(id))result.put(id,current);
      current-=record.optLong("amount");
    }
    return result;
  }

  private Map<String,Integer> receiptCounts(){
    Map<String,Integer> counts=new HashMap<>();
    JSONArray receipts=state.optJSONArray("receipts");
    if(receipts==null)return counts;
    for(int i=0;i<receipts.length();i++){
      JSONObject r=receipts.optJSONObject(i);if(r==null)continue;
      String id=r.optString("ledger_id");if(id.isEmpty())continue;
      counts.put(id,counts.getOrDefault(id,0)+1);
    }
    return counts;
  }
  private void receiptTag(LinearLayout parent,int count,String reason){
    LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);
    box.setPadding(dp(8),dp(4),dp(8),dp(4));
    boolean yes=count>0;
    box.setBackground(background(yes?0xffe4f4e9:0xfffff2cf,9));
    LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-2,-2);
    p.topMargin=dp(4);p.bottomMargin=dp(3);parent.addView(box,p);
    textInto(box,yes?("✓ Є чек"+(count>1?"и: "+count:"")):"⚠ Немає чека",12,yes?0xff167743:0xff8b5b00,true);
    if(!yes&&reason!=null&&!reason.trim().isEmpty())textInto(box,"Причина: "+reason,11,0xff805900,false);
  }

  private void drawQuestions(){
    textInto(screen,"Запитання до витрат",23,NAVY,true);
    JSONArray comments=state.optJSONArray("comments"),ledger=state.optJSONArray("ledger");
    if(comments==null||comments.length()==0){textInto(screen,"Запитань і відповідей поки немає",14,MUTED,false);return;}
    for(int i=0;i<comments.length();i++){
      JSONObject c=comments.optJSONObject(i);if(c==null)continue;
      JSONObject tx=null;
      if(ledger!=null)for(int j=0;j<ledger.length();j++){
        JSONObject e=ledger.optJSONObject(j);if(e!=null&&e.optString("id").equals(c.optString("ledger_id"))){tx=e;break;}
      }
      if(tx==null)continue;
      final JSONObject target=tx;
      LinearLayout box=card(screen);
      textInto(box,tx.optString("purpose")+" · "+money(Math.abs(tx.optLong("amount")))+" ₴",15,NAVY,true);
      textInto(box,nameOf(c.optString("author_id"))+": "+c.optString("message"),13,MUTED,false);
      textInto(box,c.optString("created_at"),11,MUTED,false);
      button(box,"Відкрити обговорення",()->showDetail(target),false);
    }
  }

  private boolean isCashier(){return settings.role().equals("CASHIER");}
  private void drawForm(){
    if(!isCashier()){message("Фінансові операції може додавати лише касир");go("home");return;}
    fields.clear();JSONObject draft=settings.getDraft(formKind);
    textInto(screen,formKind.equals("OUT")?"Нова витрата":"Новий прихід",23,NAVY,true);
    textInto(screen,"Поля зберігаються автоматично. Фото не очистить форму.",13,TEAL,false);
    spacer(screen,10);
    field("date","Дата (РРРР-ММ-ДД)",draft.optString("date",today()));
    field("amount","Сума, грн",draft.optString("amount",""));
    if(formKind.equals("IN")){
      field("personName","Хто вніс гроші",draft.optString("personName",""));
      methodSpinner=new Spinner(this);ArrayAdapter<String> adapt=new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"Готівка","На картку"});
      methodSpinner.setAdapter(adapt);methodSpinner.setSelection(draft.optString("method","CASH").equals("BANK")?1:0);
      screen.addView(methodSpinner);
      methodSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> p){}public void onItemSelected(AdapterView<?> p,View v,int pos,long id){saveDraft();}});
    } else {
      field("category","Категорія",draft.optString("category","Господарські потреби"));
      field("noReceiptReason","Якщо немає чека — причина",draft.optString("noReceiptReason",""));
      LinearLayout row=row();screen.addView(row);
      button(row,"📷 Сфотографувати",()->takePhoto(""),false);
      button(row,"📎 З галереї / PDF",()->pickPhoto(""),false);
      filesLabel=text("",13,MUTED,false);screen.addView(filesLabel);showDraftFiles();
    }
    field("purpose","Призначення",draft.optString("purpose",""));
    spacer(screen,8);
    button(screen,"✓ Зберегти на телефоні й синхронізувати",this::queueForm,true);
    textInto(screen,"Якщо мережі немає, запис залишиться у черзі. Не видаляйте дані застосунку до завершення передачі.",12,MUTED,false);
  }
  private void field(String key,String label,String value){
    EditText edit=input(screen,label,value,false);fields.put(key,edit);
    edit.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){saveDraft();}public void afterTextChanged(Editable e){}});
  }
  private synchronized void saveDraft(){if(!page.equals("form"))return;
    JSONObject d=settings.getDraft(formKind);try{
      for(Map.Entry<String,EditText> e:fields.entrySet())d.put(e.getKey(),e.getValue().getText().toString());
      if(methodSpinner!=null&&formKind.equals("IN"))d.put("method",methodSpinner.getSelectedItemPosition()==1?"BANK":"CASH");
      settings.saveDraft(formKind,d);
    }catch(Exception ignored){}
  }
  private void showDraftFiles(){if(filesLabel==null)return;
    JSONArray a=settings.getDraft("OUT").optJSONArray("files");
    if(a==null||a.length()==0){filesLabel.setText("Чеків поки немає. Можна прикріпити кілька.");return;}
    StringBuilder sb=new StringBuilder("Локально збережено чеків: "+a.length());
    for(int i=0;i<a.length();i++)sb.append("\n✓ ").append(a.optJSONObject(i).optString("name","Фото"));
    filesLabel.setText(sb.toString());
  }
  private void queueForm(){
    saveDraft();JSONObject d=settings.getDraft(formKind);
    String amount=d.optString("amount","").trim(),purpose=d.optString("purpose","").trim();
    if(!amount.matches("[0-9]+([.,][0-9]{1,2})?")||amount.equals("0")||purpose.isEmpty()){
      message("Заповніть коректну суму (більше 0) та призначення");return;}
    if(!d.optString("date","").matches("20[0-9]{2}-[0-9]{2}-[0-9]{2}")){message("Дата має бути у форматі РРРР-ММ-ДД");return;}
    JSONArray files=d.optJSONArray("files");if(files==null)files=new JSONArray();
    if(formKind.equals("OUT")&&files.length()==0&&d.optString("noReceiptReason","").trim().isEmpty()){
      message("Додайте чек або поясніть, чому його немає");return;}
    if(formKind.equals("IN")&&d.optString("personName","").trim().isEmpty()){
      message("Вкажіть, від кого отримано гроші");return;}
    if(formKind.equals("OUT")&&d.optString("category","").trim().isEmpty()){
      message("Вкажіть категорію витрати");return;}
    try {
      JSONObject tx=new JSONObject();tx.put("kind",formKind);tx.put("date",d.getString("date"));tx.put("amount",amount.replace(',','.'));
      tx.put("purpose",purpose);if(formKind.equals("IN")){tx.put("method",d.optString("method","CASH"));tx.put("personName",d.optString("personName"));}
      else {tx.put("category",d.optString("category"));
        tx.put("noReceiptReason",files.length()>0?"Чек збережений на телефоні; очікується синхронізація":d.optString("noReceiptReason"));}
      String id=UUID.randomUUID().toString();JSONObject envelope=new JSONObject();envelope.put("tx",tx);envelope.put("files",files);
      outbox.add(id,settings.userId(),envelope.toString());
      settings.clearDraft(formKind);QueueSyncWorker.schedule(this);
      message("Збережено на телефоні. Надішлеться, коли буде інтернет.");go("queue");
    }catch(Exception ex){message("Не вдалося зберегти запис: "+ex.getMessage());}
  }

  private void takePhoto(String ledgerId){
    saveDraft();receiptForLedger=ledgerId;
    File folder=new File(getFilesDir(),"receipts/staging");if(!folder.exists())folder.mkdirs();
    File file=new File(folder,UUID.randomUUID()+".jpg");cameraTempPath=file.getAbsolutePath();
    rememberPhoto();
    Uri u=FileProvider.getUriForFile(this,getPackageName()+".files",file);
    cameraLauncher.launch(u);
  }
  private void pickPhoto(String ledgerId){saveDraft();receiptForLedger=ledgerId;rememberPhoto();pickerLauncher.launch(new String[]{"image/*","application/pdf"});}
  private void rememberPhoto(){getPreferences(MODE_PRIVATE).edit().putString("camera_path",cameraTempPath).putString("photo_target",receiptForLedger).apply();}
  private void savedReceipt(Uri uri,String mime) throws Exception {
    ImageStore.Receipt r=ImageStore.capture(this,uri,mime);
    if(!receiptForLedger.isEmpty()){
      JSONObject payload=new JSONObject();JSONArray files=new JSONArray();files.put(r.info);payload.put("files",files);
      outbox.addReceiptOnly(UUID.randomUUID().toString(),settings.userId(),receiptForLedger,payload);
      QueueSyncWorker.schedule(this);message("Чек збережений на телефоні. Додається до витрати при появі інтернету.");
      receiptForLedger="";rememberPhoto();go("queue");
    }else {
      JSONObject draft=settings.getDraft("OUT");JSONArray files=draft.optJSONArray("files");if(files==null)files=new JSONArray();
      files.put(r.info);draft.put("files",files);settings.saveDraft("OUT",draft);
      if(page.equals("form"))showDraftFiles();
      message("Чек збережений локально. Заповнені поля не змінено.");
    }
  }

  private void drawQueue(){
    textInto(screen,"Черга синхронізації",23,NAVY,true);
    button(screen,"⟳ Спробувати синхронізувати",()->{
      if(secure.deviceToken().isEmpty()){registerDeviceKey();return;}
      outbox.resumeAuth(settings.userId());outbox.resumeCommentAuth(settings.userId());
      QueueSyncWorker.schedule(this);message("Передачу заплановано за наявності мережі");
    },true);
    button(screen,"🔑 Оновити дозвіл фонової синхронізації",this::registerDeviceKey,false);
    java.util.List<LocalStore.Entry> list=outbox.list(settings.userId(),true);
    if(list.isEmpty() && outbox.comments(settings.userId(),true).isEmpty())textInto(screen,"Локальних записів ще немає",15,MUTED,false);
    for(LocalStore.Entry e:list){
      LinearLayout box=card(screen);JSONObject tx=e.body().optJSONObject("tx");
      String title=tx==null?"📎 Чек до попередньої витрати":tx.optString("kind").equals("IN")?"Прихід":"Розхід";
      textInto(box,title+" · "+(tx==null?"":tx.optString("amount")+" грн"),16,NAVY,true);
      textInto(box,"Статус: "+labelStatus(e.status),13,e.status.equals(LocalStore.SYNCED)?TEAL:MUTED,true);
      if(tx!=null)textInto(box,tx.optString("purpose"),13,MUTED,false);
      if(!e.error.isEmpty())textInto(box,e.error,12,0xffb34a45,false);
      if(e.status.equals(LocalStore.FAILED))button(box,"Повторити після виправлення проблеми",()->{outbox.retry(e.id);QueueSyncWorker.schedule(this);draw();},false);
      JSONArray photos=e.body().optJSONArray("files");if(photos!=null){textInto(box,"Прикріплених файлів: "+photos.length(),12,MUTED,false);
        if(photos.length()>0){JSONObject f=photos.optJSONObject(0);
          button(box,"Переглянути збережений чек",()->openLocal(f),false);}}
    }
    for(LocalStore.PendingComment c:outbox.comments(settings.userId(),true)){
      LinearLayout box=card(screen);
      textInto(box,"💬 Коментар: "+c.message,14,NAVY,true);
      textInto(box,"Статус: "+commentStatusLabel(c.status),12,LocalStore.SYNCED.equals(c.status)?TEAL:MUTED,true);
      if(c.error!=null&&!c.error.isEmpty())textInto(box,c.error,12,0xffb34a45,false);
      if(LocalStore.FAILED.equals(c.status)||LocalStore.AUTH.equals(c.status))
        button(box,"Повторити надсилання",()->{
          outbox.retryComment(c.id);
          if(secure.deviceToken().isEmpty())registerDeviceKey();
          else QueueSyncWorker.schedule(this);
          draw();
        },false);
    }
    textInto(screen,"Завантажено означає, що Google підтвердив збереження. Оригінали чеків залишаються на телефоні.",12,MUTED,false);
  }
  private String labelStatus(String status){switch(status){case LocalStore.PENDING:return "Очікує інтернету / відправлення";case LocalStore.SYNCED:return "Завантажено в Google";case LocalStore.AUTH:return "Потрібен повторний вхід";default:return "Потребує уваги";}}
  private String commentStatusLabel(String status){
    if(LocalStore.SYNCED.equals(status))return "✓ Відправлено всім";
    if(LocalStore.PENDING.equals(status))return "◷ Збережено на телефоні · очікує передачі";
    if(LocalStore.AUTH.equals(status))return "Потрібен повторний вхід";
    return "⚠ Не відправлено · перевірте причину";
  }
  private void openLocal(JSONObject file){try{
    File f=new File(file.getString("originalPath"));Uri u=FileProvider.getUriForFile(this,getPackageName()+".files",f);
    Intent i=new Intent(Intent.ACTION_VIEW).setDataAndType(u,file.optString("originalMime",file.optString("mime","image/jpeg"))).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    startActivity(Intent.createChooser(i,"Відкрити чек"));
  }catch(Exception ex){message("Не вдалося відкрити локальний чек: "+ex.getMessage());}}

  private void drawHistory(){
    textInto(screen,"Прихід, розхід і чеки",23,NAVY,true);
    JSONArray ledger=state.optJSONArray("ledger");
    Map<String,Integer> receiptCounts=receiptCounts();
    Map<String,Long> balances=balancesAfterOperations();
    if(ledger==null||ledger.length()==0){textInto(screen,"Операцій немає або дані не завантажені",14,MUTED,false);return;}
    for(int i=0;i<Math.min(ledger.length(),150);i++){
      JSONObject x=ledger.optJSONObject(i);if(x==null)continue;
      LinearLayout c=card(screen);String kind=x.optString("kind"),title=kind.equals("IN")?"＋ Прихід":kind.equals("OUT")?"− Розхід":"↶ Коригування";
      textInto(c,title+"  "+money(Math.abs(x.optLong("amount")))+" ₴",16,kind.equals("OUT")?0xffb84d46:TEAL,true);
      textInto(c,displayDate(x.optString("date")),15,NAVY,true);
      textInto(c,x.optString("purpose"),13,MUTED,false);
      if(kind.equals("OUT"))receiptTag(c,receiptCounts.getOrDefault(x.optString("id"),0),x.optString("no_receipt_reason"));
      Long after=balances.get(x.optString("id"));
      if(after!=null)textInto(c,"Залишок після операції: "+money(after)+" ₴",13,TEAL,true);
      button(c,"Деталі та запитання",()->showDetail(x),false);
    }
  }
  private void showDetail(JSONObject item){
    LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(dp(16),dp(10),dp(16),dp(8));
    textInto(layout,item.optString("purpose")+" · "+money(Math.abs(item.optLong("amount")))+" грн",18,NAVY,true);
    textInto(layout,"Дата: "+displayDate(item.optString("date")),15,NAVY,true);
    Long after=balancesAfterOperations().get(item.optString("id"));
    if(after!=null)textInto(layout,"Залишок після операції: "+money(after)+" ₴",14,TEAL,true);
    JSONArray receipts=state.optJSONArray("receipts");
    if(receipts!=null)for(int i=0;i<receipts.length();i++){
      JSONObject r=receipts.optJSONObject(i);if(r!=null&&r.optString("ledger_id").equals(item.optString("id")))
        button(layout,"📎 "+r.optString("filename"),()->fetchReceipt(r.optString("id")),false);
    }
    if(isCashier()&&item.optString("kind").equals("OUT")){
      button(layout,"＋ Сфотографувати чек",()->takePhoto(item.optString("id")),false);
      button(layout,"＋ Додати чек із галереї",()->pickPhoto(item.optString("id")),false);
    }
    JSONArray comments=state.optJSONArray("comments");
    if(comments!=null)for(int i=0;i<comments.length();i++){
      JSONObject c=comments.optJSONObject(i);if(c!=null&&c.optString("ledger_id").equals(item.optString("id")))textInto(layout,"💬 "+nameOf(c.optString("author_id"))+": "+c.optString("message"),13,NAVY,false);
    }
    EditText comment=input(layout,"Запитання або відповідь (видно всім)","",false);
    comment.setHint("✎ Натисніть тут і напишіть запитання або відповідь…");
    comment.setMinHeight(dp(95));
    comment.setGravity(Gravity.TOP|Gravity.START);
    comment.setSingleLine(false);
    comment.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
    comment.setPadding(dp(14),dp(13),dp(14),dp(13));
    GradientDrawable commentBg=background(0xfff6fbfd,12);
    commentBg.setStroke(dp(2),TEAL);
    comment.setBackground(commentBg);
    button(layout,"Надіслати коментар",()->{if(comment.getText().toString().trim().isEmpty())return;
      JSONObject d=new JSONObject();try{d.put("ledgerId",item.optString("id"));d.put("message",comment.getText().toString());}catch(Exception ignored){}
      remote("comment",d,secure.token(),r->{message("Коментар опубліковано");refresh();});
    },true);
    if(isCashier()&&(item.optString("kind").equals("OUT")||item.optString("kind").equals("IN")))
      button(layout,"↶ Сторнувати помилкову операцію",()->prompt("Причина сторнування",reason->{
        JSONObject d=new JSONObject();try{d.put("id",item.optString("id"));d.put("reason",reason);}catch(Exception ignored){}
        new AlertDialog.Builder(this).setTitle("Незмінність історії").setMessage("Створити окрему коригувальну операцію? Первинну витрату не буде видалено.")
          .setNegativeButton("Ні",null).setPositiveButton("Так",(di,w)->remote("reverseTransaction",d,secure.token(),r->{message("Сторнування створено");refresh();})).show();
      }),false);
    ScrollView v=new ScrollView(this);v.addView(layout);
    new AlertDialog.Builder(this).setTitle("Деталі операції").setView(v).setPositiveButton("Закрити",null).show();
  }
  private String nameOf(String id){JSONArray users=state.optJSONArray("users");if(users!=null)for(int i=0;i<users.length();i++){JSONObject u=users.optJSONObject(i);if(id.equals(u.optString("id")))return u.optString("name");}return "Учасник";}
  private void fetchReceipt(String id){JSONObject d=new JSONObject();try{d.put("id",id);}catch(Exception ignored){}
    remote("getReceipt",d,secure.token(),r->{try{
      byte[] bytes=Base64.decode(r.getString("data"),Base64.DEFAULT);
      String mime=r.optString("mime","image/jpeg");String ext=mime.equals("application/pdf")?"pdf":mime.equals("image/png")?"png":"jpg";
      File f=new File(getCacheDir(),"receipt_"+UUID.randomUUID()+"."+ext);
      try(FileOutputStream out=new FileOutputStream(f)){out.write(bytes);}
      Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",f);
      Intent open=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      startActivity(Intent.createChooser(open,"Переглянути чек"));
    }catch(Exception ex){message(ex.getMessage());}});
  }

  private void drawUsers(){
    textInto(screen,"Учасники",23,NAVY,true);
    JSONArray users=state.optJSONArray("users");int active=0;
    if(users!=null)for(int i=0;i<users.length();i++)if(users.optJSONObject(i).optBoolean("active"))active++;
    textInto(screen,active+" із 10 активних",15,TEAL,true);
    if(users!=null)for(int i=0;i<users.length();i++){
      JSONObject u=users.optJSONObject(i);LinearLayout c=card(screen);
      textInto(c,u.optString("name"),16,NAVY,true);
      textInto(c,u.optString("login")+" · "+roleName(u.optString("role"))+(u.optBoolean("active")?"":" · заблокований"),12,MUTED,false);
    }
    if(settings.role().equals("CASHIER")||settings.role().equals("RESERVE")){
      button(screen,"＋ Додати учасника",()->{
        LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.VERTICAL);v.setPadding(dp(18),0,dp(18),0);
        EditText name=input(v,"Ім'я","",false),login=input(v,"Логін (латиницею)","",false);
        new AlertDialog.Builder(this).setTitle("Новий учасник").setView(v).setNegativeButton("Скасувати",null).setPositiveButton("Створити",(di,w)->{
          JSONObject d=new JSONObject();try{d.put("name",name.getText().toString());d.put("login",login.getText().toString());}catch(Exception ignored){}
          remote("invite",d,secure.token(),r->{
            String secret="Логін: "+r.optString("login")+"\nТимчасовий пароль: "+r.optString("password");
            new AlertDialog.Builder(this).setTitle("Передайте особисто").setMessage(secret)
              .setPositiveButton("Скопіювати",(d2,w2)->{
                ClipboardManager cm=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);cm.setPrimaryClip(ClipData.newPlainText("ОБЩАК",secret));
              }).setNegativeButton("Закрити",null).show();refresh();
          });
        }).show();
      },true);
      textInto(screen,"Керування блокуванням, паролями та резервним адміністратором також доступне в повній вебверсії.",12,MUTED,false);
    }
  }
  private void drawVotes(){
    textInto(screen,"Вибори касира",23,NAVY,true);
    JSONArray elections=state.optJSONArray("elections");JSONObject live=null;
    if(elections!=null)for(int i=0;i<elections.length();i++){
      JSONObject e=elections.optJSONObject(i);String status=e.optString("status");
      if(status.equals("PROPOSED")||status.equals("VOTING")||status.equals("APPROVED")){live=e;break;}
    }
    JSONArray users=state.optJSONArray("users");int count=0;
    if(users!=null)for(int i=0;i<users.length();i++)if(users.optJSONObject(i).optBoolean("active"))count++;
    final int required=count/2+1;
    if(count<3){textInto(screen,"Вибори доступні від 3 учасників. Зараз: "+count,14,MUTED,false);return;}
    if(live==null){
      textInto(screen,"Ініціатива двох людей. Для перемоги потрібна більшість: "+required+" із "+count+".",13,MUTED,false);
      button(screen,"Запропонувати кандидата",()->{
        ArrayList<String> names=new ArrayList<>(), ids=new ArrayList<>();
        if(users!=null)for(int i=0;i<users.length();i++){
          JSONObject u=users.optJSONObject(i);if(u.optBoolean("active")&&!u.optString("role").equals("CASHIER")){
            names.add(u.optString("name"));ids.add(u.optString("id"));
          }
        }
        if(names.isEmpty())return;
        new AlertDialog.Builder(this).setTitle("Кандидат у касири").setItems(names.toArray(new String[0]),(d,pos)->{
          JSONObject body=new JSONObject();try{body.put("candidateId",ids.get(pos));}catch(Exception ignored){}
          remote("proposeElection",body,secure.token(),r->{message("Ініціативу створено");refresh();});
        }).show();
      },true);
    }else{
      JSONObject e=live;String status=e.optString("status"),id=e.optString("id");
      textInto(screen,"Кандидат: "+nameOf(e.optString("candidate_id")),20,NAVY,true);
      textInto(screen,"Статус: "+status,13,MUTED,false);
      int threshold=e.optInt("required_votes",required);
      textInto(screen,"Голосів потрібно: "+threshold,14,TEAL,true);
      if(status.equals("PROPOSED"))button(screen,"Підтримати ініціативу",()->simpleAction("supportElection",id),true);
      if(status.equals("VOTING")){
        LinearLayout row=row();screen.addView(row);
        button(row,"За",()->vote(id,"YES"),true);
        button(row,"Проти",()->vote(id,"NO"),false);
      }
      if(status.equals("APPROVED")&&e.optString("candidate_id").equals(settings.userId()))
        button(screen,"Прийняти повноваження",()->simpleAction("acceptElection",id),true);
      if(!status.equals("PROPOSED")&&!status.equals("VOTING")&&!status.equals("APPROVED"))textInto(screen,"Завершено",13,MUTED,false);
    }
    textInto(screen,"Повна історія голосів та акт передачі каси доступні у вебверсії.",12,MUTED,false);
  }
  private void vote(String id,String vote){new AlertDialog.Builder(this).setTitle("Підтвердити голос?").setMessage("Після голосування змінити відповідь неможливо.")
    .setNegativeButton("Ні",null).setPositiveButton("Так",(d,w)->{
      JSONObject body=new JSONObject();try{body.put("id",id);body.put("vote",vote);}catch(Exception ignored){}
      remote("castVote",body,secure.token(),r->{message("Голос враховано");refresh();});
    }).show();}
  private void simpleAction(String action,String id){JSONObject body=new JSONObject();try{body.put("id",id);}catch(Exception ignored){}
    remote(action,body,secure.token(),r->{message("Успішно");refresh();});}

  private void drawReports(){
    textInto(screen,"Звіт общака",23,NAVY,true);
    EditText from=input(screen,"З дати (РРРР-ММ-ДД)",today().substring(0,7)+"-01",false);
    EditText to=input(screen,"До дати (РРРР-ММ-ДД)",today(),false);
    button(screen,"Завантажити PDF без фото чеків",()->{
      JSONObject d=new JSONObject();try{d.put("from",from.getText().toString());d.put("to",to.getText().toString());}catch(Exception ignored){}
      remote("pdf",d,secure.token(),r->{try{
        byte[] pdf=Base64.decode(r.getString("data"),Base64.DEFAULT);
        File file=new File(getCacheDir(),"OBSHCHAK_"+System.currentTimeMillis()+".pdf");
        try(FileOutputStream out=new FileOutputStream(file)){out.write(pdf);}
        Uri uri=FileProvider.getUriForFile(this,getPackageName()+".files",file);
        Intent send=new Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM,uri)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(send,"Зберегти або надіслати звіт"));
      }catch(Exception ex){message(ex.getMessage());}});
    },true);
    textInto(screen,"PDF містить усі операції та позначки «Є чек» / «Немає чека». Самі фото залишаються в онлайн-журналі.",12,MUTED,false);
  }
  private void drawActivity(){
    textInto(screen,"Останні події",23,NAVY,true);
    JSONArray events=state.optJSONArray("events");if(events!=null)for(int i=0;i<Math.min(50,events.length());i++){
      JSONObject e=events.optJSONObject(i);LinearLayout c=card(screen);
      textInto(c,e.optString("summary"),14,NAVY,true);textInto(c,e.optString("created_at"),12,MUTED,false);
    }
    textInto(screen,"Це повідомлення всередині застосунку. Push-повідомлення при закритій програмі ще не реалізовані.",12,MUTED,false);
  }

  private void remote(String action,JSONObject data,String token,java.util.function.Consumer<JSONObject> success){
    if(doingRequest){message("Попередня дія ще виконується");return;}doingRequest=true;
    pool.execute(()->{
      try{JSONObject result=new ApiClient(this).call(action,data,token);runOnUiThread(()->{doingRequest=false;success.accept(result);});}
      catch(Exception e){runOnUiThread(()->{
        doingRequest=false;message(e.getMessage());
        if(e instanceof ApiClient.ApiException&&((ApiClient.ApiException)e).auth){secure.clear();page="login";draw();}
      });}
    });
  }
  private void refresh(){if(secure.token().isEmpty())return;
    remote("state",new JSONObject(),secure.token(),r->{
      JSONArray oldEvents=state.optJSONArray("events"),newEvents=r.optJSONArray("events");
      String before=oldEvents!=null&&oldEvents.length()>0?oldEvents.optJSONObject(0).optString("id"):"";
      String after=newEvents!=null&&newEvents.length()>0?newEvents.optJSONObject(0).optString("id"):"";
      String nextState=r.toString();
      boolean changed=!nextState.equals(state.toString());
      state=r;lastSuccessfulRefresh=android.os.SystemClock.elapsedRealtime();
      if(changed)getPreferences(MODE_PRIVATE).edit().putString("last_state",nextState).apply();
      if(!before.isEmpty()&&!before.equals(after))message("Є нові події в ОБЩАКУ. Перевірте активність.");
      JSONObject user=state.optJSONObject("me");if(user!=null)settings.user(user);
      if(changed&&(page.equals("home")||page.equals("history")||page.equals("receipts")||page.equals("questions")||page.equals("users")||page.equals("votes")||page.equals("activity")))draw();
      if(secure.deviceToken().isEmpty())registerDeviceKey();
    });
  }
  private void logout(){
    JSONObject nothing=new JSONObject();String token=secure.token();
    // Local unsynced records stay tied to their owner. Never delete them on logout.
    secure.clear();settings.clearUser();state=new JSONObject();getPreferences(MODE_PRIVATE).edit().remove("last_state").apply();
    page="login";draw();
    pool.execute(()->{try{new ApiClient(this).call("logout",nothing,token);}catch(Exception ignored){}});
  }
  private void go(String target){page=target;draw();}
  private static String today(){return new SimpleDateFormat("yyyy-MM-dd",Locale.US).format(new Date());}
  private static String money(long cents){return String.format(new Locale("uk","UA"),"%,.2f",cents/100.0);}
  private static String roleName(String role){return role.equals("CASHIER")?"Касир":role.equals("RESERVE")?"Резервний адміністратор":"Учасник";}
  private void prompt(String title,java.util.function.Consumer<String> cb){EditText e=new EditText(this);
    new AlertDialog.Builder(this).setTitle(title).setView(e).setNegativeButton("Скасувати",null)
      .setPositiveButton("Готово",(d,w)->cb.accept(e.getText().toString())).show();}
  private void message(String msg){Toast.makeText(this,msg==null?"Невідома помилка":msg,Toast.LENGTH_LONG).show();}
  private int dp(int value){return Math.round(getResources().getDisplayMetrics().density*value);}
  private GradientDrawable background(int color,int radius){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp(radius));return g;}
  private LinearLayout row(){LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.HORIZONTAL);row.setGravity(Gravity.CENTER_VERTICAL);return row;}
  private LinearLayout card(LinearLayout parent){LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(16),dp(13),dp(16),dp(13));box.setBackground(background(Color.WHITE,15));
    LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.bottomMargin=dp(10);parent.addView(box,params);return box;}
  private TextView text(String s,int size,int color,boolean bold){TextView t=new TextView(this);t.setText(s);t.setTextColor(color);t.setTextSize(size);if(bold)t.setTypeface(null,Typeface.BOLD);t.setPadding(dp(3),dp(3),dp(3),dp(3));return t;}
  private void textInto(LinearLayout dest,String s,int size,int color,boolean bold){dest.addView(text(s,size,color,bold));}
  private void spacer(LinearLayout dest,int height){View v=new View(this);dest.addView(v,new LinearLayout.LayoutParams(1,dp(height)));}
  private EditText input(LinearLayout dest,String label,String initial,boolean password){
    textInto(dest,label,13,MUTED,true);EditText e=new EditText(this);e.setText(initial);e.setTextSize(15);e.setSingleLine(!label.contains("Призначення")&&!label.contains("причина")&&!label.contains("запитання"));
    e.setPadding(dp(12),dp(10),dp(12),dp(10));e.setBackground(background(Color.WHITE,10));
    if(password)e.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
    else if(label.contains("Сума"))e.setInputType(InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_FLAG_DECIMAL);
    LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(10);dest.addView(e,lp);return e;
  }
  private void button(LinearLayout dest,String label,Runnable action,boolean prominent){
    Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setTextSize(13);b.setTypeface(null,Typeface.BOLD);
    b.setTextColor(prominent?Color.WHITE:NAVY);b.setBackgroundTintList(ColorStateList.valueOf(prominent?TEAL:0xffe5efee));b.setMinHeight(dp(46));
    LinearLayout.LayoutParams p=dest.getOrientation()==LinearLayout.HORIZONTAL?new LinearLayout.LayoutParams(0,dp(52),1f):new LinearLayout.LayoutParams(-1,dp(52));
    p.setMargins(dp(2),dp(3),dp(2),dp(4));dest.addView(b,p);b.setOnClickListener(v->action.run());
  }
}