package ua.obshchak.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

/** Searchable offline category picker. Own categories and recent choices stay on this phone. */
final class ExpenseCategoryPicker {
  private static final String PREF="obshchak_categories";
  private static final String RECENT="recent";
  private static final String COUNTS="counts";
  private static final String[] COMMON={
    "Продукти","Вода","Побутова хімія","Господарські товари","Канцтовари",
    "Інтернет / зв’язок","Поповнення телефону","Транспорт","Паливо",
    "Ремонт","Обладнання","Інструменти","Медичні витрати","Інше"
  };
  private ExpenseCategoryPicker(){}

  static String last(Context context){
    ArrayList<String> list=recent(context);
    return list.isEmpty()?"":list.get(0);
  }
  static void record(Context context,String category){
    String name=category==null?"":category.trim();
    if(name.isEmpty())return;
    SharedPreferences p=context.getSharedPreferences(PREF,Context.MODE_PRIVATE);
    ArrayList<String> list=recent(context);
    list.remove(name);list.add(0,name);
    while(list.size()>20)list.remove(list.size()-1);
    JSONArray recentJson=new JSONArray();
    for(String item:list)recentJson.put(item);
    JSONObject counts=counts(context);
    try{counts.put(name,counts.optInt(name,0)+1);}catch(Exception ignored){}
    p.edit().putString(RECENT,recentJson.toString()).putString(COUNTS,counts.toString()).apply();
  }

  private static ArrayList<String> recent(Context context){
    ArrayList<String> list=new ArrayList<>();
    String raw=context.getSharedPreferences(PREF,Context.MODE_PRIVATE).getString(RECENT,"[]");
    try{JSONArray arr=new JSONArray(raw);
      for(int i=0;i<arr.length();i++){
        String v=arr.optString(i);if(!v.isEmpty())list.add(v);
      }
    }catch(Exception ignored){}
    return list;
  }
  private static JSONObject counts(Context context){
    String raw=context.getSharedPreferences(PREF,Context.MODE_PRIVATE).getString(COUNTS,"{}");
    try{return new JSONObject(raw);}catch(Exception ignored){return new JSONObject();}
  }

  private static int dp(Context context,int amount){
    return Math.round(context.getResources().getDisplayMetrics().density*amount);
  }
  private static GradientDrawable shape(int color,int radius,Context context){
    GradientDrawable bg=new GradientDrawable();
    bg.setColor(color);bg.setCornerRadius(dp(context,radius));
    return bg;
  }
  private static String icon(String title){
    String s=title.toLowerCase(new Locale("uk","UA"));
    if(s.contains("продукт")||s.contains("харч")||s.contains("кава"))return "🛒";
    if(s.contains("вода"))return "💧";
    if(s.contains("інтернет")||s.contains("телефон")||s.contains("зв'язок")||s.contains("зв’язок"))return "📶";
    if(s.contains("палив")||s.contains("генератор"))return "⛽";
    if(s.contains("транспорт")||s.contains("проїзд")||s.contains("таксі"))return "🚗";
    if(s.contains("ремонт")||s.contains("інструмент"))return "🛠";
    if(s.contains("медич")||s.contains("аптек"))return "🩺";
    if(s.contains("комуналь")||s.contains("оренд"))return "🏠";
    if(s.contains("подар")||s.contains("свят"))return "🎁";
    return "▣";
  }
  static void show(Activity activity,String current,Consumer<String> onChosen){
    LinearLayout content=new LinearLayout(activity);content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(dp(activity,16),dp(activity,6),dp(activity,16),dp(activity,4));
    EditText search=new EditText(activity);
    search.setSingleLine(true);search.setTextSize(15);
    search.setHint("🔎 Пошук категорії");
    search.setBackground(shape(0xffeef4f7,12,activity));
    search.setPadding(dp(activity,12),dp(activity,10),dp(activity,12),dp(activity,10));
    content.addView(search,new LinearLayout.LayoutParams(-1,dp(activity,52)));
    LinearLayout tabs=new LinearLayout(activity);tabs.setOrientation(LinearLayout.HORIZONTAL);
    content.addView(tabs);
    final String[] mode={"Усі"};
    ScrollView scroll=new ScrollView(activity);
    LinearLayout options=new LinearLayout(activity);options.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(options);
    content.addView(scroll,new LinearLayout.LayoutParams(-1,dp(activity,390)));
    AlertDialog dialog=new AlertDialog.Builder(activity)
      .setTitle("Категорія витрати")
      .setView(content)
      .setNegativeButton("Скасувати",null).create();
    // Rebuild only the category choice list when the active tab changes.
    final Runnable[] reload=new Runnable[1];
    reload[0]=()->{
      tabs.removeAllViews();
      for(String label:new String[]{"Усі","Часті","Останні"}){
        Button b=new Button(activity);b.setText(label);b.setAllCaps(false);b.setTextSize(12);
        boolean active=label.equals(mode[0]);b.setTextColor(active?Color.WHITE:0xff465766);
        b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(
          active?0xff087b64:0xffe9eef2));
        LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(0,dp(activity,45),1f);
        bp.setMargins(dp(activity,2),dp(activity,6),dp(activity,2),dp(activity,6));
        tabs.addView(b,bp);
        b.setOnClickListener(v->{mode[0]=label;reload[0].run();});
      }
      showOptions(activity,options,mode[0],search.getText().toString(),dialog,onChosen);
    };
    // Tabs and result list update in place while typing.
    search.addTextChangedListener(new TextWatcher(){
      public void beforeTextChanged(CharSequence s,int start,int count,int after){}
      public void onTextChanged(CharSequence s,int start,int before,int count){
        showOptions(activity,options,mode[0],s.toString(),dialog,onChosen);
      }
      public void afterTextChanged(Editable s){}
    });
    reload[0].run();
    dialog.show();
  }
  private static void showOptions(Activity activity,LinearLayout options,String mode,
                                  String query,AlertDialog dialog,Consumer<String> chosen){
    options.removeAllViews();
    ArrayList<String> recent=recent(activity);
    ArrayList<String> all=new ArrayList<>();
    Set<String> seen=new HashSet<>();
    ArrayList<String> source=new ArrayList<>();
    if(mode.equals("Останні"))source.addAll(recent);
    else if(mode.equals("Часті")){
      JSONObject scores=counts(activity);
      source.addAll(Arrays.asList(COMMON));
      for(String r:recent)if(!source.contains(r))source.add(r);
      Collections.sort(source,(a,b)->Integer.compare(scores.optInt(b,0),scores.optInt(a,0)));
    }else{
      source.addAll(Arrays.asList(ExpenseCategories.OPTIONS));
      for(String c:COMMON)if(!source.contains(c))source.add(c);
      for(String c:recent)if(!source.contains(c))source.add(c);
    }
    String needle=query.trim().toLowerCase(new Locale("uk","UA"));
    for(String item:source)
      if(seen.add(item)&&item.toLowerCase(new Locale("uk","UA")).contains(needle))
        all.add(item);
    int limit=Math.min(80,all.size());
    for(int i=0;i<limit;i++){
      String category=all.get(i);
      LinearLayout line=new LinearLayout(activity);line.setOrientation(LinearLayout.HORIZONTAL);
      line.setGravity(Gravity.CENTER_VERTICAL);
      line.setPadding(dp(activity,9),dp(activity,7),dp(activity,9),dp(activity,7));
      line.setBackground(shape(i%2==0?0xfff5f9fa:Color.WHITE,10,activity));
      LinearLayout.LayoutParams row=new LinearLayout.LayoutParams(-1,dp(activity,48));
      row.bottomMargin=dp(activity,3);options.addView(line,row);
      TextView pict=new TextView(activity);pict.setText(icon(category));pict.setTextSize(19);
      line.addView(pict,new LinearLayout.LayoutParams(dp(activity,36),-2));
      TextView text=new TextView(activity);text.setText(category);text.setTextSize(14);
      text.setTextColor(0xff18323e);text.setGravity(Gravity.CENTER_VERTICAL);
      line.addView(text,new LinearLayout.LayoutParams(0,-1,1f));
      line.setOnClickListener(v->{record(activity,category);chosen.accept(category);dialog.dismiss();});
    }
    Button custom=new Button(activity);custom.setAllCaps(false);custom.setText("＋ Власна категорія");
    custom.setTextColor(0xff076c59);
    options.addView(custom,new LinearLayout.LayoutParams(-1,dp(activity,48)));
    custom.setOnClickListener(v->{
      EditText input=new EditText(activity);input.setHint("Назва категорії");
      input.setText(query.trim());input.setSingleLine(true);
      LinearLayout wrapper=new LinearLayout(activity);
      wrapper.setPadding(dp(activity,20),0,dp(activity,20),0);
      wrapper.addView(input,new LinearLayout.LayoutParams(-1,-2));
      new AlertDialog.Builder(activity).setTitle("Власна категорія").setView(wrapper)
        .setNegativeButton("Скасувати",null).setPositiveButton("Додати",(d,w)->{
          String value=input.getText().toString().trim();
          if(!value.isEmpty()&&value.length()<=80){
            record(activity,value);chosen.accept(value);dialog.dismiss();
          }
        }).show();
    });
  }
}
