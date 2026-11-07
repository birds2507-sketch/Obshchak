package ua.obshchak.mobile;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Durable outbox; never removes local source receipt files automatically. */
final class LocalStore extends SQLiteOpenHelper {
  static final String PENDING="PENDING", SYNCED="SYNCED", AUTH="AUTH_REQUIRED", FAILED="NEEDS_ATTENTION";
  LocalStore(Context c){super(c,"obshchak_outbox.db",null,1);}
  @Override public void onCreate(SQLiteDatabase db){db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL,ledger_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '')");}
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){throw new IllegalStateException("Missing migration; keep user's outbox");}
  void add(String id,String owner,String payload){ContentValues v=new ContentValues();v.put("id",id);v.put("owner_id",owner);v.put("payload",payload);v.put("status",PENDING);v.put("created_at",System.currentTimeMillis());getWritableDatabase().insertOrThrow("outbox",null,v);}
  void addReceiptOnly(String id,String owner,String ledger,JSONObject body){
    ContentValues v=new ContentValues();v.put("id",id);v.put("owner_id",owner);v.put("payload",body.toString());
    v.put("ledger_id",ledger);v.put("status",PENDING);v.put("created_at",System.currentTimeMillis());
    getWritableDatabase().insertOrThrow("outbox",null,v);
  }
  void resumeAuth(String owner){ContentValues v=new ContentValues();v.put("status",PENDING);v.put("error","");
    getWritableDatabase().update("outbox",v,"owner_id=? AND status=?",new String[]{owner,AUTH});}
  void retry(String id){ContentValues v=new ContentValues();v.put("status",PENDING);v.put("error","");getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
  static class Entry {
    String id,owner,payload,ledger,status,error; long created;
    JSONObject body(){try{return new JSONObject(payload);}catch(Exception ex){return new JSONObject();}}
  }
  List<Entry> list(String owner,boolean all){
    List<Entry> rows=new ArrayList<>();
    String filter=all?"":" AND status <> 'SYNCED'";
    try(Cursor c=getReadableDatabase().rawQuery("SELECT id,owner_id,payload,ledger_id,status,created_at,error FROM outbox WHERE owner_id=?"+filter+" ORDER BY created_at ASC",new String[]{owner})){
      while(c.moveToNext()){Entry e=new Entry();e.id=c.getString(0);e.owner=c.getString(1);e.payload=c.getString(2);e.ledger=c.getString(3);e.status=c.getString(4);e.created=c.getLong(5);e.error=c.getString(6);rows.add(e);}
    }
    return rows;
  }
  void ledger(String id,String ledger){ContentValues v=new ContentValues();v.put("ledger_id",ledger);getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
  void status(String id,String status,String error){ContentValues v=new ContentValues();v.put("status",status);v.put("error",error==null?"":error);getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
  void updatePayload(String id,JSONObject body){ContentValues v=new ContentValues();v.put("payload",body.toString());getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
}