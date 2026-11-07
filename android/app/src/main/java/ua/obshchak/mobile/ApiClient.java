package ua.obshchak.mobile;
import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Native HTTPS JSON bridge to Google Apps Script doPost(). */
final class ApiClient {
  private final Context context;
  ApiClient(Context ctx){context=ctx.getApplicationContext();}
  static class ApiException extends IOException {
    final boolean auth;
    final boolean retry;
    ApiException(String message,boolean auth,boolean retry){super(message);this.auth=auth;this.retry=retry;}
  }
  JSONObject call(String action,JSONObject data,String token) throws Exception {
    String endpoint=new Settings(context).url();
    if(!endpoint.matches("https://script\\.google\\.com/macros/s/[^/?#]+/exec"))throw new ApiException("У налаштуваннях потрібне посилання Apps Script із /exec",false,false);
    JSONObject body=new JSONObject();body.put("action",action);body.put("data",data);body.put("token",token);
    HttpURLConnection conn=null;
    try {
      conn=(HttpURLConnection)new URL(endpoint).openConnection();
      conn.setInstanceFollowRedirects(false);
      conn.setRequestMethod("POST"); conn.setConnectTimeout(25000);conn.setReadTimeout(45000);
      conn.setDoOutput(true);conn.setRequestProperty("Content-Type","application/json; charset=utf-8");
      byte[] bytes=body.toString().getBytes(StandardCharsets.UTF_8);
      conn.setFixedLengthStreamingMode(bytes.length);
      try(OutputStream out=conn.getOutputStream()){out.write(bytes);}
      int status=conn.getResponseCode();
      if(status==302||status==301||status==303||status==307||status==308){
        String target=conn.getHeaderField("Location");
        // ContentService redirects the JSON response to a Google-hosted URL after doPost executed.
        if(target==null||!target.startsWith("https://script.googleusercontent.com/"))
          throw new ApiException("Неочікуване перенаправлення сервера",false,false);
        conn.disconnect(); conn=(HttpURLConnection)new URL(target).openConnection();
        conn.setConnectTimeout(25000);conn.setReadTimeout(45000);
        conn.setRequestMethod("GET");status=conn.getResponseCode();
      }
      if(status<200||status>=300)throw new ApiException("Сервер Google повернув HTTP "+status,false,status>=500||status==429);
      String response;
      try(InputStream in=conn.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
        byte[] chunk=new byte[8192];int n;while((n=in.read(chunk))!=-1){out.write(chunk,0,n);if(out.size()>8_000_000)throw new IOException("Відповідь сервера завелика");}
        response=out.toString("UTF-8");
      }
      JSONObject result=new JSONObject(response);
      if(!result.optBoolean("ok")){
        String msg=result.optString("error","Помилка сервера");
        boolean auth=msg.contains("Сеанс")||msg.contains("увійти")||msg.contains("повторний вхід")||msg.contains("Доступ до облікового запису");
        boolean retry=msg.contains("too many")||msg.contains("Service invoked")||msg.contains("виконань")||msg.contains("Lock timeout");
        throw new ApiException(msg,auth,retry);
      }
      return result.getJSONObject("result");
    } finally {if(conn!=null)conn.disconnect();}
  }
}