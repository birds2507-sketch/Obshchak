package ua.obshchak.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure reporting over the same unified Google + local cashier ledger shown on Home.
 * All values are integer cents. Reversals of expenses subtract from the original
 * category and direction; opening balances and income are excluded.
 */
final class ExpenseStatistics {
  static final String ALL="Усі напрями";
  static final String UNKNOWN="Без напряму";
  static final String[] DIRECTIONS={ALL,"МП","ГМЕ 1","ГМЕ 2",UNKNOWN};
  static final class Group {
    final String name;
    long cents;
    int expenses;
    int reversals;
    int local;
    Group(String name){this.name=name;}
  }
  final Map<String,Group> byCategory=new HashMap<>();
  final Map<String,Group> byDirection=new HashMap<>();
  long netCents;
  int expenses;
  int reversals;
  int local;
  int missingDirection;
  boolean monthOnly;
  String month;
  String direction;

  static String directionOf(CashLedgerPreview.Row row){
    String raw=row.tx.optString("expense_target",
      row.tx.optString("expenseTarget","")).trim();
    return raw.isEmpty()?UNKNOWN:raw;
  }

  static ExpenseStatistics calculate(List<CashLedgerPreview.Row> rows,
                                     boolean monthOnly,String month,String direction){
    ExpenseStatistics result=new ExpenseStatistics();
    result.monthOnly=monthOnly;result.month=month;result.direction=direction;
    Map<String,CashLedgerPreview.Row> originals=new HashMap<>();
    for(CashLedgerPreview.Row row:rows)
      if("OUT".equals(row.kind()))originals.put(row.id(),row);
    for(CashLedgerPreview.Row row:rows){
      boolean reversed="REVERSAL".equals(row.kind());
      CashLedgerPreview.Row source=reversed?
          originals.get(row.tx.optString("correction_of")):row;
      if(source==null||!"OUT".equals(source.kind()))continue;
      if(monthOnly&&!row.tx.optString("date").startsWith(month))continue;
      String dest=directionOf(source);
      if(!ALL.equals(direction)&&!direction.equals(dest))continue;
      String category=source.tx.optString("category","Без категорії").trim();
      if(category.isEmpty())category="Без категорії";
      long signedSpent=-row.signedCents;
      boolean local=row.isLocal();
      result.netCents+=signedSpent;
      if(reversed)result.reversals++;else result.expenses++;
      if(local)result.local++;
      if(UNKNOWN.equals(dest)&&!reversed)result.missingDirection++;
      add(result.byCategory,category,signedSpent,reversed,local);
      add(result.byDirection,dest,signedSpent,reversed,local);
    }
    return result;
  }

  private static void add(Map<String,Group> target,String name,long amount,
                          boolean reverse,boolean local){
    Group group=target.get(name);
    if(group==null){group=new Group(name);target.put(name,group);}
    group.cents+=amount;
    if(reverse)group.reversals++;else group.expenses++;
    if(local)group.local++;
  }

  static List<Group> sorted(Map<String,Group> groups){
    ArrayList<Group> list=new ArrayList<>(groups.values());
    Collections.sort(list,(a,b)->{
      int c=Long.compare(b.cents,a.cents);
      return c!=0?c:a.name.compareToIgnoreCase(b.name);
    });
    return list;
  }
}
