"""Builds messages.csv and labels-claude.csv from rows.txt (one message per line, fields split by ' || ').
Fields: text || place || depth_cm || people || needs(a|b) || vulnerable(yes/no) || severity 1-5
Written and labelled by Claude as ONE author. This is a synthetic stress test, NOT an independent accuracy result."""
import csv, re
rows=[l.rstrip("\n") for l in open("rows.txt",encoding="utf-8") if l.strip()]
with open("messages.csv","w",newline="",encoding="utf-8-sig") as m, open("labels-claude.csv","w",newline="",encoding="utf-8-sig") as L:
    mw=csv.writer(m); lw=csv.writer(L)
    mw.writerow(["id","t"]); lw.writerow(["id","t","place","depth","ppl","needs","vul","sev","labeler"])
    for i,l in enumerate(rows,1):
        t,pl,de,pp,ne,vu,sv=[x.strip() for x in re.split(r"\s*\|\|\s*", l)]
        mw.writerow([i,t]); lw.writerow([i,t,pl,de,pp,ne,vu,sv,"claude"])
print(len(rows),"messages")
