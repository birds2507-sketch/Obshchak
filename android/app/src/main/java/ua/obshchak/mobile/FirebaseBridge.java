package ua.obshchak.mobile;

import android.content.Context;
import android.util.Log;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Firebase client configuration is injected at APK build time, not hardcoded.
 * Never place FCM HTTP v1 service-account credentials inside an Android APK.
 */
final class FirebaseBridge {
  private static final String TAG="OBSHCHAK-FCM";
  private static final ExecutorService executor=Executors.newSingleThreadExecutor();
  private static boolean ready=false;
  private FirebaseBridge(){}

  static synchronized boolean initialize(Context context){
    if(ready)return true;
    if(BuildConfig.FCM_APP_ID.isEmpty()||BuildConfig.FCM_API_KEY.isEmpty()||
       BuildConfig.FCM_SENDER_ID.isEmpty()||BuildConfig.FCM_PROJECT_ID.isEmpty())return false;
    try{
      if(FirebaseApp.getApps(context).isEmpty()){
        FirebaseOptions options=new FirebaseOptions.Builder()
          .setApplicationId(BuildConfig.FCM_APP_ID)
          .setApiKey(BuildConfig.FCM_API_KEY)
          .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
          .setProjectId(BuildConfig.FCM_PROJECT_ID)
          .build();
        FirebaseApp.initializeApp(context,options);
      }
      ready=true;
      return true;
    }catch(Exception ex){Log.w(TAG,"Unable to initialize Firebase",ex);return false;}
  }

  static boolean configured(){return !BuildConfig.FCM_APP_ID.isEmpty() &&
    !BuildConfig.FCM_API_KEY.isEmpty() && !BuildConfig.FCM_SENDER_ID.isEmpty() &&
    !BuildConfig.FCM_PROJECT_ID.isEmpty();}

  /** Call on login, on token refresh and after device-token rotation. */
  static void register(Context context){
    Context app=context.getApplicationContext();
    if(!initialize(app))return;
    if(new Settings(app).userId().isEmpty()||new SecurePrefs(app).deviceToken().isEmpty())return;
    try{
      FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token->{
        if(token!=null&&!token.isEmpty())submit(app,"registerPush",token);
      }).addOnFailureListener(e->Log.w(TAG,"Unable to get FCM token",e));
    }catch(Exception ex){Log.w(TAG,"Firebase Messaging not ready",ex);}
  }

  static void tokenUpdated(Context context,String token){
    Context app=context.getApplicationContext();
    if(!initialize(app))return;
    if(token!=null&&!token.isEmpty())submit(app,"registerPush",token);
  }

  /** Non-blocking server update, no financial table changes. */
  private static void submit(Context context,String action,String token){
    executor.execute(()->{
      try{
        Settings settings=new Settings(context);
        if(settings.userId().isEmpty())return;
        String deviceToken=new SecurePrefs(context).deviceToken();
        if(deviceToken.isEmpty())return;
        JSONObject args=new JSONObject()
          .put("deviceId",settings.deviceId()).put("fcmToken",token);
        new ApiClient(context).call(action,args,deviceToken);
      }catch(Exception ex){Log.w(TAG,"Push registration needs a later retry",ex);}
    });
  }

  static void unregister(Context context,String deviceToken){
    Context app=context.getApplicationContext();
    if(deviceToken==null||deviceToken.isEmpty())return;
    // The user may log out before network response. Capture endpoint before local session clears.
    String endpoint=new Settings(app).url();
    String deviceId=new Settings(app).deviceId();
    executor.execute(()->{
      try{
        JSONObject args=new JSONObject().put("deviceId",deviceId);
        // ApiClient uses current endpoint; the endpoint is not changed during normal logout.
        new ApiClient(app).call("unregisterPush",args,deviceToken);
      }catch(Exception ex){Log.w(TAG,"Could not unregister old push token",ex);}
    });
  }
}
