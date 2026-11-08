package ua.obshchak.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

/** Native Android status-bar notifications, with per-account deduplication. */
final class NotificationAlerts {
  private static final String CHANNEL="obshchak_updates_v1";
  private static final String PREF="obshchak_alert_history";
  private static final int MAX_REMEMBERED=250;
  private NotificationAlerts(){}

  static void prepare(Context context){
    NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
    if(manager==null)return;
    NotificationChannel channel=new NotificationChannel(CHANNEL,"Події спільної каси",NotificationManager.IMPORTANCE_DEFAULT);
    channel.setDescription("Нові внески, витрати, чеки та повідомлення");
    manager.createNotificationChannel(channel);
  }

  static boolean enabled(Context context){
    NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
    if(manager==null||!manager.areNotificationsEnabled())return false;
    return Build.VERSION.SDK_INT<33||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED;
  }

  /** Call on foreground refresh so the background check won't duplicate in-app updates. */
  static void remember(Context context,String userId,JSONArray events){
    process(context,userId,events,false);
  }
  static void notifyNew(Context context,String userId,JSONArray events){
    process(context,userId,events,true);
  }

  private static void process(Context context,String userId,JSONArray events,boolean notify){
    if(userId==null||userId.isEmpty()||events==null)return;
    SharedPreferences prefs=context.getSharedPreferences(PREF,Context.MODE_PRIVATE);
    String key="seen_"+userId;
    Set<String> previous=new HashSet<>(prefs.getStringSet(key,new HashSet<String>()));
    boolean first=!prefs.getBoolean(key+"_initialized",false);
    Set<String> latest=new HashSet<>();
    ArrayList<JSONObject> fresh=new ArrayList<>();
    // The server returns newest-first events. Scan backwards to notify oldest first.
    for(int i=events.length()-1;i>=0;i--){
      JSONObject e=events.optJSONObject(i);if(e==null)continue;
      String id=e.optString("id");if(id.isEmpty())continue;
      latest.add(id);
      if(!first && !previous.contains(id) && !userId.equals(e.optString("actor_id")) &&
          isRelevant(e.optString("type"))) fresh.add(e);
    }
    // Keep the newest bounded window. IDs remain unique, so an old event won't reappear.
    Set<String> keep=new HashSet<>();
    for(int i=0;i<events.length()&&i<MAX_REMEMBERED;i++){
      JSONObject e=events.optJSONObject(i);if(e!=null&&!e.optString("id").isEmpty())keep.add(e.optString("id"));
    }
    prefs.edit().putStringSet(key,keep).putBoolean(key+"_initialized",true).apply();
    if(notify && enabled(context)){
      prepare(context);
      // Don't flood status bar after a long offline period.
      int start=Math.max(0,fresh.size()-5);
      for(int i=start;i<fresh.size();i++)post(context,fresh.get(i));
    }
  }

  private static boolean isRelevant(String type){
    return "TRANSACTION".equals(type)||"CORRECTION".equals(type)||
      "RECEIPT".equals(type)||"COMMENT".equals(type)||
      "ELECTION".equals(type)||"HANDOVER".equals(type);
  }
  private static void post(Context context,JSONObject e){
    String type=e.optString("type");
    String title="Нова подія ОБЩАК";
    String page="activity";
    if("COMMENT".equals(type)){title="Нове запитання або відповідь";page="questions";}
    else if("TRANSACTION".equals(type)){title="Нова операція в касі";page="history";}
    else if("CORRECTION".equals(type)){title="Виправлення операції";page="history";}
    else if("RECEIPT".equals(type)){title="До витрати додано чек";page="history";}
    else if("ELECTION".equals(type)){title="Новина про вибори касира";page="votes";}
    else if("HANDOVER".equals(type)){title="Передача каси";page="activity";}

    Intent intent=new Intent(context,MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
    intent.putExtra("open_page",page);
    int id=e.optString("id").hashCode() & 0x7fffffff;
    PendingIntent pi=PendingIntent.getActivity(context,id,intent,
        PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
    Notification notification=new Notification.Builder(context,CHANNEL)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(title)
      .setContentText(e.optString("summary","Відкрийте застосунок для перегляду"))
      .setStyle(new Notification.BigTextStyle().bigText(e.optString("summary","Нова подія")))
      .setAutoCancel(true).setContentIntent(pi)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setCategory("COMMENT".equals(type)?Notification.CATEGORY_MESSAGE:Notification.CATEGORY_STATUS)
      .build();
    NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
    if(manager!=null)manager.notify(id,notification);
  }
}
