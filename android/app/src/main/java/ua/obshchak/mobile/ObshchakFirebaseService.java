package ua.obshchak.mobile;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Data-only FCM messages are handled even when Android has closed the UI. */
public final class ObshchakFirebaseService extends FirebaseMessagingService {
  @Override public void onNewToken(String token){
    super.onNewToken(token);
    FirebaseBridge.tokenUpdated(this,token);
  }

  @Override public void onMessageReceived(RemoteMessage message){
    super.onMessageReceived(message);
    Map<String,String> data=message.getData();
    if(data==null||data.isEmpty())return;
    NotificationAlerts.receiveFcm(this,data);
  }
}
