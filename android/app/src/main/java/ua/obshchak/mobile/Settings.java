package ua.obshchak.mobile;
import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.util.UUID;

final class Settings {
  private final SharedPreferences p;
  Settings(Context c){p=c.getSharedPreferences("obshchak_settings",Context.MODE_PRIVATE);}
  // The APK carries the common group endpoint; a PIN-protected override is optional.
  // An already saved endpoint from a previous installation takes precedence.
  String url(){String saved=p.getString("url","");return saved.isEmpty()?BuildConfig.DEFAULT_SERVER_URL:saved;}
  void url(String value){p.edit().putString("url",value).apply();}
  String deviceId(){String id=p.getString("device_id","");if(id.isEmpty()){
    id=UUID.randomUUID().toString();p.edit().putString("device_id",id).apply();}return id;}
  String userId(){return p.getString("user_id","");}
  String username(){return p.getString("username","");}
  String role(){return p.getString("role","");}
  void user(JSONObject u){p.edit().putString("user_id",u.optString("id")).putString("username",u.optString("name")).putString("role",u.optString("role")).apply();}
  void clearUser(){p.edit().remove("user_id").remove("username").remove("role").apply();}
  String draftKey(String kind){return "draft_"+userId()+"_"+kind;}
  JSONObject getDraft(String kind){try{return new JSONObject(p.getString(draftKey(kind),"{}"));}catch(Exception e){return new JSONObject();}}
  void saveDraft(String kind,JSONObject d){p.edit().putString(draftKey(kind),d.toString()).apply();}
  void clearDraft(String kind){p.edit().remove(draftKey(kind)).apply();}
}