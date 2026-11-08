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
  LocalStore(Context c){super(c,"obshchak_outbox.db",null,2);}
  @Override public void onCreate(SQLiteDatabase db){
    db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,payload TEXT NOT NULL,ledger_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '')");
    createComments(db);
  }
  private void createComments(SQLiteDatabase db){
    db.execSQL("CREATE TABLE IF NOT EXISTS comment_outbox(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,ledger_id TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '')");
  }
  @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){
    if(oldVersion==1&&newVersion>=2)createComments(db);
    else throw new IllegalStateException("Unknown migration; keep user's outbox");
  }
  void add(String id,String owner,String payload){ContentValues v=new ContentValues();v.put("id",id);v.put("owner_id",owner);v.put("payload",payload);v.put("status",PENDING);v.put("created_at",System.currentTimeMillis());getWritableDatabase().insertOrThrow("outbox",null,v);}
  static class PendingComment {
    String id,owner,ledger,message,status,error;long created;
  }
  void addComment(String id,String owner,String ledger,String text){
    ContentValues v=new ContentValues();v.put("id",id);v.put("owner_id",owner);v.put("ledger_id",ledger);
    v.put("message",text);v.put("status",PENDING);v.put("created_at",System.currentTimeMillis());
    getWritableDatabase().insertOrThrow("comment_outbox",null,v);
  }
  List<PendingComment> comments(String owner,boolean all){
    List<PendingComment> rows=new ArrayList<>();
    String filter=all?"":" AND status <> 'SYNCED'";
    try(Cursor c=getReadableDatabase().rawQuery("SELECT id,owner_id,ledger_id,message,status,created_at,error FROM comment_outbox WHERE owner_id=?"+filter+" ORDER BY created_at ASC",new String[]{owner})){
      while(c.moveToNext()){
        PendingComment e=new PendingComment();
        e.id=c.getString(0);e.owner=c.getString(1);e.ledger=c.getString(2);
        e.message=c.getString(3);e.status=c.getString(4);
        e.created=c.getLong(5);e.error=c.getString(6);rows.add(e);
      }
    }
    return rows;
  }
  void commentStatus(String id,String status,String error){
    ContentValues v=new ContentValues();v.put("status",status);v.put("error",error==null?"":error);
    getWritableDatabase().update("comment_outbox",v,"id=?",new String[]{id});
  }
  void retryComment(String id){commentStatus(id,PENDING,"");}
  void resumeCommentAuth(String owner){
    ContentValues v=new ContentValues();v.put("status",PENDING);v.put("error","");
    getWritableDatabase().update("comment_outbox",v,"owner_id=? AND status=?",new String[]{owner,AUTH});
  }
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
  /** Include ALL unsynced operations for mathematically correct provisional balances.
   * Keep only the last 7 days of already-synced rows; older ones are in the Google ledger.
   */
  List<Entry> recentTransactions(String owner){
    List<Entry> rows=new ArrayList<>();
    long cutoff=System.currentTimeMillis()-7L*24*60*60*1000;
    try(Cursor c=getReadableDatabase().rawQuery(
      "SELECT id,owner_id,payload,ledger_id,status,created_at,error FROM outbox "+
      "WHERE owner_id=? AND (status<>? OR created_at>=?) "+
      "ORDER BY created_at DESC, rowid DESC",
      new String[]{owner,SYNCED,String.valueOf(cutoff)})){
      while(c.moveToNext()){
        Entry e=new Entry();e.id=c.getString(0);e.owner=c.getString(1);
        e.payload=c.getString(2);e.ledger=c.getString(3);
        e.status=c.getString(4);e.created=c.getLong(5);e.error=c.getString(6);
        rows.add(e);
      }
    }
    java.util.Collections.reverse(rows);
    return rows;
  }

  void ledger(String id,String ledger){ContentValues v=new ContentValues();v.put("ledger_id",ledger);getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
  void status(String id,String status,String error){ContentValues v=new ContentValues();v.put("status",status);v.put("error",error==null?"":error);getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
  void updatePayload(String id,JSONObject body){ContentValues v=new ContentValues();v.put("payload",body.toString());getWritableDatabase().update("outbox",v,"id=?",new String[]{id});}
}