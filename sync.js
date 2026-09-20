// Capa de sincronización opcional con Firebase (Auth + Firestore).
//
// Diseño: la app funciona 100% offline con localStorage sin esto. Si hay config de Firebase
// válida y hay red, esta capa se suma como mejora: login por email/contraseña, sincronía de
// comidas/feedback entre tus dispositivos, y una base de alimentos COMPARTIDA de solo lectura
// para todos los usuarios logueados (solo el dueño de la cuenta puede escribir en ella — ver
// firestore.rules).
//
// Expone todo en window.BitacoraSync para que el script clásico de index.html lo use sin
// necesidad de convertirse él mismo en módulo.

const FIREBASE_SDK_VERSION = '10.13.2';

function isConfigured() {
  const cfg = window.FIREBASE_CONFIG;
  return !!(cfg && cfg.apiKey && cfg.apiKey !== 'REEMPLAZAR');
}

const state = {
  ready: false,
  user: null,
  authListeners: [],
};

let app, auth, db;
let firestoreApi, authApi;

async function init() {
  if (!isConfigured()) {
    console.info('[sync] Sin config de Firebase: la app queda en modo local.');
    return;
  }
  try {
    const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
    ]);
    authApi = authMod;
    firestoreApi = firestoreMod;

    app = initializeApp(window.FIREBASE_CONFIG);
    auth = authApi.getAuth(app);
    db = firestoreApi.initializeFirestore(app, {
      localCache: firestoreApi.persistentLocalCache({
        tabManager: firestoreApi.persistentMultipleTabManager(),
      }),
    });

    authApi.onAuthStateChanged(auth, (user) => {
      state.user = user;
      if (user) {
        watchUserCollection('meals', 'bitacora:meals:', (data) => JSON.stringify(data.list || []), window.refreshComidasPage);
        watchUserCollection('feedback', 'bitacora:feedback:', (data) => data.text || '', window.refreshComidasPage);
        watchUserCollection('routine', 'bitacora:routine:', (data) => JSON.stringify(data.exercises || []), window.refreshRoutinePage);
        watchUserDoc('profile', 'data', 'bitacora:profile', (data) => JSON.stringify(data || {}), window.refreshProfileUI);
        watchUserDoc('routineAnalysis', 'data', 'bitacora:routineAnalysis', (data) => JSON.stringify(data || {}), window.refreshRoutineAnalysis);
        watchUserDoc('rpg', 'stats', 'bitacora:rpg', (data) => JSON.stringify(data || {}), window.refreshHome);
        watchUserDoc('rpg', 'missions', 'bitacora:missions', (data) => JSON.stringify(data || {}), window.refreshHome);
      }
      state.authListeners.forEach((cb) => cb(user));
    });

    state.ready = true;
  } catch (err) {
    console.warn('[sync] No se pudo inicializar Firebase (¿sin conexión?)', err);
  }
}
const readyPromise = init();

function onAuthChange(cb) {
  state.authListeners.push(cb);
  if (state.ready) cb(state.user);
}

async function signUp(email, password) {
  await readyPromise;
  if (!auth) throw new Error('Firebase no está configurado.');
  await authApi.createUserWithEmailAndPassword(auth, email, password);
}

async function signIn(email, password) {
  await readyPromise;
  if (!auth) throw new Error('Firebase no está configurado.');
  await authApi.signInWithEmailAndPassword(auth, email, password);
}

async function logOut() {
  await readyPromise;
  if (!auth) return;
  await authApi.signOut(auth);
}

// --- Sync privado por usuario (users/{uid}/...): comidas, feedback, rutina, perfil ---
// Nada de esto se comparte entre cuentas — cada uid tiene sus propios documentos, a
// diferencia de foodKnowledge (que sí es compartida a propósito, ver firestore.rules).

function watchUserCollection(subcollection, localPrefix, valueFn, refreshFn) {
  const uid = state.user.uid;
  const colRef = firestoreApi.collection(db, 'users', uid, subcollection);
  firestoreApi.onSnapshot(colRef, (snap) => {
    snap.docChanges().forEach((change) => {
      const key = localPrefix + change.doc.id;
      if (change.type === 'removed') {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, valueFn(change.doc.data()));
      }
    });
    if (typeof refreshFn === 'function') refreshFn();
  }, (err) => console.warn('[sync] onSnapshot', subcollection, err));
}

function watchUserDoc(subcollection, docId, localKey, valueFn, refreshFn) {
  const uid = state.user.uid;
  const ref = firestoreApi.doc(db, 'users', uid, subcollection, docId);
  firestoreApi.onSnapshot(ref, (snap) => {
    if (snap.exists()) {
      localStorage.setItem(localKey, valueFn(snap.data()));
      if (typeof refreshFn === 'function') refreshFn();
    }
  }, (err) => console.warn('[sync] onSnapshot', subcollection, err));
}

async function pushMeals(dateKey, list) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'meals', dateKey);
    await firestoreApi.setDoc(ref, { list, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushMeals', err);
  }
}

async function pushFeedback(dateKey, text) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'feedback', dateKey);
    await firestoreApi.setDoc(ref, { text, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushFeedback', err);
  }
}

async function pushRoutine(day, exercises) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'routine', day);
    await firestoreApi.setDoc(ref, { exercises, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRoutine', err);
  }
}

async function pushProfile(profile) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'profile', 'data');
    await firestoreApi.setDoc(ref, { ...profile, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushProfile', err);
  }
}

async function pushRoutineAnalysis(analysis) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'routineAnalysis', 'data');
    await firestoreApi.setDoc(ref, { ...analysis, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRoutineAnalysis', err);
  }
}

async function pushRpgStats(stats) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'rpg', 'stats');
    await firestoreApi.setDoc(ref, { ...stats, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRpgStats', err);
  }
}

async function pushMissions(missions) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'rpg', 'missions');
    await firestoreApi.setDoc(ref, { ...missions, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushMissions', err);
  }
}

// --- Base de alimentos compartida (foodKnowledge) + cola de pendientes ---

async function lookupFoodKnowledge(slug) {
  const localKey = 'bitacora:foodinfo:' + slug;
  const cached = localStorage.getItem(localKey);
  if (cached) return cached;
  if (!state.user || !db) return null;
  try {
    const ref = firestoreApi.doc(db, 'foodKnowledge', slug);
    const snap = await firestoreApi.getDoc(ref);
    if (snap.exists()) {
      const info = snap.data().info || '';
      if (info) localStorage.setItem(localKey, info);
      return info || null;
    }
  } catch (err) {
    console.warn('[sync] lookupFoodKnowledge', err);
  }
  return null;
}

async function saveFoodKnowledge(slug, text, info) {
  localStorage.setItem('bitacora:foodinfo:' + slug, info);
  if (!state.user || !db) return;
  try {
    const ref = firestoreApi.doc(db, 'foodKnowledge', slug);
    await firestoreApi.setDoc(ref, {
      food: text,
      info,
      addedBy: state.user.uid,
      updatedAt: firestoreApi.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[sync] saveFoodKnowledge (¿no sos el dueño de la cuenta que llena la base?)', err);
  }
}

async function queueFoodQuery(slug, text) {
  if (!state.user || !db) return;
  try {
    const ref = firestoreApi.doc(db, 'pendingFoodQueries', slug);
    const snap = await firestoreApi.getDoc(ref);
    if (!snap.exists()) {
      await firestoreApi.setDoc(ref, {
        text,
        requestedBy: state.user.uid,
        createdAt: firestoreApi.serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn('[sync] queueFoodQuery', err);
  }
}

async function clearPendingFoodQuery(slug) {
  if (!state.user || !db) return;
  try {
    await firestoreApi.deleteDoc(firestoreApi.doc(db, 'pendingFoodQueries', slug));
  } catch (err) {
    console.warn('[sync] clearPendingFoodQuery (¿no sos el dueño?)', err);
  }
}

async function fetchAllPendingFoodQueries() {
  if (!state.user || !db) return [];
  try {
    const snap = await firestoreApi.getDocs(firestoreApi.collection(db, 'pendingFoodQueries'));
    return snap.docs.map((d) => ({ slug: d.id, text: d.data().text }));
  } catch (err) {
    console.warn('[sync] fetchAllPendingFoodQueries', err);
    return [];
  }
}

window.BitacoraSync = {
  isConfigured,
  onAuthChange,
  signUp,
  signIn,
  logOut,
  pushMeals,
  pushFeedback,
  pushRoutine,
  pushProfile,
  pushRoutineAnalysis,
  pushRpgStats,
  pushMissions,
  lookupFoodKnowledge,
  saveFoodKnowledge,
  queueFoodQuery,
  clearPendingFoodQuery,
  fetchAllPendingFoodQueries,
  get currentUser() { return state.user; },
};
window.dispatchEvent(new CustomEvent('bitacora-sync-ready'));
