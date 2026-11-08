package ua.obshchak.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One display model for Google-confirmed operations and cashier's local outbox.
 * Local amounts are provisional, not part of the official shared ledger.
 * The clientId is the ledger row ID: when Google confirms it, there is no double count.
 */
final class CashLedgerPreview {
  static final class Row {
    final JSONObject tx;
    final LocalStore.Entry local; // null means confirmed in Google's current snapshot
    final long signedCents;
    final Long balanceAfter; // for local row: operational estimate; for Google row: confirmed
    boolean pendingReceipt;
    Row(JSONObject tx,LocalStore.Entry local,long signedCents,Long balanceAfter){
      this.tx=tx;this.local=local;this.signedCents=signedCents;this.balanceAfter=balanceAfter;
    }
    boolean isLocal(){return local!=null;}
    String kind(){return tx.optString("kind");}
    String id(){return isLocal()?local.id:tx.optString("id");}
    int localReceiptCount(){
      if(!isLocal())return 0;
      JSONArray files=local.body().optJSONArray("files");
      return files==null?0:files.length();
    }
  }

  final ArrayList<Row> rows=new ArrayList<>(); // newest first
  long confirmedBalance;
  long operationalBalance;
  long confirmedIncome;
  long confirmedExpense;
  long operationalIncome;
  long operationalExpense;
  int localCount;
  int needsAttention;

  static long asCents(String currencyAmount){
    try{
      return new BigDecimal(currencyAmount.trim().replace(',','.'))
        .movePointRight(2).longValueExact();
    }catch(Exception ex){return 0L;}
  }

  static CashLedgerPreview build(JSONObject state,List<LocalStore.Entry> localRecords){
    CashLedgerPreview view=new CashLedgerPreview();
    JSONObject total=state.optJSONObject("totals");
    if(total!=null){
      view.confirmedBalance=total.optLong("balance");
      view.confirmedIncome=total.optLong("income");
      view.confirmedExpense=total.optLong("expense");
    }
    view.operationalBalance=view.confirmedBalance;
    view.operationalIncome=view.confirmedIncome;
    view.operationalExpense=view.confirmedExpense;
    JSONArray ledger=state.optJSONArray("ledger");
    Set<String> confirmedIds=new HashSet<>();
    if(ledger!=null)for(int i=0;i<ledger.length();i++){
      JSONObject e=ledger.optJSONObject(i);
      if(e!=null)confirmedIds.add(e.optString("id"));
    }

    // LocalStore delivers ascending creation time, so provisional balances follow
    // the actual order in which the cashier pressed Save.
    ArrayList<Row> localRows=new ArrayList<>();
    Map<String,Boolean> uploadingReceipts=new HashMap<>();
    if(localRecords!=null)for(LocalStore.Entry entry:localRecords){
      JSONObject payload=entry.body();
      JSONArray files=payload.optJSONArray("files");
      if(files!=null){
        boolean unsent=false;
        for(int i=0;i<files.length();i++){
          JSONObject f=files.optJSONObject(i);
          if(f!=null&&!f.optBoolean("uploaded",false)){unsent=true;break;}
        }
        if(unsent){
          if(!entry.id.isEmpty())uploadingReceipts.put(entry.id,true);
          if(entry.ledger!=null&&!entry.ledger.isEmpty())uploadingReceipts.put(entry.ledger,true);
        }
      }
      JSONObject tx=payload.optJSONObject("tx");
      if(tx==null)continue; // Receipt-only jobs are not extra money.
      if(confirmedIds.contains(entry.id)||
         (entry.ledger!=null&&!entry.ledger.isEmpty()&&confirmedIds.contains(entry.ledger)))
        continue; // Google already counted the same client operation.
      String kind=tx.optString("kind");
      if(!kind.equals("IN")&&!kind.equals("OUT"))continue;
      long signed=asCents(tx.optString("amount","0"));
      if(kind.equals("OUT"))signed=-Math.abs(signed);
      else signed=Math.abs(signed);
      view.operationalBalance+=signed;
      if(kind.equals("IN"))view.operationalIncome+=signed;
      else view.operationalExpense-=signed;
      view.localCount++;
      if(LocalStore.FAILED.equals(entry.status)||LocalStore.AUTH.equals(entry.status))
        view.needsAttention++;
      Row row=new Row(tx,entry,signed,view.operationalBalance);
      localRows.add(row);
    }
    // Local cards appear above the last confirmed Google operations, not in a
    // separate technical list. Most recent cashier actions are at the very top.
    for(int i=localRows.size()-1;i>=0;i--)view.rows.add(localRows.get(i));
    if(ledger!=null)for(int i=0;i<ledger.length();i++){
      JSONObject tx=ledger.optJSONObject(i);
      if(tx==null)continue;
      String kind=tx.optString("kind");
      if(!kind.equals("IN")&&!kind.equals("OUT")&&!kind.equals("OPENING")&&!kind.equals("REVERSAL"))continue;
      Long after=tx.has("balance_after")&&!tx.isNull("balance_after")?
        tx.optLong("balance_after"):null;
      Row row=new Row(tx,null,tx.optLong("amount"),after);
      row.pendingReceipt=Boolean.TRUE.equals(uploadingReceipts.get(row.id()));
      view.rows.add(row);
    }
    return view;
  }
}
