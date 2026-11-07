package ua.obshchak.mobile;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

/** Copies original locally first; upload derivative is limited to backend's 2MB cap. */
final class ImageStore {
  static final long MAX_UPLOAD = 2_000_000L;
  static class Receipt {
    final JSONObject info;
    Receipt(JSONObject i){info=i;}
  }
  static Receipt capture(Context ctx,Uri uri,String mime) throws Exception {
    if(mime==null||mime.isEmpty())mime=ctx.getContentResolver().getType(uri);
    if(mime==null)throw new IllegalArgumentException("Невідомий формат чека");
    if(!mime.equals("image/jpeg")&&!mime.equals("image/png")&&!mime.equals("image/webp")&&!mime.equals("image/heic")&&!mime.equals("image/heif")&&!mime.equals("application/pdf"))
      throw new IllegalArgumentException("Дозволені фото JPG, PNG, WebP або PDF");
    String id=UUID.randomUUID().toString();
    File base=new File(ctx.getFilesDir(),"receipts");
    File originals=new File(base,"original");File upload=new File(base,"upload");
    if(!originals.exists()&&!originals.mkdirs())throw new IllegalStateException("Немає місця для оригіналу");
    if(!upload.exists()&&!upload.mkdirs())throw new IllegalStateException("Немає місця для файлів");
    String ext=mime.equals("application/pdf")?"pdf":mime.equals("image/png")?"png":mime.equals("image/webp")?"webp":mime.equals("image/heic")?"heic":mime.equals("image/heif")?"heif":"jpg";
    File original=new File(originals,id+"."+ext);
    try(InputStream in=ctx.getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(original)){
      if(in==null)throw new IllegalArgumentException("Не вдалося відкрити файл");
      byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1){out.write(bytes,0,n);}
    }
    File derivative=new File(upload,id+"."+ext);
    String uploadMime=mime;
    if(original.length()<=MAX_UPLOAD && !mime.equals("image/heic") && !mime.equals("image/heif")){copy(original,derivative);}
    else if(mime.equals("application/pdf"))throw new IllegalArgumentException("PDF більший за 2 МБ. Оберіть менший файл");
    else {
      // Sample a large bitmap to reduce memory footprint; leave original intact.
      BitmapFactory.Options opt=new BitmapFactory.Options();opt.inJustDecodeBounds=true;BitmapFactory.decodeFile(original.getAbsolutePath(),opt);
      int sample=1;while(opt.outWidth/sample>2000||opt.outHeight/sample>2000)sample*=2;
      opt.inJustDecodeBounds=false;opt.inSampleSize=sample;
      Bitmap b=BitmapFactory.decodeFile(original.getAbsolutePath(),opt);
      if(b==null)throw new IllegalArgumentException("Не вдалося обробити фотографію");
      // Preserve readable orientation when Android's camera encodes rotation in EXIF.
      try {
        int orientation=new ExifInterface(original.getAbsolutePath()).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL);
        int degrees=orientation==ExifInterface.ORIENTATION_ROTATE_90?90:orientation==ExifInterface.ORIENTATION_ROTATE_180?180:orientation==ExifInterface.ORIENTATION_ROTATE_270?270:0;
        if(degrees!=0){Matrix matrix=new Matrix();matrix.postRotate(degrees);Bitmap rotated=Bitmap.createBitmap(b,0,0,b.getWidth(),b.getHeight(),matrix,true);b.recycle();b=rotated;}
      }catch(Exception ignored){}
      derivative=new File(upload,id+".jpg");uploadMime="image/jpeg";
      boolean fits=false;
      for(int quality=85;quality>=35;quality-=10){
        try(OutputStream out=new FileOutputStream(derivative)){b.compress(Bitmap.CompressFormat.JPEG,quality,out);}
        if(derivative.length()<=MAX_UPLOAD){fits=true;break;}
      }
      b.recycle();
      if(!fits)throw new IllegalArgumentException("Фото завелике. Зробіть інший знімок");
    }
    JSONObject j=new JSONObject();j.put("id",id).put("name","Чек_"+id.substring(0,8)+(uploadMime.equals("application/pdf")?".pdf":uploadMime.equals("image/png")?".png":uploadMime.equals("image/webp")?".webp":".jpg"));
    j.put("mime",uploadMime);j.put("originalMime",mime);j.put("originalPath",original.getAbsolutePath());j.put("uploadPath",derivative.getAbsolutePath());j.put("uploaded",false);
    return new Receipt(j);
  }
  private static void copy(File input,File target) throws Exception {
    try(InputStream in=new FileInputStream(input);OutputStream out=new FileOutputStream(target)){
      byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);
    }
  }
}