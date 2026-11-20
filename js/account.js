// Optional Google account: the favorites are kept online in Firestore (document users/{uid}), so
// they follow the user on every device and survive a cleared cache. Without an account nothing
// changes: favorites stay in this browser only. The Firebase SDK (from gstatic) is loaded only
// for users who have signed in on this device, or when they press "Sign in".
const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
// Public web configuration of the Firebase project (not a secret: access is guarded by the
// Firestore security rules, see firestore.rules).
const CONFIG = {
  apiKey: 'AIzaSyDJcaxs3SeQyZwhx2H90pFgEBSYZgB6msw',
  authDomain: 'rain-archive-app.firebaseapp.com',
  projectId: 'rain-archive-app',
  storageBucket: 'rain-archive-app.firebasestorage.app',
  messagingSenderId: '436128984591',
  appId: '1:436128984591:web:4a75f296a1a9f28587fd7a',
};
const FLAG = 'rain-archive-account'; // "1" once signed in on this device
const LINK_EMAIL = 'rain-archive-link-email'; // address a sign-in link was sent to

let fb = null;       // Promise of { au, fs, auth, db }
let user = null;
let unsub = null;    // stops listening to the online favorites
let listening = false;
let opts;            // { box, getFavorites, onRemote(list), same(a, b), toast(msg) }
let busy = false;

// Only the place fields are stored online (no undefined values: Firestore refuses them).
const clean = (list) => list.map(({ name, region, lat, lon, elevation, tz }) =>
  JSON.parse(JSON.stringify({ name, region, lat, lon, elevation, tz })));
const key = (list) => list.map((f) => `${f.name}|${f.lat}|${f.lon}`).join(';');

function sdk() {
  fb ||= Promise.all(['app', 'auth', 'firestore'].map((m) => import(`${FB}firebase-${m}.js`)))
    .then(([a, au, fs]) => {
      const app = a.initializeApp(CONFIG);
      return { au, fs, auth: au.getAuth(app), db: fs.getFirestore(app) };
    })
    .catch((e) => { fb = null; throw e; });
  return fb;
}

async function listen() {
  if (listening) return;
  const { au, auth } = await sdk();
  listening = true;
  au.onAuthStateChanged(auth, (u) => {
    user = u;
    try { if (u) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* ignore */ }
    render();
    if (u) startSync(); else stopSync();
  });
}

async function docRef() {
  const { fs, db } = await sdk();
  return fs.doc(db, 'users', user.uid);
}

// On sign-in: online favorites first, then those of this device that are not online yet.
async function startSync() {
  const { fs } = await sdk();
  const ref = await docRef();
  try {
    const snap = await fs.getDoc(ref);
    const remote = snap.exists() ? (snap.data().favorites || []) : null;
    const local = opts.getFavorites();
    const extra = local.filter((l) => !(remote || []).some((r) => opts.same(r, l)));
    const merged = [...(remote || []), ...extra];
    if (!remote || extra.length) await pushFavorites(merged);
    if (key(merged) !== key(clean(local))) opts.onRemote(merged);
  } catch (e) {
    opts.toast(`Favorites could not be synced (${e.code || e.message})`);
  }
  stopSync();
  // Changes made on another device arrive here.
  unsub = fs.onSnapshot(ref, (s) => {
    if (s.metadata.hasPendingWrites || !s.exists()) return;
    const list = s.data().favorites || [];
    if (key(list) !== key(clean(opts.getFavorites()))) opts.onRemote(list);
  }, () => { /* offline or signed out: ignore */ });
}

function stopSync() { unsub?.(); unsub = null; }

// Called by the app after every change of the favorites.
export const isSignedIn = () => !!user;

export async function pushFavorites(list) {
  if (!user) return;
  try {
    const { fs } = await sdk();
    await fs.setDoc(await docRef(), { favorites: clean(list), updated: fs.serverTimestamp() });
  } catch (e) {
    opts.toast(`Favorites could not be saved online (${e.code || e.message})`);
  }
}

async function signIn() {
  if (busy) return;
  busy = true;
  render();
  try {
    await listen();
    const { au, auth } = await sdk();
    await au.signInWithPopup(auth, new au.GoogleAuthProvider());
  } catch (e) {
    const code = e.code || '';
    if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
      opts.toast(code === 'auth/popup-blocked' ? 'Sign-in window blocked by the browser'
        : !navigator.onLine ? 'Sign-in needs a connection' : `Sign-in failed (${code || e.message})`);
    }
  }
  busy = false;
  render();
}

// E-mail and password accounts (Firebase checks the password; it is never stored by the app).
let emailOpen = false, email = '', pw = '';
const AUTH_MSG = {
  'auth/invalid-credential': 'Wrong e-mail or password',
  'auth/wrong-password': 'Wrong e-mail or password',
  'auth/user-not-found': 'Wrong e-mail or password',
  'auth/invalid-email': 'This e-mail address is not valid',
  'auth/missing-password': 'Enter a password',
  'auth/weak-password': 'The password needs at least 6 characters',
  'auth/email-already-in-use': 'An account already exists for this e-mail: sign in instead',
  'auth/too-many-requests': 'Too many attempts: try again in a few minutes',
  'auth/network-request-failed': 'No connection',
};

async function emailAction(kind) {
  if (busy) return;
  if (!email) { opts.toast('Enter your e-mail address'); return; }
  busy = true;
  render();
  try {
    await listen();
    const { au, auth } = await sdk();
    if (kind === 'link') {
      // Passwordless: Firebase e-mails a link back to this page; opening it signs in (see finishLink).
      await au.sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname, handleCodeInApp: true });
      try { localStorage.setItem(LINK_EMAIL, email); } catch { /* ignore */ }
      opts.toast(`Sign-in link sent to ${email}: open it on this device`);
    } else if (kind === 'reset') {
      await au.sendPasswordResetEmail(auth, email);
      opts.toast('If an account exists for this address, an e-mail to reset the password has been sent');
    } else if (kind === 'create') {
      if (pw !== pw2) { opts.toast('The two passwords are different'); throw null; }
      await au.createUserWithEmailAndPassword(auth, email, pw);
      emailOpen = false; pw = ''; pw2 = '';
      opts.toast(`Account created for ${email}. You are signed in: your favorites are now saved online.`);
    } else {
      await au.signInWithEmailAndPassword(auth, email, pw);
      emailOpen = false; pw = '';
      opts.toast(`Signed in as ${email}`);
    }
  } catch (e) {
    if (e) {
      let msg = AUTH_MSG[e.code] || `Failed (${e.code || e.message})`;
      if (kind === 'signin' && e.code === 'auth/invalid-credential') msg += '. New here? Choose "Create an account".';
      opts.toast(msg);
    }
  }
  busy = false;
  render();
}

// Two clearly separate modes: signing in to an existing account, or creating a new one.
let emailMode = 'signin', pw2 = '';
function emailForm() {
  const box = document.createElement('div');
  box.className = 'account-email';
  const create = emailMode === 'create';
  const head = document.createElement('div');
  head.className = 'account-head';
  const title = document.createElement('strong');
  title.textContent = create ? 'Create an account' : 'Sign in with e-mail';
  const close = btn('✕', 'btn mini link', () => { emailOpen = false; render(); }, 'Close');
  close.setAttribute('aria-label', 'Close');
  head.append(title, close);

  const form = document.createElement('form');
  form.className = 'account-form';
  const field = (type, value, placeholder, auto, set) => {
    const i = document.createElement('input');
    Object.assign(i, { type, value, placeholder, autocomplete: auto });
    i.oninput = () => set(type === 'password' ? i.value : i.value.trim());
    return i;
  };
  form.append(field('email', email, 'E-mail', 'username', (v) => { email = v; }),
    field('password', pw, create ? 'Choose a password (6+ characters)' : 'Password',
      create ? 'new-password' : 'current-password', (v) => { pw = v; }));
  if (create) form.append(field('password', pw2, 'Repeat the password', 'new-password', (v) => { pw2 = v; }));
  const go = btn(busy ? '…' : create ? 'Create account' : 'Sign in', 'btn small primary', null);
  go.type = 'submit';
  form.append(go);
  form.onsubmit = (e) => { e.preventDefault(); emailAction(create ? 'create' : 'signin'); };

  const links = document.createElement('div');
  links.className = 'account-links small';
  const swap = btn(create ? 'Already have an account? Sign in' : 'No account yet? Create one', 'btn mini link',
    () => { emailMode = create ? 'signin' : 'create'; render(); });
  links.append(swap);
  if (!create) {
    links.append(btn('Forgot password?', 'btn mini link', () => emailAction('reset')),
      btn('No password: e-mail me a sign-in link', 'btn mini link', () => emailAction('link')));
  }
  box.append(head, form, links);
  return box;
}

async function signOut() {
  const { au, auth } = await sdk();
  stopSync();
  await au.signOut(auth);
  opts.toast('Signed out. Your favorites stay on this device.');
}

async function deleteAccount() {
  if (!confirm('Delete your account and the favorites saved online?\nThe favorites on this device are kept.')) return;
  const { au, fs, auth } = await sdk();
  try {
    stopSync();
    await fs.deleteDoc(await docRef());
    try {
      await au.deleteUser(auth.currentUser);
    } catch (e) {
      if (e.code !== 'auth/requires-recent-login') throw e;
      if (!auth.currentUser.providerData.some((p) => p.providerId === 'google.com')) {
        opts.toast('For safety, sign out, sign in again, then delete the account');
        return;
      }
      // Google asks to confirm the identity once more before deleting an account.
      await au.reauthenticateWithPopup(auth.currentUser, new au.GoogleAuthProvider());
      await au.deleteUser(auth.currentUser);
    }
    opts.toast('Account deleted');
  } catch (e) {
    opts.toast(`The account could not be deleted (${e.code || e.message})`);
    if (user) startSync();
  }
}

function btn(text, cls, onclick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

function render() {
  const box = opts.box;
  box.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'account-line';
  if (user) {
    const who = document.createElement('span');
    who.className = 'small';
    who.textContent = `☁ Favorites synced · ${user.email || user.displayName || 'signed in'}`;
    line.append(who,
      btn('Sign out', 'btn mini', signOut),
      btn('Delete account', 'btn mini danger', deleteAccount, 'Delete the account and the favorites saved online'));
  } else {
    const txt = document.createElement('span');
    txt.className = 'small muted';
    txt.textContent = 'Keep your favorites on all your devices:';
    line.append(txt, btn(busy && !emailOpen ? 'Signing in…' : 'Sign in with Google', 'btn small', signIn));
    if (!emailOpen) line.append(btn('Sign in with e-mail', 'btn small', () => { emailOpen = true; emailMode = 'signin'; render(); }));
  }
  box.append(line);
  if (!user && emailOpen) box.append(emailForm());
  const note = document.createElement('div');
  note.className = 'small muted account-note';
  note.textContent = 'With an account, your e-mail address and favorites are stored by Google Firebase, '
    + 'only to sync them between your devices. "Delete account" erases them.';
  box.append(note);
}

export function initAccount(o) {
  opts = o;
  render();
  let known = false;
  try { known = localStorage.getItem(FLAG) === '1'; } catch { /* ignore */ }
  if (/[?&]mode=signIn\b/.test(location.search)) finishLink();
  else if (known) listen().catch(() => { /* offline: favorites of this device are used */ });
}

// The page was opened from a sign-in link e-mailed by Firebase.
async function finishLink() {
  try {
    await listen();
    const { au, auth } = await sdk();
    if (!au.isSignInWithEmailLink(auth, location.href)) return;
    let addr = null;
    try { addr = localStorage.getItem(LINK_EMAIL); } catch { /* ignore */ }
    // Link opened on another device or browser: Firebase needs the address again.
    addr ||= prompt('Confirm your e-mail address to sign in');
    if (!addr) return;
    await au.signInWithEmailLink(auth, addr.trim(), location.href);
    try { localStorage.removeItem(LINK_EMAIL); } catch { /* ignore */ }
    opts.toast('Signed in');
  } catch (e) {
    opts.toast(e.code === 'auth/invalid-action-code' || e.code === 'auth/expired-action-code'
      ? 'This sign-in link has expired or was already used' : (AUTH_MSG[e.code] || `Sign-in failed (${e.code || e.message})`));
  } finally {
    history.replaceState(null, '', location.pathname); // remove the link's code from the address
  }
}
