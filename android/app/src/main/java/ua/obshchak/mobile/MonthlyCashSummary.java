package ua.obshchak.mobile;

import org.json.JSONObject;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/** Monthly view based on transaction business dates; never writes financial data. */
final class MonthlyCashSummary {
  final YearMonth month;
  final ArrayList<CashLedgerPreview.Row> rows=new ArrayList<>();
  long opening,closing,income,expense,adjustments;
  long confirmedClosing;
  int pendingCount, attentionCount;
  boolean hasLedgerSnapshot;

  private MonthlyCashSummary(YearMonth month){this.month=month;}

  static MonthlyCashSummary calculate(CashLedgerPreview preview,String yearMonth,boolean hasSnapshot){
    YearMonth chosen=YearMonth.parse(yearMonth);
    MonthlyCashSummary out=new MonthlyCashSummary(chosen);
    out.hasLedgerSnapshot=hasSnapshot;
    String first=chosen.atDay(1).toString();
    String next=chosen.plusMonths(1).atDay(1).toString();
    long opening=preview.operationalBalance;
    long confirmedOpening=preview.confirmedBalance;
    Map<String,String> kindById=new HashMap<>();
    for(CashLedgerPreview.Row row:preview.rows)
      if(!row.isLocal())kindById.put(row.id(),row.kind());

    // Start from the current full cash total and undo all later-dated entries.
    // An OPENING row dated within this month becomes its beginning balance.
    for(CashLedgerPreview.Row row:preview.rows){
      String date=row.tx.optString("date");
      if(date.length()!=10)continue;
      boolean inMonth=date.compareTo(first)>=0&&date.compareTo(next)<0;
      if(date.compareTo(first)>=0&&!(inMonth&&"OPENING".equals(row.kind()))){
        opening-=row.signedCents;
        if(!row.isLocal())confirmedOpening-=row.signedCents;
      }
      if(!inMonth)continue;
      out.rows.add(row);
      if(row.isLocal()){
        out.pendingCount++;
        if(LocalStore.AUTH.equals(row.local.status)||LocalStore.FAILED.equals(row.local.status))
          out.attentionCount++;
      }
      if("OPENING".equals(row.kind()))continue;
      String kind=row.kind();
      if("REVERSAL".equals(kind))
        kind=kindById.getOrDefault(row.tx.optString("correction_of"),"ADJUSTMENT");
      if("IN".equals(kind))out.income+=row.signedCents;
      else if("OUT".equals(kind))out.expense-=row.signedCents;
      else out.adjustments+=row.signedCents;
    }
    out.opening=opening;
    out.closing=opening+out.income-out.expense+out.adjustments;
    // Include opening entries within this month: those were already included in opening.
    out.confirmedClosing=confirmedOpening;
    for(CashLedgerPreview.Row row:out.rows)
      if(!row.isLocal()&&!"OPENING".equals(row.kind()))
        out.confirmedClosing+=row.signedCents;
    return out;
  }
}
