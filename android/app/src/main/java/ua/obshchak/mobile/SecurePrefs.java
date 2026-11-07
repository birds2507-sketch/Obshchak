package ua.obshchak.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Short-lived API token stored encrypted with Android Keystore; never stores password. */
final class SecurePrefs {
  private static final String ALIAS = "OBSHCHAK_API_TOKEN_V1";
  private final SharedPreferences pref;
  SecurePrefs(Context ctx) { pref=ctx.getSharedPreferences("private_session",Context.MODE_PRIVATE); }
  private SecretKey key() throws Exception {
    KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
    SecretKey key=(SecretKey)ks.getKey(ALIAS,null);
    if(key!=null)return key;
    KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    gen.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true).build());
    return gen.generateKey();
  }
  private String getSecret(String field) {
    try {
      String value=pref.getString(field,""); if(value.isEmpty())return "";
      String[] parts=value.split(":",2); if(parts.length!=2)return "";
      Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
      return new String(c.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }catch(Exception e){return "";}
  }
  private void putSecret(String field,String token) throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
    String iv=Base64.encodeToString(c.getIV(),Base64.NO_WRAP);
    String data=Base64.encodeToString(c.doFinal(token.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
    pref.edit().putString(field,iv+":"+data).apply();
  }
  String token(){return getSecret("token");}
  String deviceToken(){return getSecret("deviceToken");}
  void setToken(String token) throws Exception {putSecret("token",token);}
  void setDeviceToken(String token) throws Exception {putSecret("deviceToken",token);}
  void clearDeviceToken(){pref.edit().remove("deviceToken").apply();}
  void clear(){pref.edit().remove("token").remove("deviceToken").apply();}
}