#!/usr/bin/env python3
# 只读探查 WorkBuddy 本地库,找混元端点/鉴权线索(不打印完整密钥)
import sqlite3, os, re, glob

home = os.path.expanduser("~")
db = os.path.join(home, ".workbuddy", "workbuddy.db")
print("DB:", db, "exists=", os.path.exists(db))

def redact(s):
    if not isinstance(s, str):
        s = str(s)
    # 保留前后少量字符,隐去中间(避免泄露完整密钥)
    def _r(m):
        v = m.group(0)
        return v[:6] + "…(" + str(len(v)) + "chars)…" + v[-4:] if len(v) > 20 else v
    return re.sub(r'[A-Za-z0-9_\-]{24,}', _r, s)

KEYWORDS = ["hunyuan", "混元", "tencent", "baseurl", "base_url", "endpoint",
            "https://", "authorization", "bearer", "secretid", "secretkey",
            "api_key", "apikey", "model", "provider"]

try:
    con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
    cur = con.cursor()
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    print("TABLES:", tables)
    for t in tables:
        try:
            cols = [c[1] for c in cur.execute(f"PRAGMA table_info('{t}')")]
        except Exception as e:
            continue
        # 找文本型列
        try:
            rows = cur.execute(f"SELECT * FROM '{t}' LIMIT 500").fetchall()
        except Exception:
            continue
        hits = []
        for row in rows:
            blob = " ".join(str(x) for x in row).lower()
            if any(k in blob for k in KEYWORDS):
                hits.append(row)
        if hits:
            print(f"\n=== TABLE {t} cols={cols} : {len(hits)} hit(s) ===")
            for h in hits[:8]:
                print(redact(str(h))[:600])
    con.close()
except Exception as e:
    print("DB ERR:", e)

# 附:connector-keys 文件内容结构(不打印完整值)
kd = os.path.join(home, ".workbuddy-key-fallback", "connector-keys")
if os.path.isdir(kd):
    for f in glob.glob(os.path.join(kd, "*")):
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
            print(f"\nKEYFILE {os.path.basename(f)} ({len(txt)} chars):", redact(txt)[:300])
        except Exception as e:
            print("keyfile err", e)
