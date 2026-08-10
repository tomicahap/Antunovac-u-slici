# Antunovac u slici – Aplikacija za arhivske fotografije

Web aplikacija za obradu arhivskih i obiteljskih fotografija s ručnim označavanjem lica i Google Drive sinkronizacijom. Namijenjena rodoslovnom istraživanju.

## Tehnološki stack

- **Backend**: Node.js + Express (proxy za Google OAuth i Drive API)
- **Frontend**: Vanilla JS SPA, Canvas API
- **Baza podataka**: Firebase Firestore (cloud) + LocalStorage (offline cache)
- **Hosting**: Render (besplatni tier)

---

## Preduvjeti

- Node.js 18+
- Google Cloud projekt s OAuth 2.0 klijentom
- Firebase projekt s Firestore bazom

---

## 1. Google Cloud OAuth 2.0 postavljanje

1. Idite na [Google Cloud Console](https://console.cloud.google.com/)
2. Kreirajte novi projekt ili odaberite postojeći
3. Idite na **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Tip aplikacije: **Web application**
5. Dodajte **Authorized redirect URIs**:
   - Za lokalni razvoj: `http://localhost:3000/api/auth/callback`
   - Za Render: `https://vase-ime.onrender.com/api/auth/callback`
6. Uključite **Google Drive API**:
   - **APIs & Services → Library → Google Drive API → Enable**
7. Preuzmite `credentials.json` i kopirajte `client_id` i `client_secret`

**Potrebni OAuth scope-ovi** (automatski se traže pri prijavi):
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/userinfo.email`

---

## 2. Firebase Firestore postavljanje

1. Idite na [Firebase Console](https://console.firebase.google.com/)
2. Kreirajte novi projekt
3. **Build → Firestore Database → Create database**
   - Odaberite **Production mode**
4. **Project Settings → General** – kopirajte Firebase konfiguraciju
5. Postavite **Firestore Security Rules** (u Firebase konzoli):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Jednokorisničko - dozvoli samo autentificirani pristup
    // (Ova aplikacija ne koristi Firebase Auth, pa privremeno otvorimo za testiranje)
    match /{document=**} {
      allow read, write: if true; // Zamijenite s restriktivnijim pravilima u produkciji
    }
  }
}
```

> **Napomena za produkciju**: Zamijenite `allow read, write: if true` s pravilima koja ograničavaju pristup na vaš IP ili koristite Firebase App Check.

---

## 3. Lokalno pokretanje

```bash
# 1. Instalirajte ovisnosti
npm install

# 2. Kopirajte .env.example u .env i popunite vrijednosti
cp .env.example .env

# 3. Generirajte SESSION_SECRET i ENCRYPTION_KEY
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# 4. Pokrenite server
npm start
# ili za razvoj s auto-restartom:
npm run dev

# 5. Otvorite http://localhost:3000
```

---

## 4. Environment varijable (.env)

```env
# Google OAuth 2.0 (OBAVEZNO)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback

# Session sigurnost (OBAVEZNO – generirajte nasumično!)
SESSION_SECRET=min-32-znakova-nasumicni-niz
ENCRYPTION_KEY=64-hex-znakova-za-aes256

# Firebase (sve iz Project Settings)
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=vas-projekt.firebaseapp.com
FIREBASE_PROJECT_ID=vas-projekt-id
FIREBASE_STORAGE_BUCKET=vas-projekt.appspot.com
FIREBASE_MESSAGING_SENDER_ID=...
FIREBASE_APP_ID=...

# Server
PORT=3000
NODE_ENV=production
```

---

## 5. Deployment na Render (besplatno)

1. Gurnite kod na GitHub/GitLab repozitorij
2. Idite na [render.com](https://render.com) i kreirajte novi **Web Service**
3. Povežite repozitorij
4. Konfiguracija:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Dodajte sve Environment varijable iz gornje liste
6. Ažurirajte `GOOGLE_REDIRECT_URI` na: `https://vase-ime.onrender.com/api/auth/callback`
7. Dodajte isti URI u Google Cloud Console (Authorized redirect URIs)

> **Napomena**: Render besplatni tier "uspavljuje" aplikaciju nakon 15 minuta neaktivnosti. Prvo učitavanje može trajati ~30 sekundi.

---

## 6. Korištenje aplikacije

### Početno postavljanje
1. Idite na **Postavke**
2. Kliknite **"Poveži Google Drive"** i prijavite se
3. Odaberite **Ulaznu mapu** (gdje su originalne fotografije)
4. Odaberite **Izlaznu mapu** (gdje će se spremati obrađene slike)
5. Opcionalno: promijenite naziv podmape za portrete

### Označavanje fotografija
1. Idite na **Galerija** i kliknite fotografiju
2. Odaberite način **"Označi"** (ili pritisnite `D`)
3. Nacrtajte pravokutni okvir oko lica
4. Unesite podatke o osobi (autocomplete predlaže već unešene osobe)
5. Kliknite **"Spremi oznaku"**
6. Ponovite za sva lica na fotografiji
7. Kliknite **"Spremi"** (ili `Ctrl+S`) za upload na Google Drive

### Tipkovnički prečaci
| Tipka | Akcija |
|-------|--------|
| `Ctrl+S` | Spremi sliku i portrete na Drive |
| `Delete` | Obriši odabranu oznaku |
| `Esc` | Zatvori formu / odustani |
| `D` | Način označavanja |
| `P` | Način pomicanja |
| `F` | Prilagodi sliku ekranu |
| `+` / `-` | Zoom in/out |
| `↑↓←→` | Pomicanje po slici |
| `Tab` | Sljedeća oznaka |
| `Shift+Tab` | Prethodna oznaka |

---

## Sigurnosne napomene

- `GOOGLE_CLIENT_SECRET` nikad se ne izlaže frontendu
- Refresh tokeni su enkriptirani AES-256-GCM i pohranjeni u HttpOnly cookie
- Firebase Web SDK config je javno vidljiv (standardno za Firebase) – sigurnost osigurava Firestore Security Rules
- Za produkcijsko korištenje: ograničite Firestore pravila

---

## Struktura projekta

```
├── server.js           # Express server
├── routes/
│   ├── auth.js         # OAuth 2.0 rute
│   └── drive.js        # Drive API proxy
├── utils/
│   ├── encryption.js   # AES-256 za refresh tokene
│   ├── driveClient.js  # Drive klijent s auto-refresh
│   └── tiffConverter.js# TIFF → JPEG konverzija
├── public/
│   ├── index.html      # SPA entry point
│   ├── css/style.css   # Design system
│   └── js/
│       ├── app.js      # Glavni kontroler
│       ├── canvas.js   # Interaktivni canvas
│       ├── db.js       # LocalStorage + Firestore sync
│       ├── drive.js    # Drive API pozivi
│       ├── persons.js  # Upravljanje osobama
│       ├── tags.js     # Upravljanje oznakama
│       ├── export.js   # Uvoz/Izvoz
│       ├── keyboard.js # Tipkovnički prečaci
│       └── ui.js       # UI helpers
├── .env.example
└── package.json
```
