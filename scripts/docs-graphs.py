"""Draws the README graphs from docs/assets/data.json and tests.json (both produced from the real code).
   npm run docs:data && python3 scripts/docs-graphs.py"""
import json, collections
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

A = "docs/assets/"
d = json.load(open(A + "data.json"))
t = json.load(open(A + "tests.json"))

BG, PANEL, FG, MU = "#0b1220", "#121c31", "#eef2f8", "#9aa8bf"
C = dict(blue="#4da3ff", green="#2fbf71", amber="#f5a524", red="#e5484d", teal="#2fe0b0", violet="#a78bfa")
plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": PANEL, "savefig.facecolor": BG, "text.color": FG, "axes.labelcolor": MU,
    "xtick.color": MU, "ytick.color": MU, "axes.edgecolor": "#27344d", "grid.color": "#27344d", "font.size": 11,
    "axes.titlesize": 12.5, "axes.titleweight": "bold", "axes.titlecolor": FG, "font.family": "DejaVu Sans",
})

def style(ax, grid="y"):
    for s in ("top", "right"): ax.spines[s].set_visible(False)
    ax.grid(axis=grid, alpha=.6, lw=.7); ax.set_axisbelow(True)

def save(fig, name, note=None):
    if note: fig.text(0.01, 0.005, note, color=MU, fontsize=8.5, ha="left", va="bottom")
    fig.savefig(A + name, dpi=130, bbox_inches="tight", pad_inches=.25); plt.close(fig)

# 1 ---- priority score ingredients
cv = d["curves"]
fig, ax = plt.subplots(2, 2, figsize=(11, 7.2))
a = ax[0][0]; x = [p["x"] for p in cv["reporters"]]; y = [p["y"] for p in cv["reporters"]]
a.plot(x, y, color=C["blue"], lw=2.6, marker="o", ms=4); a.fill_between(x, y, alpha=.12, color=C["blue"])
a.set_title("More independent reporters"); a.set_xlabel("unique reporters"); a.set_ylabel("priority 0-100"); a.set_ylim(0, 100); style(a)
a = ax[0][1]; x = [p["x"] for p in cv["people"]]; y = [p["y"] for p in cv["people"]]
a.plot(x, y, color=C["teal"], lw=2.6, marker="o", ms=5); a.fill_between(x, y, alpha=.12, color=C["teal"])
a.set_xscale("symlog", linthresh=5); a.set_xticks([0, 5, 10, 20, 40, 80, 150, 300]); a.set_xticklabels(["0", "5", "10", "20", "40", "80", "150", "300"])
a.set_title("More people at risk (log scale)"); a.set_xlabel("people"); a.set_ylim(0, 100); style(a)
a = ax[1][0]; ks = [p["x"] for p in cv["severity"]]; ys = [p["y"] for p in cv["severity"]]
bars = a.bar([str(k) for k in ks], ys, color=[C["green"], C["teal"], C["amber"], "#ff8a3d", C["red"]], width=.62)
for b, v in zip(bars, ys): a.text(b.get_x() + b.get_width() / 2, v + 1.5, str(v), ha="center", color=FG, fontsize=10)
a.set_title("Higher severity (1 = wet floor, 5 = life at risk)"); a.set_xlabel("severity"); a.set_ylim(0, 100); style(a)
a = ax[1][1]; fl = cv["flags"]; names = [f["k"] for f in fl]; vals = [f["y"] for f in fl]
cols = [MU, C["violet"], C["red"], MU, C["amber"], C["blue"]]
bars = a.barh(names[::-1], vals[::-1], color=cols[::-1], height=.6)
for b, v in zip(bars, vals[::-1]): a.text(v + 1, b.get_y() + b.get_height() / 2, str(v), va="center", fontsize=10)
a.set_title("Who needs help first"); a.set_xlim(0, 80); a.set_xlabel("priority 0-100"); style(a, "x")
fig.suptitle("How the priority score reacts (computed by the real scoring code, other inputs held fixed)", color=FG, fontsize=13, fontweight="bold", y=1.0)
fig.tight_layout(); save(fig, "g-score.png", "Inputs: severity 3, 1 reporter, 10 people unless varied. 'assigned' drops an incident out of the urgent list because a crew is already on it.")

# 2 ---- dedupe
dd = d["dedupe"]; xs = [p["reports"] for p in dd]
fig, ax = plt.subplots(figsize=(10, 4.6))
ax.plot(xs, xs, color=MU, lw=1.8, ls="--", label="reports received")
ax.plot(xs, [p["incidents"] for p in dd], color=C["teal"], lw=3, label="incidents the control room sees")
ax.fill_between(xs, [p["incidents"] for p in dd], xs, color=C["teal"], alpha=.14, label="merged away as duplicates")
last = dd[-1]; ax.annotate(f"{last['reports']} reports\n= {last['incidents']} incidents\n({round((1 - last['incidents'] / last['reports']) * 100)}% fewer to read)", (last["reports"], last["incidents"]), xytext=(-120, 38), textcoords="offset points", color=FG, fontsize=11, arrowprops=dict(arrowstyle="-", color=MU))
ax.set_xlabel("messages arriving (demo set, in order)"); ax.set_ylabel("count"); ax.set_title("Twenty cries for the same village are one rescue"); style(ax)
ax.legend(frameon=False, loc="upper left")
fig.tight_layout(); save(fig, "g-dedupe.png", "Demo messages are invented. Counts come from running them through the real extractor and clustering code.")

# 3 ---- overdue clock
ck = d["clock"]; m = [c["m"] for c in ck]
fig, ax = plt.subplots(figsize=(10, 4.6))
ax.axhspan(0.5, 1.5, color=C["amber"], alpha=.08); ax.axhspan(1.5, 2.5, color=C["red"], alpha=.08)
ax.step(m, [c["urgent"] + 0.06 for c in ck], where="post", color=C["red"], lw=3, label="urgent, no team assigned (score 75+)")
ax.step(m, [c["normal"] for c in ck], where="post", color=C["blue"], lw=3, label="normal, no team assigned")
ax.step(m, [c["silent"] - 0.06 for c in ck], where="post", color=C["violet"], lw=3, label="team assigned but silent")
ax.set_yticks([0, 1, 2]); ax.set_yticklabels(["on time", "warning", "OVERDUE (alert sent once)"]); ax.set_ylim(-.3, 2.4)
ax.set_xlabel("minutes since the incident started waiting"); ax.set_title("The overdue clock"); style(ax, "x")
ax.legend(frameon=False, loc="upper left", fontsize=9.5)
fig.tight_layout(); save(fig, "g-sla.png", "Starting thresholds to agree with each control room (shared/sla.ts), not official standards.")

# 4 ---- simulated gauges
fig, ax = plt.subplots(figsize=(10, 4.8))
pal = [C["blue"], C["teal"], C["amber"], C["violet"], C["green"]]
for g, c in zip(d["gauges"], pal):
    h = [p["h"] for p in g["pts"]]; mg = [round(p["lvl"] - g["danger"], 2) for p in g["pts"]]
    ax.plot(h, mg, color=c, lw=2, label=g["name"])
ax.axhline(0, color=C["red"], lw=2.2); ax.text(47.8, .06, "danger mark", color=C["red"], ha="right", va="bottom", fontsize=10)
ax.axhspan(-0.5, 0, color=C["amber"], alpha=.1); ax.text(.3, -.43, "warning band", color=C["amber"], fontsize=9.5)
ax.set_xlabel("hours"); ax.set_ylabel("metres relative to danger mark"); ax.set_title("River gauges: SIMULATED readings, 48 h")
style(ax); ax.legend(frameon=False, ncol=3, fontsize=9, loc="lower right")
fig.tight_layout(); save(fig, "g-gauges.png", "Simulator output (shared/stations.ts), labelled `sim` in the app. Real levels need an official feed.")

# 5 ---- tests
by = collections.Counter(); area = collections.Counter()
names = {"shared.test.ts": "core logic", "gov.test.ts": "roles, SLA, feeds, WhatsApp, offline", "pipeline.test.ts": "Lambda pipeline on a fake AWS", "stack.test.ts": "infrastructure guarantees", "kit.test.ts": "accuracy kit and feed adapter", "filter.test.ts": "dashboard and phone helpers", "csv.test.ts": "dashboard and phone helpers", "queue.test.ts": "dashboard and phone helpers", "pingrule.test.ts": "dashboard and phone helpers", "mfa.test.ts": "dashboard and phone helpers", "properties.test.ts": "property tests (generated inputs)", "vocab.test.ts": "core logic", "villages-import.test.ts": "dashboard and phone helpers", "logic.test.ts": "dashboard and phone helpers"}
for f in t["files"]: by[names.get(f["file"], f["file"])] += len(f["tests"])
fig, ax = plt.subplots(figsize=(10, 4))
items = sorted(by.items(), key=lambda kv: kv[1]); cols = [C["green"], C["violet"], C["amber"], C["blue"], C["teal"], C["red"]][:len(items)]
bars = ax.barh([k for k, _ in items], [v for _, v in items], color=cols, height=.58)
for b, (_, v) in zip(bars, items): ax.text(v + .3, b.get_y() + b.get_height() / 2, str(v), va="center", fontsize=11)
ax.set_title(f"{t['passed']} of {t['total']} automated tests pass"); ax.set_xlabel("tests"); style(ax, "x"); ax.set_xlim(0, max(by.values()) + 4)
fig.tight_layout(); save(fig, "g-tests.png", "From `npx vitest run`. Tests run against fakes, not against live AWS.")
print("graphs done")
