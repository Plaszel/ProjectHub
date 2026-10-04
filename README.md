# ProjectHub – Hub Innowacji Społecznych Małopolski

## Opis projektu
**ProjectHub** to otwarta platforma internetowa, której celem jest łączenie mieszkańców Małopolski z istniejącymi projektami społecznymi oraz umożliwianie zgłaszania własnych problemów. Dzięki wykorzystaniu sztucznej inteligencji (modeli LLM i embeddingów) aplikacja dopasowuje zgłoszone problemy do najbliższych rozwiązań, a mieszkańcy mogą je wspierać głosowaniem. Urzędnicy mają wgląd w zgłoszone potrzeby, mogą dodawać nowe projekty i monitorować ich popularność.

## Problematyka
- **Izolacja seniorów** – brak kontaktu i wsparcia w małych miejscowościach.
- **Problemy zdrowia psychicznego** – ograniczony dostęp do specjalistycznej pomocy.
- **Samotność i wykluczenie cyfrowe** – osoby starsze i niepełnosprawne mają trudności z obsługą e‑urzędu i nowoczesnych technologii.
- **Brak transportu publicznego** – mieszkańcy wsiach nie mają możliwości dojazdu do lekarza czy urzędu.
- **Niedostępność usług społecznych** – brakuje centralnego katalogu dostępnych usług w gminach.
- **Integracja społeczna** – potrzeba tworzenia sieci wsparcia i działań wolontariackich.

Projekt ma na celu ułatwienie obywatelom zgłaszania takich problemów, szybkie wyszukiwanie istniejących rozwiązań oraz wypracowanie priorytetów poprzez głosowanie.

## Funkcjonalności
- **Zgłaszanie problemu** (formularz, wybór gminy).
- **Dopasowanie AI** – opis problemu jest analizowany przez model LLM, generowane są podsumowanie i kategorie, a następnie porównywany jest wektor embeddingu z istniejącymi projektami.
- **Głosowanie** – jeden głos na projekt po weryfikacji tożsamości w aplikacji mObywatel (w wersji demo – fikcyjne PESELE).
- **Panel urzędnika** – podgląd projektów, liczby głosów, powiadomienia o przekroczeniu progu głosów, możliwość dodawania nowych projektów.
- **Logowanie** – dwa konta demo: `obywatel/obywatel123` i `urzednik/urzednik123`.
- **Statyczny frontend** – HTML, CSS i czysty JavaScript (bez frameworków).
- **Baza danych** – SQLite, automatyczna inicjalizacja przy pierwszym uruchomieniu.

## Stos technologiczny (stack)
| Warstwa | Technologia |
|---------|-------------|
| **Backend** | Python 3.10+, FastAPI, Uvicorn, httpx, numpy, qrcode |
| **Baza danych** | SQLite (plik `hub.db`) |
| **Frontend** | HTML5, CSS3 (custom design), czysty JavaScript (ES6) |
| **Inne** | HMAC‑SHA256 (pseudonimizacja PESEL), PBKDF2‑SHA256 (hasła), środowisko konfiguracyjne `.env` |

## Instalacja i uruchomienie
### Wymagania wstępne
1. **Python ≥ 3.10** (zalecane 3.11).
2. **pip** – menedżer pakietów Pythona.
3. **Ollama** – lokalny serwer LLM/embeddingów. Instrukcje instalacji: https://ollama.com/download
4. (Opcjonalnie) **Git** – do pobrania kodu.

### Kroki instalacyjne
```bash
# 1. Sklonuj repozytorium (lub skopiuj folder) i przejdź do katalogu projektu
cd "C:\Users\Sebastian\Downloads\ProjectHub-main\ProjectHub-main"

# 2. Utwórz i aktywuj wirtualne środowisko (zalecane)
python -m venv venv
venv\Scripts\activate  # w PowerShell: .\venv\Scripts\Activate.ps1

# 3. Zainstaluj zależności
pip install -r requirements.txt
```

### Uruchomienie aplikacji
```bash
# W trybie deweloperskim (automatyczne przeładowanie nie jest wbudowane, ale można użyć watchdog)
python main.py
```
Domyślnie serwer startuje pod adresem `http://127.0.0.1:3000`. Można też użyć Uvicorn bezpośrednio:
```bash
uvicorn main:app --host 127.0.0.1 --port 3000
```

Po uruchomieniu otwórz przeglądarkę i przejdź pod podany adres. Zaloguj się przy pomocy jednego z kont demo:
- **obywatel / obywatel123** – rola obywatela (zgłasza problemy, głosuje).
- **urzednik / urzednik123** – rola urzędnika (zarządza projektami, przegląda głosy).

## Dodatkowe informacje
- **Baza danych** (`hub.db`) jest tworzona automatycznie w katalogu projektu przy pierwszym starcie. Wypełniona jest przykładowymi projektami (`SEED`).
- **Pseudonimizacja PESEL** – numer PESEL jest zamieniany na HMAC‑SHA256 przy użyciu tajnego klucza `VOTE_SECRET`. Dzięki temu nie jest przechowywany w czystej formie.
- **Tryb offline** – jeżeli Ollama nie jest dostępny, system używa prostego modelu opartego na trigramach znaków jako zamiennika.
- **Dostępność** – w kodzie zastosowano praktyki WCAG (np. wysoki kontrast, możliwość zmiany rozmiaru czcionki, wyłączanie animacji).

