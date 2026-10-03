const $ = (s) => document.querySelector(s),
  app = $("#app");
const api = (u, o) =>
  fetch(
    u,
    o && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o),
    },
  ).then(async (r) => {
    const d = await r.json();
    if (!r.ok) {
      d && typeof d === "object" && (d.status = r.status);
      throw d;
    }
    return d;
  });
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const GM = [
  "Kraków",
  "Wieliczka",
  "Zielonki",
  "Skawina",
  "Nowy Sącz",
  "Tarnów",
  "Zakopane",
  "Gorlice",
];
let timer;
// sesja: role pochodzi z serwera (/api/login, /api/me), nie juz z localStorage
const NAV = {
  "": ["obywatel"],
  projekty: ["obywatel"],
  projekt: ["urzednik"],
  panel: ["urzednik"],
};
let role = "",
  login = "";
const gate = (r) =>
  r == "fake" || r == "wybor" || r == "p"
    ? true
    : !role
      ? false
      : r == ""
        ? role == "obywatel"
        : !NAV[r] || NAV[r].includes(role);
function navRender(r) {
  document.querySelectorAll("header [data-role]").forEach((a) => {
    const n = a.dataset.role;
    a.style.display = role && (n == "any" || n == role) ? "" : "none";
    a.dataset.r === r
      ? a.setAttribute("aria-current", "page")
      : a.removeAttribute("aria-current");
  });
  //$("#whoami").textContent = login ? "Zalogowany: " + login : "";
}
function go(h) {
  if (location.hash === h) route();
  else location.hash = h;
}
// linki w menu: href do JUZ aktualnego hasha nie wyzwala hashchange, wiec nawigujemy recznie
document.querySelectorAll("header [data-r]").forEach((a) => {
  const h = a.getAttribute("href");
  a.onclick = (e) => {
    e.preventDefault();
    if (a.dataset.act === "logout") {
      api("api/logout", {}).catch(() => {});
      login = "";
      role = "";
      return go("#wybor");
    }
    go(h == null || h == "#" ? "" : h);
  };
});

// ---- menu WCAG: rozmiar czcionki, wysoki kontrast, wylaczone animacje (zapis w localStorage) ----
const A11Y = { fs: 100, hc: false, anim: false };
try {
  Object.assign(A11Y, JSON.parse(localStorage.getItem("hub_a11y") || "{}"));
} catch (e) {}
function a11yApply() {
  document.documentElement.style.fontSize = A11Y.fs == 100 ? "" : A11Y.fs + "%";
  document.documentElement.classList.toggle("hc", !!A11Y.hc);
  document.documentElement.classList.toggle("noanim", !!A11Y.anim);
  [
    ["#fs90", 90],
    ["#fs100", 100],
    ["#fs115", 115],
  ].forEach(([s, v]) =>
    $(s).setAttribute("aria-pressed", String(A11Y.fs == v)),
  );
  $("#hcBtn").setAttribute("aria-pressed", String(!!A11Y.hc));
  $("#animBtn").setAttribute("aria-pressed", String(!!A11Y.anim));
  localStorage.setItem("hub_a11y", JSON.stringify(A11Y));
}
$("#a11yBtn").onclick = () => {
  const p = $("#a11yPanel"),
    open = p.hidden;
  p.hidden = !open;
  $("#a11yBtn").setAttribute("aria-expanded", String(open));
};
[
  ["#fs90", 90],
  ["#fs100", 100],
  ["#fs115", 115],
].forEach(
  ([s, v]) =>
    ($(s).onclick = () => {
      A11Y.fs = v;
      a11yApply();
    }),
);
$("#hcBtn").onclick = () => {
  A11Y.hc = !A11Y.hc;
  a11yApply();
};
$("#animBtn").onclick = () => {
  A11Y.anim = !A11Y.anim;
  a11yApply();
};
$("#resetBtn").onclick = () => {
  A11Y.fs = 100;
  A11Y.hc = false;
  A11Y.anim = false;
  a11yApply();
};
a11yApply();
const tags = (a) => a.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
const bar = (v, t) =>
  `<div class="bar" role="progressbar" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="${t}" aria-label="Zebrane głosy"><i style="width:${Math.min(100, (v / t) * 100)}%"></i></div><p class="mut">${v} z ${t} głosów potrzebnych, by urzędnik dostał zgłoszenie.</p>`;
// glosowanie przy kafelku projektu (uzywane i w wynikach, i w katalogu)
const voteCard = (m) =>
  `${bar(m.votes, m.threshold)}<div id="vb${m.id}"></div><button id="v${m.id}">Głosuj na ten projekt</button>`;
function wireVote(m, getGmina) {
  const b = $("#v" + m.id);
  if (!b) return;
  b.onclick = async () => {
    clearInterval(timer);
    b.disabled = true;
    try {
      const s = await api("api/vote/session", {
        project_id: m.id,
        gmina: getGmina(),
      });
      $("#vb" + m.id).innerHTML =
        `<div class="card pop"><h3>Potwierdź, że jesteś mieszkańcem</h3><p>Zeskanuj kod telefonem – otworzy się mObywatel. Jeden głos na projekt.</p>
    <div class="qr"><img src="api/vote/qr/${s.session_id}" alt="Kod QR do weryfikacji w mObywatelu"></div></div>`;
      timer = setInterval(async () => {
        const st = await api("api/vote/status/" + s.session_id);
        if (!st.result) return;
        clearInterval(timer);
        $("#vb" + m.id).innerHTML =
          st.result == "ok"
            ? `<div class="card ok pop"><h3>Dziękujemy, Twój głos zliczony</h3>${bar(st.votes, st.threshold)}</div>`
            : `<div class="card err" role="alert"><h3>Ta osoba już zagłosowała</h3><p>Jeden głos na osobę na projekt.</p></div>`;
      }, 1500);
    } catch (e) {
      b.disabled = false;
      $("#vb" + m.id).innerHTML =
        `<div class="card err" role="alert"><p>Nie udało się rozpocząć głosowania. Odśwież stronę i zaloguj się ponownie.</p></div>`;
    }
  };
}

function home() {
  app.innerHTML = `<h1>Opisz swój problem. Sprawdzimy, czy ktoś już go rozwiązał.</h1>
<p class="mut">Napisz własnymi słowami, np. „sąsiadka jest sama i nie ma jak dojechać do lekarza”. Nie podawaj danych osobowych.</p>
<form id="f"><label for="t">Twój problem</label><textarea id="t" required minlength="10"></textarea>
<label for="g">Twoja gmina</label><select id="g">${GM.map((g) => `<option>${g}</option>`)}</select>
<button>Znajdź rozwiązania</button></form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    app.insertAdjacentHTML("beforeend", "<p>Szukam…</p>");
    const gmina = $("#g").value,
      text = $("#t").value; // odczyt przed ewentualna podmiana DOM
    try {
      const r = await api("api/match", { text, gmina });
      results(r, gmina);
    } catch (err) {
      app.insertAdjacentHTML(
        "beforeend",
        `<div class="card err" role="alert"><p>${esc((err && err.detail) || "Nie udało się wyszukać rozwiązań. Odśwież stronę i spróbuj ponownie.")}</p></div>`,
      );
    }
  };
}

function results(r, gmina) {
  const sim =
    r.similar && r.similar.length
      ? `<section class="card"><h2 style="margin-top:0">Podobne zgłoszenia mieszkańców</h2>
 <p class="mut">Inni zgłaszali podobny problem – razem tworzycie jeden temat dla urzędu:</p>
 <ul>${r.similar.map((s) => `<li>${esc(s.text)} <span class="mut">(${esc(s.gmina)})</span></li>`).join("")}</ul></section>`
      : "";
  const list = r.nothing
    ? `<div class="card"><h2 style="margin-top:0">Nie mamy jeszcze takiego rozwiązania</h2><p>Twoje zgłoszenie zapisaliśmy. Im więcej osób zagłosuje, tym szybciej zajmie się nim urząd.</p><a class="btn alt" href="#projekty">Zobacz wszystkie projekty</a></div>`
    : r.matches
        .map(
          (
            m,
          ) => `<article class="card"><span class="score">${m.score}% zgodności</span><h3>${esc(m.title)}</h3><p>${esc(m.summary)}</p>${tags(m.categories)}<p class="mut">${esc(m.hackathon)} · ${esc(m.authors)}</p>
 <p><a class="more" href="#p/${m.id}">Zobacz całość projektu →</a></p>${voteCard(m)}</article>`,
        )
        .join("");
  app.innerHTML = `<h1>${r.nothing ? "Brak gotowego rozwiązania" : "Znaleźliśmy pasujące rozwiązania"}</h1>
 <p class="mut">Twój problem zapisaliśmy. Poprzyj od razu pasujący projekt – głos oddasz tu, obok niego.</p>${sim}${list}`;
  r.matches.forEach((m) => wireVote(m, () => gmina));
}

async function projekty() {
  const d = await api("api/catalog");
  app.innerHTML =
    `<h1>Wybierz projekt, na który chcesz głosować</h1>
 <p class="mut">Jedna osoba – jeden głos na projekt. Głos potwierdzasz w aplikacji mObywatel (w demo – atrapa).</p>
 <label for="g">Twoja gmina</label><select id="g">${GM.map((g) => `<option>${g}</option>`)}</select>` +
    (d.length
      ? d
          .map(
            (
              p,
            ) => `<article class="card"><span class="score">${p.votes} głosów</span><h3>${esc(p.title)}</h3>
  <p>${esc(p.summary)}</p>${tags(p.categories)}<p class="mut">${esc(p.hackathon)} · ${esc(p.authors)}</p>
  <p><a class="more" href="#p/${p.id}">Zobacz całość projektu →</a></p>
  ${voteCard(p)}</article>`,
          )
          .join("")
      : '<div class="card"><p>Brak projektów w bazie.</p></div>');
  d.forEach((p) => wireVote(p, () => $("#g").value));
}

async function fake(sid) {
  app.innerHTML = `<h1>mObywatel</h1><div class="card pop"><h2>Ta strona prosi o informacje</h2>
 <p><b>Wspólnie – Hub Innowacji Społecznych</b> chce potwierdzić, że to naprawdę Ty, żeby przyjąć Twój głos.</p>
 <p>Otrzyma wyłącznie:</p>
 <ul><li>numer PESEL</li></ul>
 <p class="mut">Wersja demo – używane są wyłącznie fikcyjne numery PESEL, dane prawdziwych osób nie są przetwarzane.</p>
 <button id="consent">Potwierdź</button><button class="alt" id="deny">Anuluj</button></div>`;
  $("#consent").onclick = async () => {
    const p = await api("api/fake-people");
    app.innerHTML =
      `<h1>mObywatel</h1><h2>Potwierdź swoją osobowość</h2>
  <p>Tożsamość zweryfikowana. Wybierz osobę, którą chcesz się uwierzytelnić:</p>` +
      p
        .map(
          (n) =>
            `<button data-id="${esc(n)}" style="display:block;width:100%;text-align:left">${esc(n)}</button>`,
        )
        .join("");
    app.querySelectorAll("button").forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            await api("api/vote/confirm", {
              session_id: sid,
              person_id: b.dataset.id,
            });
            app.innerHTML =
              '<div class="card ok"><h2>Potwierdzono</h2><p>Możesz wrócić do strony z głosowaniem.</p></div>';
          } catch (e) {
            app.innerHTML =
              '<div class="card err" role="alert"><h2>Sesja nieważna</h2><p>Wygeneruj nowy kod QR.</p></div>';
          }
        }),
    );
  };
  $("#deny").onclick = () => {
    app.innerHTML = `<h1>mObywatel</h1><div class="card err" role="alert"><h2>Anulowano</h2>
 <p>Nie udostępniono żadnych danych. Wróć do strony z głosowaniem i zeskanuj kod ponownie, jeśli zmienisz zdanie.</p></div>`;
  };
}

function projekt() {
  app.innerHTML = `<h1>Zarządzaj projektami</h1><p class="mut">AI napisze krótkie streszczenie i nada kategorie, po których mieszkańcy znajdą projekt.</p>
<h2>Dodaj nowy projekt</h2><form id="f"><label for="a">Nazwa projektu</label><input id="a" required><label for="b">Opis</label><textarea id="b" required></textarea>
<label for="c">Hackathon</label><input id="c"><label for="d">Zespół (dane fikcyjne w prototypie)</label><input id="d">
<label for="e">Link do strony projektu (opcjonalnie)</label><input id="e" type="url" placeholder="https://…"><button>Dodaj do bazy</button></form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const p = {
      title: $("#a").value,
      description: $("#b").value,
      hackathon: $("#c").value,
      authors: $("#d").value,
      url: $("#e").value,
    }; // odczyt PRZED podmiana DOM
    app.innerHTML = `<h1>Zarządzaj projektami</h1><div class="card pop"><div class="spin" aria-hidden="true"></div>
 <h2>Dodajemy projekt…</h2><p class="mut">AI pisze streszczenie i dobiera kategorie. To chwilę potrwa – nie zamykaj strony.</p></div>`;
    try {
      const r = await api("api/projects", p);
      app.innerHTML = `<div class="card ok pop"><h2>Projekt dodany</h2><p>${esc(r.summary)}</p>${tags(r.categories)}</div><button id="back">Dodaj kolejny projekt</button>`;
      $("#back").onclick = () => go("#projekt");
    } catch (err) {
      app.innerHTML = `<div class="card err" role="alert"><h2>Nie udało się dodać projektu</h2><p>${esc((err && err.detail) || "Serwer odmówił lub nie odpowiada – zaloguj się kontem urzędnika i spróbuj ponownie.")}</p><button id="back" class="alt">Wróć do formularza</button></div>`;
      $("#back").onclick = () => go("#projekt");
    }
  };
}

async function panel() {
  let d;
  try {
    d = await api("api/admin");
  } catch (err) {
    app.innerHTML = `<div class="card err" role="alert"><h1>Brak dostępu do panelu</h1><p>${esc((err && err.detail) || "Zaloguj się kontem urzędnika.")}</p><a class="btn" href="#wybor">Zaloguj się</a></div>`;
    return;
  }
  app.innerHTML =
    `<h1>Panel urzędnika</h1><h2>Powiadomienia o inicjatywach</h2>` +
    (d.notifications.length
      ? d.notifications
          .map(
            (
              n,
            ) => `<article class="card"><h3>${esc(n.project)}</h3><p>Próg ${d.threshold} głosów osiągnięty.</p>
  <p>${esc(n.summary || "")}</p><p class="mut">Kontakt do twórców: ${esc(n.authors || "brak")} · zgłoszono ${esc(n.created)}</p>
  <p><a class="more" href="#p/${n.project_id}">Zobacz całość projektu →</a></p></article>`,
          )
          .join("")
      : "<p>Brak powiadomień. Progu nie osiągnął jeszcze żaden projekt.</p>") +
    `<h2>Projekty i głosy</h2><div class="tw" tabindex="0" role="region" aria-label="Tabela projektów – przewijana poziomo"><table><caption class="mut" style="text-align:left">Posortowane według liczby oddanych głosów</caption>
 <tr><th scope="col">Projekt</th><th scope="col">Streszczenie</th><th scope="col">Autorzy</th><th scope="col">Głosy</th><th scope="col">Status</th></tr>` +
    d.projects
      .map(
        (
          p,
        ) => `<tr><td><b><a href="#p/${p.id}">${esc(p.title)}</a></b><br>${tags(p.categories)}<br><span class="mut">${esc(p.hackathon)}</span></td>
  <td>${esc(p.summary)}</td><td>${esc(p.authors)}</td><td><b>${p.votes}</b> / ${d.threshold}</td><td>${esc(p.status)}</td></tr>`,
      )
      .join("") +
    `</table></div>`;
}

function wybor() {
  if (role) {
    const t = role == "urzednik" ? "#panel" : "";
    if (location.hash !== t) {
      location.hash = t;
      return;
    }
    return home();
  }
  app.innerHTML = `<h1>Zaloguj się</h1>
 <p class="mut">Wybierz konto demonstracyjne – rolę ustala konto, nie przycisk wejścia.</p>
 <form id="f"><label for="u">Login</label><input id="u" autocomplete="username" required>
 <label for="p">Hasło</label><input id="p" type="password" autocomplete="current-password" required>
 <button>Zaloguj się</button><p id="lerr" class="err-txt" role="alert"></p></form>
 <article class="card"><h2>Konta demo</h2>
 <p><b>obywatel / obywatel123</b> – mieszkaniec: opisz problem, zobacz dopasowania, głosuj.</p>
 <button id="b1">Wejdź jako mieszkaniec</button>
 <p><b>urzednik / urzednik123</b> – urzędnik: dodawaj projekty i zarządzaj głosami.</p>
 <button id="b2" class="alt">Wejdź jako urzędnik</button></article>`;
  $("#lerr").textContent = "";
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const u = await api("api/login", {
        login: $("#u").value,
        password: $("#p").value,
      });
      role = u.role;
      login = u.login;
      go(u.role == "urzednik" ? "#panel" : "");
    } catch (err) {
      $("#lerr").textContent =
        (err && err.detail) ||
        "Nie udało się zalogować. Sprawdź login i hasło.";
    }
  };
  const demo = (l, p) => async () => {
    try {
      const u = await api("api/login", { login: l, password: p });
      role = u.role;
      login = u.login;
      go(u.role == "urzednik" ? "#panel" : "");
    } catch (err) {
      $("#lerr").textContent = "Nie udało się zalogować na konto demo.";
    }
  };
  $("#b1").onclick = demo("obywatel", "obywatel123");
  $("#b2").onclick = demo("urzednik", "urzednik123");
}

async function pokazProjekt(id) {
  let d;
  try {
    d = await api("api/project/" + id);
  } catch (err) {
    app.innerHTML = `<div class="card err" role="alert"><h1>Nie znaleziono projektu</h1><p>Taki projekt nie istnieje albo został usunięty.</p></div>`;
    return;
  }
  app.innerHTML = `<h1>${esc(d.title)}</h1><p class="mut">${esc(d.hackathon)} · ${esc(d.authors)}</p>${tags(d.categories)}
 <article class="card"><h2>Pełny opis</h2><p style="white-space:pre-wrap">${esc(d.description)}</p>
 ${d.url && /^https?:/i.test(d.url) ? `<p><a href="${esc(d.url)}" target="_blank" rel="noopener">Strona projektu ↗</a></p>` : ""}</article>
 <article class="card"><h2>Głosowanie</h2>
 ${
   role
     ? `<label for="g">Twoja gmina</label><select id="g">${GM.map((g) => `<option>${g}</option>`)}</select>${voteCard(d)}`
     : `<p>Musisz być zalogowany, żeby głosować.</p><a class="btn" href="#wybor">Zaloguj się</a>`
 }
 <p><a class="btn alt" href="${role == "urzednik" ? "#panel" : "#projekty"}">Wróć</a></p></article>`;
  if (role) wireVote(d, () => $("#g").value);
}

function route() {
  clearInterval(timer);
  const h = location.hash.slice(1),
    [r, x] = h.split("/");
  navRender(r);
  if (!gate(r)) {
    const t =
      role == "urzednik" ? "#panel" : role == "obywatel" ? "" : "#wybor";
    if (location.hash !== t) {
      location.hash = t;
      return;
    }
    return wybor();
  }
  (r == "fake"
    ? () => fake(x)
    : r == "p"
      ? () => pokazProjekt(x)
      : { "": home, projekt, panel, projekty, wybor }[r] || home)();
  app.focus();
}
addEventListener("hashchange", route);
// pierwszy render: przywrocenie sesji z serwera (cookie), potem routing
api("api/me")
  .then((u) => {
    role = u.role || "";
    login = u.login || "";
  })
  .catch(() => {
    role = "";
    login = "";
  })
  .then(route);
