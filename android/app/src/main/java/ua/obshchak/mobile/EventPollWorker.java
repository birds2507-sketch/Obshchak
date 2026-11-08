package ua.obshchak.mobile;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

/**
 * Android OS notifications based on periodic checks. Not instantaneous FCM push.
 * WorkManager has a 15-minute minimum and the OS may defer work to save battery.
 */
public final class EventPollWorker extends Worker {
  private static final String UNIQUE="obshchak_event_notifications";
  public EventPollWorker(@NonNull Context c,@NonNull WorkerParameters p){super(c,p);}

  static void schedule(Context context){
    Constraints constraints=new Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED).build();
    PeriodicWorkRequest request=new PeriodicWorkRequest.Builder(EventPollWorker.class,15,TimeUnit.MINUTES)
        .setConstraints(constraints).build();
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE,ExistingPeriodicWorkPolicy.KEEP,request);
  }

  static void cancel(Context context){
    WorkManager.getInstance(context).cancelUniqueWork(UNIQUE);
  }

  @NonNull @Override public Result doWork(){
    Context context=getApplicationContext();
    Settings settings=new Settings(context);
    String owner=settings.userId();
    String token=new SecurePrefs(context).deviceToken();
    if(owner.isEmpty()||token.isEmpty())return Result.success();
    try{
      JSONObject response=new ApiClient(context).call("deviceEvents",new JSONObject(),token);
      JSONArray events=response.optJSONArray("events");
      if(events!=null)NotificationAlerts.notifyNew(context,owner,events);
      return Result.success();
    }catch(ApiClient.ApiException e){
      // A missing server deployment or an expired device key needs a foreground sign-in.
      if(e.auth)return Result.success();
      return e.retry?Result.retry():Result.success();
    }catch(Exception e){
      return Result.retry();
    }
  }
}
