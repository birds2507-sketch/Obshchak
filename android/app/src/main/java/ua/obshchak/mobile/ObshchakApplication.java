package ua.obshchak.mobile;

import android.app.Application;

/** Initialize Firebase before the messaging service can be created in a background process. */
public final class ObshchakApplication extends Application {
  @Override public void onCreate(){
    super.onCreate();
    NotificationAlerts.prepare(this);
    FirebaseBridge.initialize(this);
  }
}
