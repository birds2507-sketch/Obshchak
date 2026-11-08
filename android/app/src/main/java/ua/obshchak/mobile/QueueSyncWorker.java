package ua.obshchak.mobile;

import android.content.Context;
import android.os.Build;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.WorkManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.TimeUnit;

/** Resumable upload: first create ledger entry, then receipts, each with stable idempotency key. */
public class QueueSyncWorker extends Worker {
  public QueueSyncWorker(@NonNull Context ctx,@NonNull WorkerParameters params){super(ctx,params);}
  static void schedule(Context c){
    Constraints constraints=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    OneTimeWorkRequest.Builder builder=new OneTimeWorkRequest.Builder(QueueSyncWorker.class)
        .setConstraints(constraints)
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS);
    // Android 12+: priority execution. Android 11 and below: standard reliable
    // WorkManager scheduling, without requiring a foreground-service notification.
    if(Build.VERSION.SDK_INT>=31)
      builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST);
    OneTimeWorkRequest request=builder.build();
    WorkManager.getInstance(c).enqueueUniqueWork("obshchak_sync",ExistingWorkPolicy.APPEND_OR_REPLACE,request);
  }
  @NonNull @Override public Result doWork(){
    Context c=getApplicationContext();Settings s=new Settings(c);String token=new SecurePrefs(c).deviceToken();
    if(token.isEmpty()||s.userId().isEmpty())return Result.success();
    LocalStore store=new LocalStore(c);ApiClient api=new ApiClient(c);boolean retry=false;
    for(LocalStore.Entry item:store.list(s.userId(),false)){
      if(isStopped())return Result.retry();
      if(LocalStore.FAILED.equals(item.status))continue;
      JSONObject body=item.body();
      try {
        if(item.ledger.isEmpty()) {
          JSONObject tx=body.getJSONObject("tx");tx.put("clientId",item.id);
          JSONObject result=api.call("syncTransaction",tx,token);
          String ledgerId=result.getString("id");store.ledger(item.id,ledgerId);item.ledger=ledgerId;
        }
        JSONArray files=body.optJSONArray("files");
        if(files!=null)for(int j=0;j<files.length();j++){
          JSONObject f=files.getJSONObject(j);if(f.optBoolean("uploaded"))continue;
          File input=new File(f.getString("uploadPath"));
          if(!input.exists())throw new ApiClient.ApiException("Локальний чек відсутній: "+f.optString("name"),false,false);
          ByteArrayOutputStream out=new ByteArrayOutputStream();
          try(FileInputStream in=new FileInputStream(input)){
            byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1){out.write(bytes,0,n);if(out.size()>2_000_000)throw new ApiClient.ApiException("Чек перевищує 2 МБ",false,false);}
          }
          JSONObject receipt=new JSONObject().put("name",f.getString("name")).put("mime",f.getString("mime"))
            .put("data",Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP));
          JSONObject args=new JSONObject().put("ledgerId",item.ledger).put("receiptId",f.getString("id")).put("receipt",receipt);
          api.call("syncReceipt",args,token);
          f.put("uploaded",true);store.updatePayload(item.id,body);
        }
        store.status(item.id,LocalStore.SYNCED,"");
      } catch(ApiClient.ApiException e){
        if(e.auth){store.status(item.id,LocalStore.AUTH,"Потрібен повторний вхід у застосунок");return Result.success();}
        if(e.retry){store.status(item.id,LocalStore.PENDING,e.getMessage());retry=true;break;}
        store.status(item.id,LocalStore.FAILED,e.getMessage());
      }catch(Exception e){
        store.status(item.id,LocalStore.PENDING,"Немає відповіді Google. Буде повторна спроба.");retry=true;break;
      }
    }
    // Offline comments belong to every active member, not just the cashier.
    // Retry only with the stable client UUID; the server rejects conflicting duplicates.
    if(!retry)for(LocalStore.PendingComment item:store.comments(s.userId(),false)){
      if(isStopped())return Result.retry();
      if(LocalStore.FAILED.equals(item.status))continue;
      try{
        JSONObject args=new JSONObject().put("clientId",item.id)
          .put("ledgerId",item.ledger).put("message",item.message);
        api.call("syncComment",args,token);
        store.commentStatus(item.id,LocalStore.SYNCED,"");
      }catch(ApiClient.ApiException e){
        if(e.auth){
          store.commentStatus(item.id,LocalStore.AUTH,"Сеанс синхронізації завершився. Увійдіть повторно.");
          return Result.success();
        }
        if(e.retry){store.commentStatus(item.id,LocalStore.PENDING,e.getMessage());retry=true;break;}
        store.commentStatus(item.id,LocalStore.FAILED,e.getMessage());
      }catch(Exception e){
        store.commentStatus(item.id,LocalStore.PENDING,"Передача не завершена. Буде повторна спроба.");
        retry=true;break;
      }
    }
    return retry?Result.retry():Result.success();
  }
}