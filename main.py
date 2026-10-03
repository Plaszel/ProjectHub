import secrets, zlib, os, json, sqlite3, hmac, hashlib, uuid, re
import httpx, numpy as np, qrcode, qrcode.image.svg, io
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os

BIELIK_API_KEY = os.getenv("BIELIK_API_KEY")
BIELIK_API_URL = os.getenv("BIELIK_API_URL")

# ---------- konfiguracja z jednego pliku hub.env (obok main.py) ----------
BASE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE, "hub.env")

def load_env():
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip(): os.environ.setdefault(k.strip(), v.strip())  # zmienne systemowe maja pierwszenstwo
    if not os.environ.get("VOTE_SECRET"):  # pierwszy start: wygeneruj klucz i zapisz do hub.env
        sec = secrets.token_hex(32); os.environ["VOTE_SECRET"] = sec
        with open(ENV_FILE, "a", encoding="utf-8") as f: f.write(f"\nVOTE_SECRET={sec}\n")
        os.chmod(ENV_FILE, 0o600)
load_env()

OLLAMA = os.getenv("OLLAMA_URL", "https://ollama.com")  # Ollama Cloud; lokalny daemon: http://localhost:11434
OLLAMA_KEY = os.getenv("OLLAMA_API_KEY", "").strip()     # klucz z https://ollama.com/settings/keys
EMB_URL = os.getenv("EMB_URL", OLLAMA)                   # host embeddingow (mozna wskazac lokalny daemon)
LLM = os.getenv("LLM_MODEL", "gpt-oss:120b")             # model z Ollama Cloud
EMB = os.getenv("EMB_MODEL", "bge-m3")

def ollama_headers():
    """Naglowek autoryzacji do Ollama Cloud; lokalny daemon go ignoruje."""
    return {"Authorization": f"Bearer {OLLAMA_KEY}"} if OLLAMA_KEY else {}
SECRET = os.getenv("VOTE_SECRET", "dev-secret-change-me").encode()
THRESHOLD = int(os.getenv("VOTE_THRESHOLD", "3"))  # prog zweryfikowanych glosow
MATCH_MIN, CLUSTER_MIN = 0.35, 0.60
CATS = ["seniorzy", "zdrowie psychiczne", "samotność", "wykluczenie cyfrowe",
        "dostępność usług", "integracja społeczna", "osoby z niepełnosprawnościami", "młodzież"]
# Testowe numery PESEL (poprawna suma kontrolna, ale fikcyjne). Prawdziwe dostaje się z mObywatela.
FAKE_PEOPLE = {'Anna Testowa': '02210100015', 'Jan Przykładowy': '02210100022', 'Ewa Fikcyjna': '02210100039', 'Piotr Demonstracyjny': '02210100046'}
DB = os.path.join(BASE, "hub.db")
@asynccontextmanager
async def lifespan(_):
    startup(); yield

app = FastAPI(title="Hub Innowacji Społecznych", root_path=os.getenv("ROOT_PATH", ""), lifespan=lifespan)

def valid_pesel(p):
    return bool(re.fullmatch(r"\d{11}", p)) and (10 - sum(int(c) * w for c, w in zip(p, [1,3,7,9,1,3,7,9,1,3])) % 10) % 10 == int(p[10])

def pseudonymize(pesel):
    """PESEL -> HMAC-SHA256 z tajnym kluczem. PESEL nie jest nigdzie zapisywany ani logowany."""
    pesel = pesel.strip()
    if not valid_pesel(pesel): raise HTTPException(400, "Niepoprawny numer PESEL")
    return hmac.new(SECRET, pesel.encode(), hashlib.sha256).hexdigest()

def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, title, description, summary, categories, embedding, hackathon, authors, url DEFAULT '');
    CREATE TABLE IF NOT EXISTS clusters(id INTEGER PRIMARY KEY, title, embedding, status DEFAULT 'nowy');
    CREATE TABLE IF NOT EXISTS problems(id INTEGER PRIMARY KEY, text, cluster_id, gmina);
    CREATE TABLE IF NOT EXISTS votes(pseudonym, project_id, gmina, UNIQUE(pseudonym, project_id));
    CREATE TABLE IF NOT EXISTS sessions(id PRIMARY KEY, project_id, gmina, url, result);
    CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, project_id, created DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, login UNIQUE, salt, phash, role);
    CREATE TABLE IF NOT EXISTS auth_sessions(sid PRIMARY KEY, login, created DEFAULT CURRENT_TIMESTAMP);
    """)
    if "url" not in [r[1] for r in c.execute("PRAGMA table_info(projects)")]:  # migracja starszych baz
        c.execute("ALTER TABLE projects ADD COLUMN url DEFAULT ''")
    c.commit(); c.close()

# ---------- konta i sesje logowania ----------
def hash_pw(pw, salt):
    """PBKDF2-SHA256, 200 tys. iteracji - hasla nigdy nie leza w bazie w formie jawnej."""
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200000).hex()

def seed_users():
    """Dwa konta demo: mieszkaniec i urzednik (tworzone przy pierwszym starcie)."""
    for lg, pw, role in [("obywatel", "obywatel123", "obywatel"), ("urzednik", "urzednik123", "urzednik")]:
        c = db()
        if not c.execute("SELECT 1 FROM users WHERE login=?", (lg,)).fetchone():
            salt = secrets.token_hex(16)
            c.execute("INSERT INTO users(login,salt,phash,role) VALUES(?,?,?,?)", (lg, salt, hash_pw(pw, salt), role))
        c.commit(); c.close()

def session_user(req):
    """Aktualny uzytkownik z cookie sesji albo None (niezalogowany)."""
    sid = req.cookies.get("hub_sid")
    if not sid: return None
    c = db()
    r = c.execute("SELECT u.login, u.role FROM auth_sessions s JOIN users u ON u.login=s.login WHERE s.sid=?", (sid,)).fetchone()
    c.close(); return dict(r) if r else None

def need(req, role=None):
    """Wymaga zalogowania; jesli podano role - tez trafnego konta."""
    u = session_user(req)
    if not u: raise HTTPException(401, "Wymagane logowanie")
    if role and u["role"] != role: raise HTTPException(403, "To konto nie ma dostepu do tej czesci systemu")
    return u

# ---------- AI (Ollama, z awaryjnym trybem offline) ----------
def embed(text):
    try:
        r = httpx.post(f"{EMB_URL}/api/embed", json={"model": EMB, "input": text},
                       headers=ollama_headers(), timeout=30)
        r.raise_for_status()
        return r.json()["embeddings"][0]
    except Exception:  # tryb awaryjny: trigramy znakow (demo bez Ollamy)
        v = np.zeros(256); t = re.sub(r"\W+", " ", text.lower())
        for i in range(len(t) - 2): v[zlib.crc32(t[i:i+3].encode()) % 256] += 1
        return v.tolist()

def cos(a, b):
    a, b = np.array(a), np.array(b)
    if a.shape != b.shape or not a.any() or not b.any(): return 0.0
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))

def enrich(title, desc):
    prompt = (f"Projekt: {title}\n{desc}\n\nZwróć JSON: {{\"summary\": \"2 zdania po polsku\", "
              f"\"categories\": [1-3 wartości WYŁĄCZNIE z listy {CATS}]}}. Nie wymyślaj faktów.")
    try:
        r = httpx.post(f"{OLLAMA}/api/chat", json={"model": LLM, "stream": False, "format": "json",
                       "messages": [{"role": "user", "content": prompt}]},
                       headers=ollama_headers(), timeout=120)
        r.raise_for_status()
        d = json.loads(r.json()["message"]["content"])
        cats = [c for c in d.get("categories", []) if c in CATS][:3]
        if d.get("summary") and cats: return d["summary"], cats
    except Exception: pass
    cats = [c for c in CATS if any(w[:5] in (title + desc).lower() for w in c.split())] or ["integracja społeczna"]
    return desc.split(". ")[0][:200], cats[:3]

def add_project(title, desc, hackathon, authors, url=""):
    summary, cats = enrich(title, desc)
    emb = embed(f"{title}. {desc}")
    c = db()
    cur = c.execute("INSERT INTO projects(title,description,summary,categories,embedding,hackathon,authors,url) VALUES(?,?,?,?,?,?,?,?)",
                    (title, desc, summary, json.dumps(cats, ensure_ascii=False), json.dumps(emb), hackathon, authors, url.strip()))
    c.commit(); c.close()
    return {"id": cur.lastrowid, "summary": summary, "categories": cats}

def top_projects(emb, n=4, min_score=MATCH_MIN):
    c = db(); rows = c.execute("SELECT * FROM projects").fetchall()
    sc = sorted(((cos(emb, json.loads(r["embedding"])), r) for r in rows), key=lambda x: -x[0])
    out = [{"id": r["id"], "title": r["title"], "summary": r["summary"], "categories": json.loads(r["categories"]),
            "hackathon": r["hackathon"], "authors": r["authors"], "score": round(s * 100),
            "votes": votes_of(c, r["id"]), "threshold": THRESHOLD}
           for s, r in sc[:n] if s >= min_score]
    c.close(); return out

def votes_of(c, pid): return c.execute("SELECT COUNT(*) FROM votes WHERE project_id=?", (pid,)).fetchone()[0]

def project_row(r, c, with_status=True):
    """Projekt + liczba glosow (wiersz katalogu i panelu urzednika)."""
    v = votes_of(c, r["id"])
    d = {"id": r["id"], "title": r["title"], "summary": r["summary"],
         "categories": json.loads(r["categories"]), "hackathon": r["hackathon"],
         "authors": r["authors"], "votes": v, "threshold": THRESHOLD, "url": r["url"] or ""}
    if with_status: d["status"] = "próg osiągnięty" if v >= THRESHOLD else "zbieranie głosów"
    return d

# ---------- API ----------
class ProblemIn(BaseModel): text: str; gmina: str
class ProjectIn(BaseModel): title: str; description: str; hackathon: str = ""; authors: str = ""; url: str = ""
class SessionIn(BaseModel): project_id: int; gmina: str
class ConfirmIn(BaseModel): session_id: str; person_id: str
class LoginIn(BaseModel): login: str; password: str

# ---------- logowanie (dwa konta demo: obywatel / urzednik) ----------
@app.post("/api/login")
def login(b: LoginIn, resp: Response):
    c = db(); u = c.execute("SELECT * FROM users WHERE login=?", (b.login.strip(),)).fetchone(); c.close()
    if not u or not hmac.compare_digest(u["phash"] or "", hash_pw(b.password, u["salt"] or "")):
        raise HTTPException(401, "Nieprawidłowy login lub hasło")
    sid = secrets.token_urlsafe(32)
    c = db(); c.execute("INSERT INTO auth_sessions(sid,login) VALUES(?,?)", (sid, u["login"])); c.commit(); c.close()
    resp.set_cookie("hub_sid", sid, httponly=True, samesite="lax", max_age=30*86400, path="/")
    return {"login": u["login"], "role": u["role"]}

@app.post("/api/logout")
def logout(req: Request, resp: Response):
    sid = req.cookies.get("hub_sid")
    if sid:
        c = db(); c.execute("DELETE FROM auth_sessions WHERE sid=?", (sid,)); c.commit(); c.close()
    resp.delete_cookie("hub_sid", path="/")
    return {"ok": True}

@app.get("/api/me")
def me(req: Request):
    u = session_user(req)
    return u or {"login": None, "role": None}

@app.post("/api/projects")
def new_project(p: ProjectIn, req: Request):
    need(req, "urzednik")  # dodawanie projektow tylko z konta urzednika
    return add_project(p.title, p.description, p.hackathon, p.authors, p.url)

@app.post("/api/match")
def match(p: ProblemIn, req: Request):
    need(req)  # zgloszenie problemu wymaga zalogowania (konto obywatela)
    emb = embed(p.text); c = db()
    best, best_s = None, 0
    for r in c.execute("SELECT * FROM clusters").fetchall():
        s = cos(emb, json.loads(r["embedding"]))
        if s > best_s: best, best_s = r["id"], s
    if best is None or best_s < CLUSTER_MIN:  # nowy klaster problemow
        best = c.execute("INSERT INTO clusters(title,embedding) VALUES(?,?)", (p.text[:90], json.dumps(emb))).lastrowid
    pid = c.execute("INSERT INTO problems(text,cluster_id,gmina) VALUES(?,?,?)", (p.text, best, p.gmina)).lastrowid
    c.commit()
    # podobne przypadki: INNE zgloszenia z tego klastra (bez wlasnego) - modul matchmakingu
    similar = [{"text": r["text"], "gmina": r["gmina"]} for r in
               c.execute("SELECT text, gmina FROM problems WHERE cluster_id=? AND id<>? ORDER BY id DESC LIMIT 3", (best, pid)).fetchall()]
    c.close()
    m = top_projects(emb)
    return {"cluster_id": best, "matches": m, "similar": similar, "nothing": not m}

@app.get("/api/catalog")  # katalog projektow do glosowania (publiczny, bez basic-auth z nginx)
def catalog():
    c = db(); rows = c.execute("SELECT * FROM projects ORDER BY id").fetchall()
    out = [project_row(r, c) for r in rows]; c.close(); return out

@app.post("/api/vote/session")
def vote_session(s: SessionIn, req: Request):
    need(req)  # sesje glosu tworzy tylko zalogowany mieszkaniec (telefon potwierdza przez QR bez logowania)
    c = db()
    if not c.execute("SELECT 1 FROM projects WHERE id=?", (s.project_id,)).fetchone():
        c.close(); raise HTTPException(404, "Nie ma takiego projektu")
    sid = uuid.uuid4().hex[:10]
    c.execute("INSERT INTO sessions VALUES(?,?,?,?,NULL)", (sid, s.project_id, s.gmina, str(req.base_url) + "#fake/" + sid))
    c.commit(); c.close(); return {"session_id": sid}

@app.get("/api/vote/qr/{sid}")
def qr(sid: str):
    c = db(); s = c.execute("SELECT url FROM sessions WHERE id=?", (sid,)).fetchone(); c.close()
    if not s: raise HTTPException(404)
    buf = io.BytesIO(); qrcode.make(s["url"], image_factory=qrcode.image.svg.SvgPathImage).save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")

@app.get("/api/fake-people")
def people(): return list(FAKE_PEOPLE)  # tylko imiona; PESEL zostaje po stronie serwera

@app.post("/api/vote/confirm")  # atrapa odpowiedzi mObywatela
def confirm(b: ConfirmIn):
    c = db(); s = c.execute("SELECT * FROM sessions WHERE id=?", (b.session_id,)).fetchone()
    if not s or s["result"]: raise HTTPException(400, "Sesja nieważna")
    if b.person_id not in FAKE_PEOPLE: raise HTTPException(400, "Nieznana osoba")
    pseudo = pseudonymize(FAKE_PEOPLE[b.person_id])  # w bazie tylko pseudonim
    try:
        c.execute("INSERT INTO votes VALUES(?,?,?)", (pseudo, s["project_id"], s["gmina"])); res = "ok"
    except sqlite3.IntegrityError: res = "duplicate"
    c.execute("UPDATE sessions SET result=? WHERE id=?", (res, b.session_id))
    pid = s["project_id"]  # prog glosow -> powiadomienie urzednika o projekcie
    if votes_of(c, pid) >= THRESHOLD and not c.execute("SELECT 1 FROM notifications WHERE project_id=?", (pid,)).fetchone():
        c.execute("INSERT INTO notifications(project_id) VALUES(?)", (pid,))
    c.commit(); c.close(); return {"result": res}

@app.get("/api/vote/status/{sid}")
def status(sid: str):
    c = db(); s = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if not s: raise HTTPException(404)
    out = {"result": s["result"], "votes": votes_of(c, s["project_id"]), "threshold": THRESHOLD}; c.close(); return out

@app.get("/api/project/{pid}")  # pelny opis projektu (widok "zobacz calosc")
def project_detail(pid: int):
    c = db(); r = c.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not r: c.close(); raise HTTPException(404, "Nie ma takiego projektu")
    d = project_row(r, c); c.close()
    d["description"] = r["description"]
    return d

@app.get("/api/admin")
def admin(req: Request):
    need(req, "urzednik")  # panel tylko z konta urzednika
    c = db()
    pr = [project_row(r, c) for r in c.execute("SELECT * FROM projects ORDER BY id").fetchall()]
    pr.sort(key=lambda x: -x["votes"])
    nt = [dict(n) for n in c.execute("""SELECT n.created, p.id project_id, p.title project, p.authors, p.summary
        FROM notifications n JOIN projects p ON p.id=n.project_id ORDER BY n.id DESC""")]
    c.close(); return {"projects": pr, "notifications": nt, "threshold": THRESHOLD}

SEED = [("Telefon zaufania dla seniorów", "Wolontariusze dzwonią regularnie do samotnych osób starszych, rozmawiają i sprawdzają, czy ktoś potrzebuje pomocy. Rozwiązanie działa w gminach wiejskich.", "HackYeah 2025", "Zespół Fikcyjny A"),
        ("Cyfrowy dyżur w bibliotece", "Młodzi wolontariusze uczą seniorów obsługi smartfona i e-urzędu podczas cotygodniowych dyżurów w bibliotece.", "HackYeah 2025", "Zespół Fikcyjny B"),
        ("Mapa dostępnych usług społecznych", "Aplikacja pokazuje na mapie najbliższe punkty pomocy i godziny ich otwarcia, także w gminach bez Centrum Usług Społecznych.", "HackYeah 2024", "Zespół Fikcyjny C"),
        ("Sąsiedzka grupa wsparcia psychicznego", "Przeszkoleni rówieśnicy prowadzą spotkania wsparcia dla osób z kryzysem zdrowia psychicznego, bez kolejek do specjalisty.", "Hackathon Społeczny", "Zespół Fikcyjny D"),
        ("Bezpłatny transport na wizyty lekarskie", "Sąsiedzi i wolontariusze wożą osoby z niepełnosprawnościami i seniorów na wizyty lekarskie w miejscowościach bez komunikacji.", "Hackathon Społeczny", "Zespół Fikcyjny E"),
        ("Klub młodzieżowy po lekcjach", "Bezpłatne zajęcia i mentoring dla nastolatków z mniejszych miejscowości, wspierające integrację i zdrowie psychiczne.", "HackYeah 2024", "Zespół Fikcyjny F")]

def startup():
    init(); seed_users(); c = db(); n = c.execute("SELECT COUNT(*) FROM projects").fetchone()[0]; c.close()
    if n == 0:
        for s in SEED: add_project(*s)

@app.get("/")
def index(): return FileResponse(os.path.join(BASE, "static", "index.html"))

if __name__ == "__main__":  # python main.py
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=3000, proxy_headers=True, forwarded_allow_ips="127.0.0.1")
